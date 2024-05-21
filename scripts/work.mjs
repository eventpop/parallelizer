import { readFileSync } from "fs";

const job = JSON.parse(readFileSync("tmp/job.json", "utf8"));
const task = job.tasks.find((task) => task.id === process.argv[2]);
const value = task.spec.random;
const ms = value * 100;
await new Promise((resolve) => setTimeout(resolve, ms));
console.log(
  `Task ${task.id} (${task.displayName}) completed in ${ms}ms with value ${value}!`
);
