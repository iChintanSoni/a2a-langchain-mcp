import { ENV } from "#src/env.ts";
import { createApp } from "#src/http-server.ts";
import { createLogger } from "common";

const log = createLogger("file-server");

const app = createApp();

// ─── Start Server ──────────────────────────────────────────────────────────

const httpServer = app.listen(ENV.PORT, ENV.HOST, () => {
  log.success("File Server listening", {
    uploadUrl: `${ENV.BASE_URL}/upload`,
    filesUrl: `${ENV.BASE_URL}/files`,
  });
});

// ─── Graceful shutdown ──────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  log.warn(`${signal} received — shutting down gracefully`);

  httpServer.close();

  log.info("File Server shutdown complete");
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
