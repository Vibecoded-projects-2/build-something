import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value === "" ? undefined : value));

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: positiveInt(4310),
  APP_ORIGIN: z.string().default("http://localhost:4310"),
  TARGET_ACCOUNT: z.string().min(1).default("vibecoded-projects-2"),
  ADMIN_USERNAME: z.string().min(1).default("admin"),
  ADMIN_PASSWORD: z.string().min(20, "ADMIN_PASSWORD must be at least 20 characters"),
  DATABASE_URL: optionalString,
  DATABASE_CA_FILE: optionalString,
  PGLITE_PATH: z.string().default(".data/postgres"),
  GITHUB_APP_ID: optionalString,
  GITHUB_APP_SLUG: optionalString,
  GITHUB_PRIVATE_KEY: optionalString,
  GITHUB_WEBHOOK_SECRET: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_WORKSPACE_ID: optionalString,
  REVIEW_MODEL: z.string().default("claude-opus-5-5"),
  MONTHLY_BUDGET_USD: z.coerce.number().positive().default(50),
  MAX_REVIEW_INPUT_TOKENS: positiveInt(100_000),
  MAX_REVIEW_OUTPUT_TOKENS: positiveInt(8_000),
  MAX_PR_FILES: positiveInt(100),
  MAX_CONTEXT_BYTES: positiveInt(300_000),
  SQS_QUEUE_URL: optionalString,
  AWS_REGION: z.string().default("us-west-2"),
  RUN_WORKER: optionalString,
});

export interface AppConfig {
  production: boolean;
  port: number;
  appOrigin: string;
  targetAccount: string;
  adminUsername: string;
  adminPassword: string;
  databaseUrl?: string;
  databaseCaFile?: string;
  pglitePath: string;
  github: {
    appId?: string;
    appSlug?: string;
    privateKey?: string;
    webhookSecret?: string;
  };
  anthropic: {
    apiKey?: string;
    workspaceId?: string;
  };
  reviewModel: string;
  monthlyBudgetUsd: number;
  maxReviewInputTokens: number;
  maxReviewOutputTokens: number;
  maxPrFiles: number;
  maxContextBytes: number;
  sqsQueueUrl?: string;
  awsRegion: string;
  runWorker: boolean;
}

/** Loads local dotenv files without overriding values already in the environment. */
export function loadEnvFiles(): void {
  loadDotenv({ path: ".env.local", quiet: true });
  loadDotenv({ quiet: true });
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Report only field names and rule messages, never the supplied values.
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid configuration: ${problems.join("; ")}`);
  }

  const values = parsed.data;
  const production = values.NODE_ENV === "production";
  const appOrigin = normalizeOrigin(values.APP_ORIGIN);

  if (production) {
    if (!appOrigin.startsWith("https://")) {
      throw new Error("Invalid configuration: APP_ORIGIN must use HTTPS in production");
    }
    if (!values.DATABASE_URL) {
      throw new Error("Invalid configuration: DATABASE_URL is required in production");
    }
    if (!values.SQS_QUEUE_URL) {
      throw new Error("Invalid configuration: SQS_QUEUE_URL is required in production");
    }
  }

  return {
    production,
    port: values.PORT,
    appOrigin,
    targetAccount: values.TARGET_ACCOUNT.toLowerCase(),
    adminUsername: values.ADMIN_USERNAME,
    adminPassword: values.ADMIN_PASSWORD,
    databaseUrl: values.DATABASE_URL,
    databaseCaFile: values.DATABASE_CA_FILE,
    pglitePath: values.PGLITE_PATH,
    github: {
      appId: values.GITHUB_APP_ID,
      appSlug: values.GITHUB_APP_SLUG,
      privateKey: values.GITHUB_PRIVATE_KEY?.replaceAll("\\n", "\n"),
      webhookSecret: values.GITHUB_WEBHOOK_SECRET,
    },
    anthropic: {
      apiKey: values.ANTHROPIC_API_KEY,
      workspaceId: values.ANTHROPIC_WORKSPACE_ID,
    },
    reviewModel: values.REVIEW_MODEL,
    monthlyBudgetUsd: values.MONTHLY_BUDGET_USD,
    maxReviewInputTokens: values.MAX_REVIEW_INPUT_TOKENS,
    maxReviewOutputTokens: values.MAX_REVIEW_OUTPUT_TOKENS,
    maxPrFiles: values.MAX_PR_FILES,
    maxContextBytes: values.MAX_CONTEXT_BYTES,
    sqsQueueUrl: values.SQS_QUEUE_URL,
    awsRegion: values.AWS_REGION,
    runWorker: values.RUN_WORKER !== "false",
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  loadEnvFiles();
  return parseConfig(env);
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid configuration: APP_ORIGIN must be an absolute URL");
  }
  return url.origin;
}
