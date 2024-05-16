#!/usr/bin/env node
import { Env } from "@(-.-)/env";
import * as dynamodb from "@aws-sdk/client-dynamodb";
import * as sqs from "@aws-sdk/client-sqs";
import { execa } from "execa";
import fs from "fs";
import { chunk } from "lodash-es";
import os from "os";
import pMap from "p-map";
import process from "process";
import yargs from "yargs";
import { z } from "zod";

const env = Env(
  z.object({
    PARALLELIZER_DYNAMODB_TABLE: z.string().default("parallelizer"),
  })
);

const Task = z.object({
  id: z.string(),
  displayName: z.string(),
  spec: z.record(z.unknown()).default({}),
});

const TaskListFile = z.object({
  id: z
    .string()
    .describe(
      "Unique ID of the task list. " +
        "Different CI workflow runs should have different queue names. " +
        "This ID can be reused when retrying a failed workflow run " +
        "(previously-complete tasks will be skipped)."
    ),
  displayName: z.string().default(""),
  tasks: z
    .array(Task)
    .describe(
      "An array of tasks that needs to be run. " +
        "The tasks will be queued in the order they are listed in this array, " +
        "however, they may be run in parallel and out of order."
    ),
});

yargs(process.argv.slice(2))
  .demandCommand()
  .strict()
  .help()
  .command(
    "prepare",
    "Enqueue jobs into the queue",
    {
      "job-file": {
        type: "string",
        demandOption: true,
        description: "Path to the job file",
      },
    },
    async (args) => {
      const jobFile = args["job-file"];
      console.log("Reading job file:", jobFile);
      const jobFileContents = fs.readFileSync(jobFile, "utf-8");
      const job = TaskListFile.parse(JSON.parse(jobFileContents));
      console.log("Queue name:", job.id);
      console.log("Number of tasks:", job.tasks.length);
      const ctx: Context = createContext();

      await ensureDynamodbTableCreated(ctx);

      const queueUrl = await ensureQueueCreated(ctx, job.id);
      const statuses = await getPreviouslyRunTaskStatuses(ctx, job.id);

      const statusItems = statuses.Items ?? [];
      console.log("Number of tasks previously run:", statusItems.length);

      const completedTaskIds = new Set(
        statusItems
          .filter((item) => item.Status.S === "COMPLETED")
          .map((item) => item.TaskId.S)
      );
      console.log("Number of tasks already completed:", completedTaskIds.size);

      const tasksToEnqueue = job.tasks.filter(
        (task) => !completedTaskIds.has(task.id)
      );
      console.log("Number of tasks to enqueue:", tasksToEnqueue.length);

      const chunks = chunk(tasksToEnqueue, 10);
      await pMap(
        chunks,
        async (chunk, index) => {
          try {
            const entries = chunk.map((task) => ({
              Id: task.id,
              MessageBody: JSON.stringify(task),
            }));
            await ctx.sqsClient.send(
              new sqs.SendMessageBatchCommand({
                QueueUrl: queueUrl,
                Entries: entries,
              })
            );
            console.log(`Enqueued chunk ${index + 1} of ${chunks.length}`);
          } catch (error) {
            console.error(
              `Error enqueuing chunk ${index + 1} of ${chunks.length}`
            );
            throw error;
          }
        },
        { concurrency: 2 }
      );
    }
  )
  .command(
    "work <worker..>",
    "Work on jobs in the queue",
    {
      "job-file": {
        type: "string",
        demandOption: true,
        description: "Path to the job file",
      },
      worker: {
        type: "string",
        demandOption: true,
        description: "The worker command and its arguments",
      },
    },
    async (args) => {
      const ctx: Context = createContext();
      const jobFile = args["job-file"];
      console.log("Reading job file:", jobFile);
      const jobFileContents = fs.readFileSync(jobFile, "utf-8");
      const job = TaskListFile.parse(JSON.parse(jobFileContents));
      console.log("Queue name:", job.id);

      const sqsClient = new sqs.SQSClient({});
      const queueUrlResponse = await sqsClient.send(
        new sqs.GetQueueUrlCommand({
          QueueName: job.id,
        })
      );
      const queueUrl = queueUrlResponse.QueueUrl!;
      let nextNumber = 1;
      let passed = 0;
      let failed = 0;
      const totalDurationTracker = createDurationTracker();

      while (true) {
        const receiveMessageResponse = await sqsClient.send(
          new sqs.ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            VisibilityTimeout: 30,
          })
        );
        if (receiveMessageResponse.Messages?.length) {
          const message = receiveMessageResponse.Messages[0];
          const body = Task.parse(JSON.parse(message.Body!));
          const taskCompletionStatus = await checkTaskCompletionStatus(
            ctx,
            job.id,
            body.id
          );
          const title = `${nextNumber++}. ${body.displayName} (${body.id})`;
          if (taskCompletionStatus === "COMPLETED") {
            console.log(`${title} - already completed, skipping.`);
            continue;
          }
          const command = [...args.worker, body.id];
          let visibilityTimeoutHandle = setInterval(async () => {
            try {
              await updateMessageVisibilityTimeout(
                sqsClient,
                queueUrl,
                message.ReceiptHandle!,
                30
              );
            } catch (error) {
              console.error(
                "Error updating message visibility timeout:",
                error
              );
            }
          }, 15000);
          await updateTaskStatusInDynamoDB(
            ctx,
            job.id,
            body.id,
            "RUNNING",
            true
          );
          console.log(`::group::${title}`);
          const durationTracker = createDurationTracker();
          try {
            await execa(command[0], command.slice(1), { stdio: "inherit" });
            await updateTaskStatusInDynamoDB(
              ctx,
              job.id,
              body.id,
              "COMPLETED",
              false
            );
            const duration = durationTracker.formatDuration();
            console.log(`Task ${body.id} completed in ${duration}s`);
            passed++;
          } catch (error) {
            const duration = durationTracker.formatDuration();
            console.log(`Task ${body.id} failed in ${duration}s`);
            console.log(
              `::error title=${body.displayName} (${body.id}) failed::${error}`
            );
            console.error("Error running command:", error);
            process.exitCode = 1;
            failed++;
            await updateTaskStatusInDynamoDB(
              ctx,
              job.id,
              body.id,
              "FAILED",
              false
            );
          } finally {
            console.log(`::endgroup::`);
            clearInterval(visibilityTimeoutHandle);
            await sqsClient.send(
              new sqs.DeleteMessageCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: message.ReceiptHandle!,
              })
            );
          }
        } else {
          console.log("Did not receive any message");

          // Get the number of messages in the queue
          const queueAttributesResponse = await sqsClient.send(
            new sqs.GetQueueAttributesCommand({
              QueueUrl: queueUrl,
              AttributeNames: ["ApproximateNumberOfMessages"],
            })
          );
          const numberOfMessages =
            queueAttributesResponse.Attributes?.ApproximateNumberOfMessages;
          console.log("Number of messages in queue:", numberOfMessages);

          if (!+(numberOfMessages || "")) {
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      const totalDuration = totalDurationTracker.formatDuration();
      console.log();
      console.log("--- Summary ---");
      console.log("Total tasks processed:", passed + failed);
      console.log("Total duration:", totalDuration + "s");
      console.log("Number of tasks passed:", passed);
      console.log("Number of tasks failed:", failed);
    }
  )
  .parse();

