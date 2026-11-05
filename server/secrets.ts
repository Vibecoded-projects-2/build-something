import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/** Only these keys may come from the runtime secret. Others are ignored. */
export const RUNTIME_SECRET_KEYS = [
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "DATABASE_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_WORKSPACE_ID",
  "APP_ORIGIN",
] as const;

export function applyRuntimeSecret(
  secret: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): void {
  for (const key of RUNTIME_SECRET_KEYS) {
    const value = secret[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
}

export async function readSecretJson(
  client: SecretsManagerClient,
  secretId: string,
): Promise<Record<string, unknown>> {
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!SecretString) throw new Error("Secret has no string value");
  return JSON.parse(SecretString) as Record<string, unknown>;
}

/** Loads the runtime secret into the environment when APP_CONFIG_SECRET_ARN is set. */
export async function hydrateSecrets(): Promise<void> {
  const secretId = process.env.APP_CONFIG_SECRET_ARN;
  if (!secretId) return;
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
  try {
    applyRuntimeSecret(await readSecretJson(client, secretId));
  } catch {
    // The SDK error can name the resource, so it is replaced with a fixed message.
    throw new Error("RUNTIME_CONFIGURATION_UNAVAILABLE");
  } finally {
    client.destroy();
  }
}
