import { loadConfig } from "./config";
import { Store } from "./db";
import { SlskdAdapter } from "./slskd";
import { Workflow } from "./workflow";
import { Worker } from "./worker";
import { createApp } from "./app";

const config = loadConfig();
const store = new Store(config.DATABASE_PATH, [config.SLSKD_API_KEY,
  config.PHONOFETCH_AUTH_PASSWORD, config.PHONOFETCH_SESSION_SECRET]);
const adapter = new SlskdAdapter(config.SLSKD_BASE_URL, config.SLSKD_API_KEY, config.SEARCH_TIMEOUT_MS, config.SEARCH_RESULT_LIMIT);
const workflow = new Workflow(store, adapter, config);
const worker = new Worker(store, adapter, config, workflow);
worker.start();
const server = createApp(store, adapter, config, workflow).listen(config.PORT, "0.0.0.0", () => {
  store.event("info", "system", "listening", `Phonofetch listening on port ${config.PORT}`);
});
function shutdown(): void {
  server.close(() => {
    void worker.stop().then(() => {
    store.close();
    process.exit(0);
    }).catch(error => {
      console.error("Shutdown error", store.redact(error instanceof Error ? error.message : "unknown"));
      process.exit(1);
    });
  });
  setTimeout(() => process.exit(1), config.SEARCH_TIMEOUT_MS + 15000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
