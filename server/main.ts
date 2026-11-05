import { createApp } from "./app.ts";
import { registerFrontend } from "./frontend.ts";
import { createRuntime, createWorker } from "./runtime.ts";

const runtime = await createRuntime();
const { config, db, deps } = runtime;

const app = await createApp({
  config,
  db,
  hasGitHubClient: deps.github !== null,
  logger: true,
});
const closeFrontend = await registerFrontend(app, config);
const worker = config.runWorker ? createWorker(runtime) : null;

await app.listen({ host: "0.0.0.0", port: config.port });
worker?.start();

async function shutdown(): Promise<void> {
  await worker?.stop();
  await app.close();
  await closeFrontend();
  await db.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
