import { Env } from "@(-.-)/env";
import { hostname } from "os";
import { z } from "zod";

const envSchema = z.object({
  PARALLELIZER_DYNAMODB_TABLE: z.string().default("parallelizer"),
  PARALLELIZER_WORKER_ID: z.string().default(hostname()),
});

const env = Env(envSchema);

export { env };
