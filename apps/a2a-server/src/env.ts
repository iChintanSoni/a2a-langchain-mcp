import { z } from "zod";

// Define the schema for your environment variables
const envSchema = z.object({
  HOST: z.string(),
  CARD_HOST: z.string(),
  PORT: z.string().transform(Number).default(4000),
  GRPC_PORT: z.string().transform(Number).default(4001),
  MCP_SERVER_HOST: z.string(),
  MCP_SERVER_PORT: z.string().transform(Number).default(5050),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  DOCLING_SERVE_URL: z.string().optional(),
});

try {
  var ENV = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error("❌ Invalid environment variables:");
    error.issues.forEach((err) => {
      console.error(` - ${err.path.join(".")}: ${err.message}`);
    });
    process.exit(1);
  }
  throw error;
}

export type Env = z.infer<typeof envSchema>;

export { ENV };
