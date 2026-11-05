import { loadConfig, type AppConfig } from "./config.ts";
import { createDb, migrate, type Db } from "./db.ts";
import { createHandlers, type EngineDeps } from "./engine.ts";
import { createGateway } from "./github.ts";
import { createReviewModel } from "./reviewer.ts";
import { hydrateSecrets } from "./secrets.ts";
import { enqueuePeriodicSync } from "./service.ts";
import { SqsWakeups } from "./sqs.ts";
import { Worker } from "./worker.ts";

/** Secret values that must not appear in model context or published comments. */
function knownSecretsFrom(config: AppConfig): string[] {
  return [
    config.adminPassword,
    config.github.privateKey,
    config.github.webhookSecret,
    config.anthropic.apiKey,
    config.databaseUrl,
  ].filter((value): value is string => Boolean(value));
}

export interface Runtime {
  config: AppConfig;
  db: Db;
  deps: EngineDeps;
}

export async function createRuntime(): Promise<Runtime> {
  await hydrateSecrets();
  const config = loadConfig();
  const db = await createDb({
    databaseUrl: config.databaseUrl,
    databaseCaFile: config.databaseCaFile,
    pglitePath: config.pglitePath,
  });
  await migrate(db, config.targetAccount);
  const deps: EngineDeps = {
    config,
    db,
    github: createGateway(config.github),
    model: createReviewModel(config),
    knownSecrets: knownSecretsFrom(config),
  };
  return { config, db, deps };
}

export function createWorker({ config, db, deps }: Runtime): Worker {
  return new Worker({
    db,
    handlers: createHandlers(deps),
    wakeups: config.sqsQueueUrl ? new SqsWakeups(config.sqsQueueUrl, config.awsRegion) : null,
    // Without App credentials a sync can only fail, so none is queued.
    onTick: deps.github ? () => enqueuePeriodicSync({ config, db }) : undefined,
    onError: (error) => {
      // Only the name is logged. Provider messages can contain request details.
      console.error(`worker error: ${error instanceof Error ? error.name : "unknown"}`);
    },
  });
}
