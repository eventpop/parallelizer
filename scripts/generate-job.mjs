import { mkdirSync, writeFileSync } from "fs";

mkdirSync("tmp", { recursive: true });
const job = {
  id: "test-" + crypto.randomUUID(),
  tasks: Array.from({ length: 50 }, (_, i) => ({
    id: `task-${i}`,
    displayName: `Task ${i}`,
    spec: { random: ~~(Math.random() * 10 + 1) },
  })),
};
writeFileSync("tmp/job.json", JSON.stringify(job, null, 2));
console.log("Job file generated:", "tmp/job.json");
console.log("Job ID:", job.id);
