import { z } from "zod";

const envSchema = z.object({
  HOST: z.string(),
  PORT: z.string().transform(Number).default(5000),
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
