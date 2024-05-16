# Parallelizer Project

## Description

Parallelizer is a tool designed to optimize and parallelize tasks across multiple computing resources, enhancing efficiency and reducing execution time.

## Setup and Usage

To set up the project, ensure you have `pnpm` installed on your system. Clone the repository and run `pnpm install` to install dependencies. Use the following commands to interact with the project:

- `pnpm run build`: Compiles the project using `tsup`.
- `pnpm run dev`: Runs the project in development mode with hot reloading.

## Features

- Task parallelization across multiple nodes.
- Dynamic task distribution based on resource availability.
- Comprehensive logging and monitoring of task execution.

## Note

This project uses `pnpm` for package management to ensure efficient handling of node modules and dependencies. It is designed to work with Node.js version 20.

## Testing procedure

```sh
# Generate a job file
node scripts/generate-job.mjs

# Enqueue jobs into the queue
node dist/main.js prepare --job-file=tmp/job.json

# Start a worker (this can be run in multiple terminals to simulate multiple workers)
node dist/main.js work --job-file=tmp/job.json echo
```
