import { describe, expect, it } from "vitest";
import { parseConfig } from "../server/config.ts";

const password = "a-long-enough-password-value";

describe("parseConfig", () => {
  it("applies local defaults and normalizes the target account", () => {
    const config = parseConfig({ ADMIN_PASSWORD: password, TARGET_ACCOUNT: "Some-Org" });
    expect(config.production).toBe(false);
    expect(config.port).toBe(4310);
    expect(config.targetAccount).toBe("some-org");
    expect(config.reviewModel).toBe("claude-opus-5-5");
    expect(config.runWorker).toBe(true);
  });

  it("disables the embedded worker only for the exact value false", () => {
    expect(parseConfig({ ADMIN_PASSWORD: password, RUN_WORKER: "false" }).runWorker).toBe(false);
    expect(parseConfig({ ADMIN_PASSWORD: password, RUN_WORKER: "0" }).runWorker).toBe(true);
  });

  it("treats empty optional values as unset", () => {
    const config = parseConfig({ ADMIN_PASSWORD: password, DATABASE_URL: "", GITHUB_APP_ID: "" });
    expect(config.databaseUrl).toBeUndefined();
    expect(config.github.appId).toBeUndefined();
  });

  it("restores escaped newlines in the GitHub private key", () => {
    const config = parseConfig({ ADMIN_PASSWORD: password, GITHUB_PRIVATE_KEY: "line1\\nline2" });
    expect(config.github.privateKey).toBe("line1\nline2");
  });

  it("rejects a short password without echoing it", () => {
    expect(() => parseConfig({ ADMIN_PASSWORD: "short-secret" })).toThrowError(
      /^(?!.*short-secret).*ADMIN_PASSWORD/,
    );
  });

  it("enforces production requirements", () => {
    const base = {
      NODE_ENV: "production",
      ADMIN_PASSWORD: password,
      APP_ORIGIN: "https://reviewgate.example.com",
      DATABASE_URL: "postgres://example/db",
      SQS_QUEUE_URL: "https://sqs.example.com/queue",
    };
    expect(parseConfig(base).production).toBe(true);
    expect(() => parseConfig({ ...base, APP_ORIGIN: "http://reviewgate.example.com" })).toThrow(/HTTPS/);
    expect(() => parseConfig({ ...base, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
    expect(() => parseConfig({ ...base, SQS_QUEUE_URL: "" })).toThrow(/SQS_QUEUE_URL/);
  });
});
