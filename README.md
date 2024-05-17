# parallelizer

A tool that allows for the parallelization of tasks across multiple worker nodes. The tool is designed to distribute tasks dynamically based on the availability of resources.

## Setup and Usage

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
