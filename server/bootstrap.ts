import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import pg from "pg";
import { readSecretJson } from "./secrets.ts";

/**
 * One-off task. It creates the restricted application role and writes its connection
 * string to the runtime secret. Runtime services never read the master secret.
 * It prints phases only, never values.
 */
const APP_ROLE = "reviewgate_app";
const APP_SCHEMA = "reviewgate";
const DATABASE = "reviewgate";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function existingPassword(databaseUrl: unknown): string | null {
  if (typeof databaseUrl !== "string" || databaseUrl === "") return null;
  return decodeURIComponent(new URL(databaseUrl).password) || null;
}

async function main(): Promise<void> {
  const runtimeSecretId = required("APP_CONFIG_SECRET_ARN");
  const masterSecretId = required("DB_MASTER_SECRET_ARN");
  const host = required("DATABASE_HOST");
  const caFile = required("DATABASE_CA_FILE");

  const secrets = new SecretsManagerClient({ region: process.env.AWS_REGION });
  const runtime = await readSecretJson(secrets, runtimeSecretId);
  const master = await readSecretJson(secrets, masterSecretId);

  const password = existingPassword(runtime.DATABASE_URL) ?? randomBytes(24).toString("hex");

  const client = new pg.Client({
    host,
    port: 5432,
    database: DATABASE,
    user: String(master.username),
    password: String(master.password),
    ssl: { ca: readFileSync(caFile, "utf8"), rejectUnauthorized: true },
  });

  console.log("bootstrap: connecting");
  await client.connect();
  try {
    console.log("bootstrap: applying role and schema");
    const literal = client.escapeLiteral(password);
    const roles = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE]);
    await client.query(
      roles.rowCount === 0
        ? `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD ${literal}`
        : `ALTER ROLE ${APP_ROLE} LOGIN PASSWORD ${literal}`,
    );
    // The schema is created by this account and granted to the app role.
    // Managed PostgreSQL does not allow the master role to switch into the app role.
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${APP_SCHEMA}`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA ${APP_SCHEMA} TO ${APP_ROLE}`);
    await client.query(`GRANT CONNECT ON DATABASE ${DATABASE} TO ${APP_ROLE}`);
    await client.query(`ALTER ROLE ${APP_ROLE} SET search_path = ${APP_SCHEMA}`);
  } finally {
    await client.end();
  }

  console.log("bootstrap: writing application connection");
  const databaseUrl = `postgresql://${APP_ROLE}:${encodeURIComponent(password)}@${host}:5432/${DATABASE}`;
  await secrets.send(
    new PutSecretValueCommand({
      SecretId: runtimeSecretId,
      SecretString: JSON.stringify({ ...runtime, DATABASE_URL: databaseUrl }),
    }),
  );
  secrets.destroy();
  console.log("bootstrap: complete");
}

main().catch((error: unknown) => {
  // Driver errors can include connection details, so only a code is printed.
  const code = (error as { code?: unknown } | null)?.code;
  console.error(`bootstrap: failed (${typeof code === "string" ? code : "UNKNOWN"})`);
  process.exit(1);
});
