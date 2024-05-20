# parallelizer

A tool that parallelizes testing tasks across multiple worker nodes.

## Background

At Eventpop, we have many automated tests which are implemented using different tools, such as Cucumber and RSpec. Running them sequentially can take hours.

![before](https://github.com/eventpop/parallelizer/assets/193136/28456209-ca4b-4d38-bea4-5837da1f20f2)

To speed up the process, they have to be run in parallel.

A simple solution is to separate the tests into smaller groups and run them in parallel (**test sharding**). However, splitting the tests into shards of equal number of test files can lead to imbalance in the execution time of each shard, because the time it takes to run each test file can vary wildly. In our case, some of our test files finish in less than a second, while a few takes about 1 minute. This can lead to some shards finishing their work early and being idle while others are still working.

![shard1](https://github.com/eventpop/parallelizer/assets/193136/88598a5a-af23-45c8-a68e-bf29fbb8bdf8)

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
node dist/main.js work --job-file=tmp/job.json echo
```
