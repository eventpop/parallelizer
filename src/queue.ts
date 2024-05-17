import * as sqs from "@aws-sdk/client-sqs";

async function ensureQueueCreated({ sqsClient }: { sqsClient: sqs.SQSClient }, queueId: string) {
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

export { ensureQueueCreated, updateMessageVisibilityTimeout };
