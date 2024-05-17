#!/usr/bin/env node
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
          await updateTaskStatusInDynamoDB(ctx, job.id, body, "RUNNING", true);
          console.log(`::group::${title}`);
          const durationTracker = createDurationTracker();
          try {
            await execa(command[0], command.slice(1), { stdio: "inherit" });
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
            console.log(
              `::error title=${body.displayName} (${body.id}) failed::${error}`
            );
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
