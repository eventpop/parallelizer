import * as dynamodb from "@aws-sdk/client-dynamodb";
import * as sqs from "@aws-sdk/client-sqs";
import os from "os";

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

export { Context, createContext };
