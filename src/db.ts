import * as dynamodb from "@aws-sdk/client-dynamodb";
import { z } from "zod";
import { Context } from "./createContext";
import { env } from "./env";
import { Task } from "./schema";

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
  task: z.infer<typeof Task>,
  status: string,
  isStart: boolean
) {
  const workerId = env.PARALLELIZER_WORKER_ID;
  const timestamp = new Date().toISOString();
  let updateExpression =
    "set #status = :status, #taskDisplayName = :taskDisplayName, #timestamp = :timestamp, #workerId = :workerId";
  let expressionAttributeNames: Record<string, string> = {
    "#status": "Status",
    "#taskDisplayName": "TaskDisplayName",
    "#timestamp": isStart ? "StartedAt" : "FinishedAt",
    "#workerId": "WorkerId",
  };
  let expressionAttributeValues: Record<string, dynamodb.AttributeValue> = {
    ":status": { S: status },
    ":taskDisplayName": { S: task.displayName },
    ":timestamp": { S: timestamp },
    ":workerId": { S: workerId },
  };

  if (isStart) {
    updateExpression +=
      ", #attemptCount = if_not_exists(#attemptCount, :zero) + :inc";
    expressionAttributeNames["#attemptCount"] = "AttemptCount";
    expressionAttributeValues[":zero"] = { N: "0" };
    expressionAttributeValues[":inc"] = { N: "1" };
  }

  await dynamodbClient.send(
    new dynamodb.UpdateItemCommand({
      TableName: env.PARALLELIZER_DYNAMODB_TABLE,
      Key: {
        TaskListId: { S: jobId },
        TaskId: { S: task.id },
      },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );
}

export {
  checkTaskCompletionStatus,
  ensureDynamodbTableCreated,
  getPreviouslyRunTaskStatuses,
  updateTaskStatusInDynamoDB,
};
