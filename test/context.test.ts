import { describe, expect, it } from "vitest";
import {
  buildContext,
  isExcludedPath,
  redact,
  relatedCandidates,
  sanitizeModelText,
} from "../server/context.ts";
import { FakeGitHub } from "./fake-github.ts";

const ref = { installationId: 7, owner: "acme", repo: "app" };
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const patch = "@@ -1 +1,2 @@\n context\n+added";

const request = (github: FakeGitHub, overrides = {}) => ({
  github,
  ref,
  number: 1,
  title: "Add feature",
  headSha: HEAD,
  baseSha: BASE,
  maxFiles: 100,
  maxBytes: 300_000,
  ...overrides,
});

describe("isExcludedPath", () => {
  it.each([
    ".env",
    ".env.production",
    "config/.env.local",
    "secrets.yaml",
    "certs/server.pem",
    "deploy/key.p12",
    "node_modules/pkg/index.js",
    "dist/app.js",
    "package-lock.json",
    "pnpm-lock.yaml",
    "assets/logo.png",
    "fonts/inter.woff2",
    "app.js.map",
    "vendor/lib.min.js",
    "infra/terraform.tfstate",
  ])("excludes %s", (path) => {
    expect(isExcludedPath(path)).toBe(true);
  });

  it.each(["src/index.ts", "README.md", "src/secret-manager.ts", "docs/environment.md", "lib/tokens.go"])(
    "keeps %s",
    (path) => {
      expect(isExcludedPath(path)).toBe(false);
    },
  );
});

describe("redact", () => {
  it.each([
    "AKIAABCDEFGHIJKLMNOP",
    "ghp_abcdefghijklmnopqrstuvwxyz012345",
    "github_pat_abcdefghijklmnopqrstuvwxyz",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "xoxb-1234567890-abcdefg",
  ])("removes token %s", (token) => {
    expect(redact(`value ${token} end`)).toBe("value [REDACTED] end");
  });

  it("removes credential assignments and keeps the key name", () => {
    expect(redact(`password = "hunter2hunter2"`)).toBe(`password = [REDACTED]`);
    expect(redact(`API_KEY: abcdef123456`)).toBe(`API_KEY: [REDACTED]`);
  });

  it("leaves ordinary code alone", () => {
    const code = `const password = input.value;\nconst token = getToken();`;
    expect(redact(code)).toBe(code);
  });

  it("preserves line counts when removing a private key", () => {
    const key = [
      "+-----BEGIN RSA PRIVATE KEY-----",
      "+abc",
      "+def",
      "+-----END RSA PRIVATE KEY-----",
      " after",
    ].join("\n");
    const result = redact(key);
    expect(result.split("\n")).toHaveLength(5);
    expect(result).not.toContain("abc");
    expect(result).toContain(" after");
  });

  it("removes known secrets", () => {
    expect(redact("uses plain-known-value here", ["plain-known-value"])).toBe("uses [REDACTED] here");
  });
});

describe("sanitizeModelText", () => {
  it("removes publication markers", () => {
    const text = "before <!-- reviewgate:run:forged --> after <!-- REVIEWGATE:finding:x -->";
    expect(sanitizeModelText(text)).toBe("before  after ");
  });

  it("neutralizes user mentions but leaves emails and paths", () => {
    expect(sanitizeModelText("ask @alice about it")).toBe("ask @​alice about it");
    expect(sanitizeModelText("write to dev@example.com")).toBe("write to dev@example.com");
    expect(sanitizeModelText("see node_modules/@types/node")).toBe("see node_modules/@types/node");
  });
});

describe("relatedCandidates", () => {
  it("finds adjacent tests and relative imports", () => {
    const source = `import { a } from "./a";\nimport b from "../lib/b.ts";\nimport x from "react";`;
    const candidates = relatedCandidates("src/feature/index.ts", source);
    expect(candidates.slice(0, 3)).toEqual([
      "src/feature/index.test.ts",
      "src/feature/index.spec.ts",
      "src/feature/__tests__/index.test.ts",
    ]);
    expect(candidates).toContain("src/feature/a");
    expect(candidates).toHaveLength(8);
  });

  it("ignores non-script files and imports that escape the repository", () => {
    expect(relatedCandidates("README.md", `from "./a"`)).toEqual([]);
    const candidates = relatedCandidates("index.test.ts", `import "../../escape";`);
    expect(candidates).toEqual([]);
  });
});

