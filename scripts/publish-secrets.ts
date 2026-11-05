import { parseArgs } from "node:util";
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { loadEnvFiles } from "../server/config.ts";
import { RUNTIME_SECRET_KEYS } from "../server/secrets.ts";

/**
 * Merges allowlisted values from .env.local into the runtime secret, in memory.
 * Existing keys such as DATABASE_URL are preserved. Omitting --origin resets
 * APP_ORIGIN to a placeholder, so always pass the real origin once there is one.
 *
 *   node --import tsx scripts/publish-secrets.ts --secret=ARN --origin=https://example.com
 */
const PLACEHOLDER_ORIGIN = "https://pending.invalid";
const LOCAL_ONLY_KEYS = new Set(["DATABASE_URL", "APP_ORIGIN"]);

const { values: args } = parseArgs({
  options: { secret: { type: "string" }, origin: { type: "string" } },
});
if (!args.secret) throw new Error("Pass --secret with the runtime secret ARN.");

loadEnvFiles();

const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
const { SecretString } = await client
  .send(new GetSecretValueCommand({ SecretId: args.secret }))
  .catch((error: { name?: string }) => {
    // A newly created secret has no value yet.
    if (error.name === "ResourceNotFoundException") return { SecretString: undefined };
    throw error;
  });

const merged: Record<string, unknown> = SecretString ? JSON.parse(SecretString) : {};
for (const key of RUNTIME_SECRET_KEYS) {
  const value = process.env[key];
  if (value && !LOCAL_ONLY_KEYS.has(key)) merged[key] = value;
}
merged.APP_ORIGIN = args.origin ?? PLACEHOLDER_ORIGIN;

await client.send(
  new PutSecretValueCommand({ SecretId: args.secret, SecretString: JSON.stringify(merged) }),
);
console.log(`Published ${Object.keys(merged).length} keys. Restart both services to load them.`);
