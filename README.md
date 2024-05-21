# parallelizer

A tool that parallelizes testing tasks across multiple worker nodes.

## Background

At Eventpop, we have many automated tests which are implemented using different tools, such as Cucumber and RSpec. Running them sequentially can take hours.

![before](https://github.com/eventpop/parallelizer/assets/193136/28456209-ca4b-4d38-bea4-5837da1f20f2)

To speed up the process, they have to be run in parallel.

A simple solution is to separate the tests into smaller groups and run them in parallel (**test sharding**).

![shard1](https://github.com/eventpop/parallelizer/assets/193136/88598a5a-af23-45c8-a68e-bf29fbb8bdf8)

However, splitting the tests into shards of equal number of test files can lead to imbalance in the execution time of each shard, because the time it takes to run each test file can vary wildly. In our case, some of our test files finish in less than a second, while a few takes about 1 minute. This can lead to some shards finishing their work early and being idle while others are still working.

Some services and libraries, such as [CircleCI](https://circleci.com/docs/parallelism-faster-jobs/) or [Knapsack](https://github.com/KnapsackPro/knapsack) provides **automatic test splitting.** They analyze the execution time of each test file and tries to distribute them evenly across workers.

![shard2](https://github.com/eventpop/parallelizer/assets/193136/b998fd28-f73d-40f5-b5d6-24cdb0793745)

There are a few drawbacks with this approach. First, they are not test framework agnostic (so RSpec and Cucumber tests have to be split separately). Second, sometimes a test file can fail, and due to retries, this could cause the execution time of a test file to be doubled or tripled. This can lead to that particular shard taking much longer to finish than the others.

![shard3](https://github.com/eventpop/parallelizer/assets/193136/f1724006-1d28-4c55-8eec-219033b39845)

Solving this problem requires using a **task queue** to dynamically assign tasks to workers nodes. This is the approach taken by this project.

![shard4](https://github.com/eventpop/parallelizer/assets/193136/9254327c-6333-435f-8b4d-d5355267c605)

The task queue is implemented with Amazon SQS and Amazon DynamoDB, so the entire infrastructure is serverless, i.e., no need to pay for idle DB instances/message broker/servers/containers or a fixed subscription fee. This tool is not tied to any specific test framework, so a single queue can be used to parallelize tests across different test frameworks.

To improve the efficiency, tests that would take longer to run should be enqueued first, while tests that are short should be enqueued last (**task ordering**), to further even out the execution time of each worker.

![shard5](https://github.com/eventpop/parallelizer/assets/193136/13775f95-04c0-4e90-bf48-826cdf50bbc1)

Additionally, **test grouping** can be done by running multiple test files in a single task, in order to reduce the overhead of starting a new process for each test file.

![shard6](https://github.com/eventpop/parallelizer/assets/193136/3ac4ed3a-810a-4f87-a0a7-62d200ddda8e)

> [!NOTE]
> Parallelizer provides a tool for implementing a **task queue** using SQS and DynamoDB. It is up to the consumer to implement **task ordering** and **test grouping** by themselves.

## Basic concepts

A **Parallelizer Job** is a collection of _Parallelizer Tasks._ Each parallelizer job has a unique ID, which will be used as the queue ID in SQS. This ID can be reused when retrying a job. This allows completed tasks to be skipped and only the failed tasks to be retried.

A **Parallelizer Task** represents a testing task. Usually, it is a test file that needs to be run. It can also be a group of test files that are run together. Each task has a unique ID, which is used to identify the task in the queue.

## Walkthrough

Before starting, run `pnpm install` to install dependencies and `pnpm run build` to compile the project.

### Step 0: Set up AWS permissions

Make sure your AWS account/role has the following permissions:

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Sid": "VisualEditor0",
			"Effect": "Allow",
			"Action": [
				"sqs:DeleteMessage",
				"sqs:GetQueueUrl",
				"sqs:ChangeMessageVisibility",
				"sqs:UntagQueue",
				"sqs:ReceiveMessage",
				"sqs:SendMessage",
				"sqs:GetQueueAttributes",
				"dynamodb:Query",
				"dynamodb:UpdateItem",
				"dynamodb:CreateTable",
				"sqs:TagQueue",
				"dynamodb:GetItem",
				"sqs:CreateQueue",
				"dynamodb:UpdateTable"
			],
			"Resource": [
				"arn:aws:sqs:ap-southeast-1:376829893840:*",
				"arn:aws:dynamodb:ap-southeast-1:376829893840:table/parallelizer/index/*",
				"arn:aws:dynamodb:ap-southeast-1:376829893840:table/parallelizer"
			]
		}
	]
}
```

### Step 1: Create a Parallelizer Job file

A Parallelizer Job file is a JSON file that contains the list of tasks to be run. The JSON file should have the following properties:

- `id`: The ID of the job. It can contain alphanumeric characters, dashes, and underscores.
- `tasks`: An array of tasks. Each task should have the following properties:
  - `id`: The ID of the task. It can contain alphanumeric characters, dashes, and underscores.
  - `displayName`: The display name of the task. This is used for logging purposes.
  - `spec`: An object that contains the task specification. This can be anything that is needed to run the task, such as the path to the test file (or test files), the testing framework to use, etc.

To generate a sample job file, run the following command:

```sh
node scripts/generate-job.mjs
```

…then look at the `tmp/job.json` file.

### Step 2: Load the job into the queue

Run the following command to load the job into the queue:

```sh
node dist/main.js prepare --job-file=tmp/job.json
```

### Step 3: Work on the queue

Run the following command to start working on the queue:

```sh
node dist/main.js work --job-file=tmp/job.json node scripts/work.mjs
```

You can run the above command in multiple terminals to simulate multiple workers.

The `work` command consumes tasks from the queue, and runs the worker command specified in the argument with the task ID appended. For example, the above command would run `node scripts/work.mjs <task-id>`. The worker should return a status code of `0` if the task is successful, or a non-zero status code if the task failed.

Note that Parallelizer doesn’t handle retries, so the worker should handle retries as needed.

Additionally, the following environment variables are available to the worker:

- `PARALLELIZER_JOB_ID`: The ID of the job.
- `PARALLELIZER_TASK_ID`: The ID of the task (same as the task ID passed to the worker command).

### Step 4: Check the task status

Run the following command to check the status of the tasks:

```sh
node dist/main.js status --job-file=tmp/job.json --out-file=tmp/status.json
```

A summary table will be printed to the console, and the detailed status of each task will be written to the `tmp/status.json` file.

## Environment Variables

The following table lists the environment variables used by Parallelizer:

| Variable | Default Value | Description |
|----------|---------------|-------------|
| `PARALLELIZER_DYNAMODB_TABLE` | `parallelizer` | The DynamoDB table name used for storing task statuses. |
| `PARALLELIZER_SQS_PREFIX` | `parallelizer_` | The prefix for SQS queue names. |
| `PARALLELIZER_S3_BUCKET` | *(none)* | Provide this environment variable to upload the job file to a S3 bucket when running the `prepare` command. This is provided for convenience for integrating with other tools, but otherwise does not affect the behavior of Parallelizer. (If not set, the job file will not be uploaded to S3.) |
| `PARALLELIZER_S3_KEY_PREFIX` | *(empty)* | The prefix for S3 keys when storing job files to S3. Only applicable when `PARALLELIZER_S3_BUCKET` is set. |
| `PARALLELIZER_WORKER_ID` | *(hostname)* | The identifier for the worker node, to help with debugging. The worker ID will be shown in `status` command. Defaults to the hostname of the machine. |

## Development

To set up the project, ensure you have `pnpm` installed on your system. Clone the repository and run `pnpm install` to install dependencies. Use the following commands to interact with the project:

- `pnpm run build`: Compiles the project.
- `pnpm run dev`: Runs the project in development mode with hot reloading.

## Testing procedure

```sh
# Generate a job file
node scripts/generate-job.mjs

# Enqueue jobs into the queue
node dist/main.js prepare --job-file=tmp/job.json

# Start a worker (this can be run in multiple terminals to simulate multiple workers)
node dist/main.js work --job-file=tmp/job.json node scripts/work.mjs

# Check the status of the tasks
node dist/main.js status --job-file=tmp/job.json --out-file=tmp/status.json
```
