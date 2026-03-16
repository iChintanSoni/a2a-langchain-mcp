import { z } from 'zod';

// Define the schema for environment variables
const envSchema = z.object({
  HOST: z.string().default('localhost'),
  PORT: z.coerce.number().int().positive().default(41241),
  MODEL: z.string().default('qwen3:4b'),
});

// Since node --env-file will load into process.env, we just parse it
const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.format());
  process.exit(1);
}

export const env = parsedEnv.data;
