import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.string().transform(Number).default(6060),
  // Comma-separated allowed origins. Defaults to "*" for local dev.
  CORS_ORIGIN: z.string().default("*"),
  // Directory where files are stored
  STORAGE_DIR: z.string().default(".storage"),
  // Base URL for the files, defaults to http://localhost:<port> in local dev
  BASE_URL: z.string().optional(),
});

try {
  var ENV = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error("❌ Invalid environment variables:");
    error.issues.forEach(err => {
      console.error(` - ${err.path.join(".")}: ${err.message}`);
    });
    process.exit(1);
  }
  throw error;
}

// Compute the base URL automatically if not provided
if (!ENV.BASE_URL) {
  ENV.BASE_URL = `http://${ENV.HOST === "0.0.0.0" ? "localhost" : ENV.HOST}:${ENV.PORT}`;
}

export type Env = z.infer<typeof envSchema>;

export { ENV };
