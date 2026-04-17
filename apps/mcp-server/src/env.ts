import { z } from "zod";

const envSchema = z.object({
  HOST: z.string(),
  PORT: z.string().transform(Number).default(5050),
  TAVILY_API_KEY: z.string().optional(),
  OLLAMA_HOST: z.string().default("http://127.0.0.1:11434"),
  OLLAMA_IMAGE_MODEL: z.string().default("x/flux2-klein:4b"),
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
