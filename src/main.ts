#!/usr/bin/env node
import * as s3 from "@aws-sdk/client-s3";
import * as sqs from "@aws-sdk/client-sqs";
import { execa } from "execa";
import fs from "fs";
import { chunk } from "lodash-es";
import pMap from "p-map";
import process from "process";
import yargs from "yargs";
import { Context, createContext } from "./createContext";
import { createDurationTracker } from "./createDurationTracker";
import {
  checkTaskCompletionStatus,
  ensureDynamodbTableCreated,
  getPreviouslyRunTaskStatuses,
  updateTaskStatusInDynamoDB,
} from "./db";
import { env } from "./env";
import { ensureQueueCreated, updateMessageVisibilityTimeout } from "./queue";
import { Task, TaskListFile } from "./schema";

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
      console.log("Job ID:", job.id);
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

      if (env.PARALLELIZER_S3_BUCKET) {
        const key = `${env.PARALLELIZER_S3_KEY_PREFIX}${job.id}.json`;
        await ctx.s3Client.send(
          new s3.PutObjectCommand({
            Bucket: env.PARALLELIZER_S3_BUCKET,
            Key: key,
            Body: jobFileContents,
          })
        );
        const s3Url = `s3://${env.PARALLELIZER_S3_BUCKET}/${key}`;
        console.log("Job file saved to S3:", s3Url);
      }

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
      console.log("Job ID:", job.id);

      const sqsClient = new sqs.SQSClient({});
      const queueUrlResponse = await sqsClient.send(
        new sqs.GetQueueUrlCommand({
          QueueName: env.PARALLELIZER_SQS_PREFIX + job.id,
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
        let errorMessage = "";
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
          await updateTaskStatusInDynamoDB(ctx, job.id, body, "RUNNING", true);
          console.log(`::group::${title}`);
          const durationTracker = createDurationTracker();
          try {
            await execa(command[0], command.slice(1), {
              stdio: "inherit",
              env: {
                PARALLELIZER_TASK_ID: body.id,
                PARALLELIZER_JOB_ID: job.id,
              },
            });
            await updateTaskStatusInDynamoDB(
              ctx,
              job.id,
              body,
              "COMPLETED",
              false
            );
            const duration = durationTracker.formatDuration();
            console.log(`Task ${body.id} completed in ${duration}s`);
            passed++;
          } catch (error) {
            const duration = durationTracker.formatDuration();
            console.log(`Task ${body.id} failed in ${duration}s`);
            errorMessage = `::error title=${body.displayName} (${body.id}) failed::${error}`;
            console.error("Error running command:", error);
            process.exitCode = 1;
            failed++;
            await updateTaskStatusInDynamoDB(
              ctx,
              job.id,
              body,
              "FAILED",
              false
            );
          } finally {
            console.log(`::endgroup::`);
            if (errorMessage) {
              console.log(errorMessage);
            }
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
  .command(
    "status",
    "Check the status of the tasks",
    {
      "job-file": {
        type: "string",
        demandOption: true,
        description: "Path to the job file",
      },
      "out-file": {
        type: "string",
        description: "Path to the output JSON file.",
      },
    },
    async (args) => {
      const jobFile = args["job-file"];
      console.log("Reading job file:", jobFile);
      const jobFileContents = fs.readFileSync(jobFile, "utf-8");
      const job = TaskListFile.parse(JSON.parse(jobFileContents));
      console.log("Job ID:", job.id);
      console.log("Number of tasks:", job.tasks.length);
      const ctx: Context = createContext();
      const statuses = await getPreviouslyRunTaskStatuses(ctx, job.id);
      type Status = {
        taskId: string;
        workerId: string;
        attemptCount: number;
        startedAt: string;
        finishedAt?: string;
        status: string;
      };
      const statusMap = new Map<string, Status>();
      for (const item of statuses.Items ?? []) {
        statusMap.set(item.TaskId.S!, {
          taskId: item.TaskId.S!,
          workerId: item.WorkerId.S!,
          attemptCount: +(item.AttemptCount?.N || "0"),
          startedAt: item.StartedAt?.S || "",
          finishedAt: item.FinishedAt?.S,
          status: item.Status.S!,
        });
      }
      const result = job.tasks.map((task) => {
        return {
          id: task.id,
          displayName: task.displayName,
          status: statusMap.get(task.id),
        };
      });
      const formatDuration = (status: Status) => {
        if (!status.startedAt || !status.finishedAt) return "";
        const startedAt = new Date(status.startedAt).getTime();
        const finishedAt = new Date(status.finishedAt).getTime();
        return ((finishedAt - startedAt) / 1000).toFixed(2) + "s";
      };
      console.table(
        result.map((r) => ({
          id: r.id,
          status: r.status?.status,
          workerId: r.status?.workerId,
          duration: r.status ? formatDuration(r.status) : "",
        }))
      );
      const out = JSON.stringify(result, null, 2);
      if (args["out-file"]) {
        fs.writeFileSync(args["out-file"], out);
      }
    }
  )
  .parse();
