import { z } from "zod";

const Task = z.object({
  id: z.string(),
  displayName: z.string(),
  spec: z.record(z.unknown()).default({}),
});

const TaskListFile = z.object({
  id: z
    .string()
    .describe(
      "Unique ID of the task list. " +
        "Different CI workflow runs should have different queue names. " +
        "This ID can be reused when retrying a failed workflow run " +
        "(previously-complete tasks will be skipped)."
    ),
  displayName: z.string().default(""),
  tasks: z
    .array(Task)
    .describe(
      "An array of tasks that needs to be run. " +
        "The tasks will be queued in the order they are listed in this array, " +
        "however, they may be run in parallel and out of order."
    ),
});

export { Task, TaskListFile };
