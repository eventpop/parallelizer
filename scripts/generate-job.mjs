import { mkdirSync, writeFileSync } from "fs";

mkdirSync("tmp", { recursive: true });
writeFileSync(
  "tmp/job.json",
  JSON.stringify({
    id: "test-" + crypto.randomUUID(),
    displayName: "Test Job",
    tasks: Array.from({ length: 200 }, (_, i) => ({
      id: `task-${i}`,
      displayName: `Task ${i}`,
    })),
  })
);
