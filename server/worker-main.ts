import { createRuntime, createWorker } from "./runtime.ts";

const runtime = await createRuntime();
const worker = createWorker(runtime);
worker.start();

async function shutdown(): Promise<void> {
  await worker.stop();
  await runtime.db.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
