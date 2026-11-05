import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "dotenv";
import { describe, expect, it } from "vitest";
import { setEnvValues } from "../scripts/env-file.ts";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "reviewgate-")), ".env.local");

describe("setEnvValues", () => {
  it("writes owner-only files", () => {
    const path = tempFile();
    setEnvValues(path, { KEY: "value" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("replaces existing keys and keeps other lines", () => {
    const path = tempFile();
    setEnvValues(path, { FIRST: "one", SECOND: "two" });
    setEnvValues(path, { SECOND: "changed", THIRD: "three" });
    expect(parse(readFileSync(path))).toEqual({ FIRST: "one", SECOND: "changed", THIRD: "three" });
  });

  it("stores a private key on one line that dotenv restores", () => {
    const path = tempFile();
    const key = "-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----\n";
    setEnvValues(path, { GITHUB_PRIVATE_KEY: key });
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    expect(parse(readFileSync(path)).GITHUB_PRIVATE_KEY).toBe(key);
  });
});

describe("setEnvValues with unsupported values", () => {
  it("refuses a value it could not store faithfully", () => {
    expect(() => setEnvValues(tempFile(), { KEY: 'has"quote' })).toThrow("not supported");
  });
});
