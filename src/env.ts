import { z } from "zod";
import { Env } from "@(-.-)/env";

const envSchema = z.object({
  PARALLELIZER_DYNAMODB_TABLE: z.string().default("parallelizer"),
});

const env = Env(envSchema);

export { env };
