import app from "./app.js";
import { logger } from "./lib/logger.js";
import { startBot } from "./bot/index.js";
import { initializeClients } from "./lib/gramjsClient.js";
import { startCleanupJob } from "./lib/cleanupJob.js";

const port = 3000;

app.listen(port, (err?: Error) => {
  if (err) { logger.error({ err }, "Error listening on port"); process.exit(1); }

  logger.info({ port }, "Server listening");

  startBot();
  startCleanupJob();

  // Warm up dual MTProto clients in background — ready before first request
  initializeClients().catch((gramErr) => {
    logger.error({ err: gramErr }, "Failed to init MTProto clients");
  });
});

process.once("SIGINT",  () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
