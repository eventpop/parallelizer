import { Env } from "@(-.-)/env";
import * as dynamodb from "@aws-sdk/client-dynamodb";
import * as sqs from "@aws-sdk/client-sqs";
import fs from "fs";
import { chunk } from "lodash-es";
import pMap from "p-map";
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
        "Differenct CI workflow runs should have different queue names. " +
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

      const ctx: Context = {
        dynamodbClient: new dynamodb.DynamoDBClient({}),
        sqsClient: new sqs.SQSClient({}),
      };

      await ensureDynamodbTableCreated(ctx);

      const queueUrl = await ensureQueueCreated(ctx, job.id);
      const statuses = await getPreviouslyRunTaskStatuses(ctx, job.id);
      const chunks = chunk(job.tasks, 10);
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
      const queueUrl = queueUrlResponse.QueueUrl;

      while (true) {
        const receiveMessageResponse = await sqsClient.send(
          new sqs.ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
          })
        );
        if (receiveMessageResponse.Messages?.length) {
          const message = receiveMessageResponse.Messages[0];
          const body = Task.parse(JSON.parse(message.Body!));
          const command = [...args.worker, body.id];
          console.log("Command to run:", ...command);
          await sqsClient.send(
            new sqs.DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle!,
            })
          );
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
    }
  )
  .parse();

interface Context {
  sqsClient: sqs.SQSClient;
  dynamodbClient: dynamodb.DynamoDBClient;
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