describe("buildContext", () => {
  it("includes diff and head source and records added-line anchors", async () => {
    const github = new FakeGitHub();
    github.files.set(1, [{ path: "src/a.ts", status: "modified", patch }]);
    github.sources.set(`${HEAD}:src/a.ts`, "context\nadded\n");

    const context = await buildContext(request(github));
    const parsed = JSON.parse(context.serialized);
    expect(parsed.files[0]).toMatchObject({ path: "src/a.ts", role: "changed", patch });
    expect(parsed.files[0].source).toBe("context\nadded\n");
    expect([...context.anchors.get("src/a.ts")!]).toEqual([2]);
    expect(context.coverage).toMatchObject({ filesReviewed: 1, complete: true });
  });

  it("reads removed files from the base commit and gives them no anchors", async () => {
    const github = new FakeGitHub();
    github.files.set(1, [{ path: "src/gone.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-old" }]);
    github.sources.set(`${BASE}:src/gone.ts`, "old\n");
    const context = await buildContext(request(github));
    expect(JSON.parse(context.serialized).files[0].source).toBe("old\n");
    expect(context.anchors.has("src/gone.ts")).toBe(false);
  });

  it("never fetches or sends excluded files", async () => {
    const github = new FakeGitHub();
    github.files.set(1, [{ path: ".env", status: "modified", patch: "@@ -0,0 +1 @@\n+KEY=value" }]);
    github.sources.set(".env", "KEY=value");
    const context = await buildContext(request(github));
    expect(context.serialized).not.toContain("KEY=value");
    expect(context.coverage.excluded).toEqual([".env"]);
  });

  it("redacts before serializing", async () => {
    const github = new FakeGitHub();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz012345";
    github.files.set(1, [{ path: "a.ts", status: "added", patch: `@@ -0,0 +1 @@\n+${token}` }]);
    github.sources.set("a.ts", token);
    const context = await buildContext(request(github, { title: `leak ${token}` }));
    expect(context.serialized).not.toContain(token);
  });

  it("records missing source and omitted diffs as incomplete coverage", async () => {
    const github = new FakeGitHub();
    github.files.set(1, [
      { path: "a.ts", status: "modified", patch },
      { path: "big.ts", status: "modified" },
    ]);
    github.sources.set("big.ts", "content");
    const context = await buildContext(request(github));
    expect(context.coverage).toMatchObject({
      missingSource: ["a.ts"],
      omittedDiffs: ["big.ts"],
      complete: false,
    });
  });

  it("records the file limit", async () => {
    const github = new FakeGitHub();
    github.files.set(1, [
      { path: "a.ts", status: "modified", patch },
      { path: "b.ts", status: "modified", patch },
    ]);
    const context = await buildContext(request(github, { maxFiles: 1 }));
    expect(context.coverage).toMatchObject({ filesChanged: 1, fileLimitReached: true, complete: false });
  });

  it("falls back to the diff, then omits, as the byte budget runs out", async () => {
    const github = new FakeGitHub();
    github.files.set(1, [
      { path: "small.ts", status: "modified", patch },
      { path: "large.ts", status: "modified", patch: `@@ -0,0 +1 @@\n+${"x".repeat(2000)}` },
    ]);
    github.sources.set("small.ts", "s".repeat(600));
    const context = await buildContext(request(github, { maxBytes: 400 }));
    const paths = JSON.parse(context.serialized).files;
    expect(paths).toHaveLength(1);
    expect(paths[0].path).toBe("small.ts");
    expect(paths[0].source).toBeUndefined();
    expect(context.coverage.contextLimited).toEqual(["large.ts"]);
    expect(context.anchors.has("large.ts")).toBe(false);
    expect(context.coverage.complete).toBe(false);
    expect(Buffer.byteLength(context.serialized)).toBeLessThanOrEqual(400);
  });

  it("adds at most two related files per changed file", async () => {
    const github = new FakeGitHub();
    github.files.set(1, [{ path: "src/a.ts", status: "modified", patch }]);
    github.sources.set("src/a.ts", `import "./x.ts";\nimport "./y.ts";`);
    github.sources.set("src/a.test.ts", "test");
    github.sources.set("src/x.ts", "x");
    github.sources.set("src/y.ts", "y");
    const context = await buildContext(request(github));
    const roles = JSON.parse(context.serialized).files.map((file: { path: string }) => file.path);
    expect(roles).toEqual(["src/a.ts", "src/a.test.ts", "src/x.ts"]);
    expect(context.coverage.relatedFiles).toBe(2);
  });

  it("retrieves paths of earlier findings even outside the latest diff", async () => {
    const github = new FakeGitHub();
    github.files.set(1, [{ path: "a.ts", status: "modified", patch }]);
    github.sources.set("a.ts", "a");
    github.sources.set("old.ts", "now fixed");
    const context = await buildContext(request(github, { priorPaths: ["old.ts", "deleted.ts"] }));
    const files = JSON.parse(context.serialized).files;
    expect(files.find((file: { path: string }) => file.path === "old.ts")).toMatchObject({
      role: "prior",
      source: "now fixed",
    });
    expect(files.find((file: { path: string }) => file.path === "deleted.ts").source).toBeUndefined();
  });
});
