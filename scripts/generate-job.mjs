import { mkdirSync, writeFileSync } from "fs";

mkdirSync("tmp", { recursive: true });
const job = {
  id: "test-" + crypto.randomUUID(),
  displayName: "Test Job",
  tasks: Array.from({ length: 50 }, (_, i) => ({
    id: `task-${i}`,
    displayName: `Task ${i}`,
  })),
};
writeFileSync("tmp/job.json", JSON.stringify(job));
console.log("Job file generated:", "tmp/job.json");
console.log("Job ID:", job.id);
