import { writeFileSync } from "fs";

writeFileSync(
  "tmp/job.json",
  JSON.stringify({
    id: "test-" + crypto.randomUUID(),
    displayName: "Test Job",
    tasks: Array.from({ length: 500 }, (_, i) => ({
      id: `task-${i}`,
      displayName: `Task ${i}`,
    })),
    worker: "echo",
    workerArgs: ["running", "task", "with", "id"],
  })
);
