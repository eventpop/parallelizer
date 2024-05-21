import * as dynamodb from "@aws-sdk/client-dynamodb";
import * as s3 from "@aws-sdk/client-s3";
import * as sqs from "@aws-sdk/client-sqs";

interface Context {
  sqsClient: sqs.SQSClient;
  dynamodbClient: dynamodb.DynamoDBClient;
  s3Client: s3.S3Client;
}

function createContext(): Context {
  return {
    dynamodbClient: new dynamodb.DynamoDBClient({}),
    sqsClient: new sqs.SQSClient({}),
    s3Client: new s3.S3Client({}),
  };
}

export { Context, createContext };