interface Context {
  sqsClient: sqs.SQSClient;
  dynamodbClient: dynamodb.DynamoDBClient;
}

function createContext(): Context {
  return {
    dynamodbClient: new dynamodb.DynamoDBClient({}),
    sqsClient: new sqs.SQSClient({}),
  };
}

function createDurationTracker() {
  const start = Date.now();
  return {
    formatDuration: () => {
      const end = Date.now();
      return ((end - start) / 1000).toFixed(2);
    },
  };
}

async function ensureDynamodbTableCreated({ dynamodbClient }: Context) {
  try {
    await dynamodbClient.send(
      new dynamodb.CreateTableCommand({
        TableName: env.PARALLELIZER_DYNAMODB_TABLE,
        KeySchema: [
          {
            AttributeName: "TaskListId",
            KeyType: "HASH",
          },
          {
            AttributeName: "TaskId",
            KeyType: "RANGE",
          },
        ],
        AttributeDefinitions: [
          {
            AttributeName: "TaskListId",
            AttributeType: "S",
          },
          {
            AttributeName: "TaskId",
            AttributeType: "S",
          },
        ],
        BillingMode: "PAY_PER_REQUEST",
      })
    );
  } catch (error) {
    if (
      error instanceof dynamodb.ResourceInUseException ||
      error instanceof dynamodb.TableAlreadyExistsException
    ) {
      return;
    }
    throw error;
  }
}

async function ensureQueueCreated({ sqsClient }: Context, queueId: string) {
  const createQueueResponse = await sqsClient.send(
    new sqs.CreateQueueCommand({
      QueueName: queueId,
      tags: {
        "ci-parallelizer": "true",
      },
    })
  );
  const queueUrl = createQueueResponse.QueueUrl;
  return queueUrl;
}

async function getPreviouslyRunTaskStatuses(
  { dynamodbClient }: Context,
  jobId: string
) {
  const response = await dynamodbClient.send(
    new dynamodb.QueryCommand({
      TableName: env.PARALLELIZER_DYNAMODB_TABLE,
      KeyConditionExpression: "TaskListId = :taskListId",
      ExpressionAttributeValues: {
        ":taskListId": { S: jobId },
      },
    })
  );
  return response;
}

async function checkTaskCompletionStatus(
  { dynamodbClient }: Context,
  jobId: string,
  taskId: string
): Promise<string> {
  const response = await dynamodbClient.send(
    new dynamodb.GetItemCommand({
      TableName: env.PARALLELIZER_DYNAMODB_TABLE,
      Key: {
        TaskListId: { S: jobId },
        TaskId: { S: taskId },
      },
    })
  );
  return response.Item?.Status?.S || "PENDING";
}

async function updateTaskStatusInDynamoDB(
  { dynamodbClient }: Context,
  jobId: string,
  taskId: string,
  status: string,
  isStart: boolean
) {
  const workerId = process.env.PARALLELIZER_WORKER_ID || os.hostname();
  const timestamp = new Date().toISOString();
  const updateExpression =
    "set #status = :status, #timestamp = :timestamp, #workerId = :workerId";
  await dynamodbClient.send(
    new dynamodb.UpdateItemCommand({
      TableName: env.PARALLELIZER_DYNAMODB_TABLE,
      Key: {
        TaskListId: { S: jobId },
        TaskId: { S: taskId },
      },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: {
        "#status": "Status",
        "#timestamp": isStart ? "StartedAt" : "FinishedAt",
        "#workerId": "WorkerId",
      },
      ExpressionAttributeValues: {
        ":status": { S: status },
        ":timestamp": { S: timestamp },
        ":workerId": { S: workerId },
      },
    })
  );
}

async function updateMessageVisibilityTimeout(
  sqsClient: sqs.SQSClient,
  queueUrl: string,
  receiptHandle: string,
  visibilityTimeout: number
) {
  await sqsClient.send(
    new sqs.ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: visibilityTimeout,
    })
  );
}
