import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  addedLines,
  findingFingerprint,
  generationResultSchema,
  verificationResultSchema,
  verifyWebhookSignature,
} from "../server/domain.ts";

describe("verifyWebhookSignature", () => {
  const secret = "webhook-secret";
  const body = Buffer.from('{"action":"opened"}');
  const valid = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts a signature over the exact bytes", () => {
    expect(verifyWebhookSignature(secret, body, valid)).toBe(true);
  });

  it("rejects different bytes that parse to the same JSON", () => {
    expect(verifyWebhookSignature(secret, Buffer.from('{ "action": "opened" }'), valid)).toBe(false);
  });

  it.each([undefined, "", "sha256=", "sha256=zz", "sha1=abc", `${valid}00`, valid.toUpperCase()])(
    "rejects malformed signature %s without throwing",
    (header) => {
      expect(verifyWebhookSignature(secret, body, header)).toBe(false);
    },
  );
});

describe("addedLines", () => {
  it("tracks right-side line numbers across multiple hunks", () => {
    const patch = [
      "@@ -1,3 +1,4 @@",
      " context",
      "+added at 2",
      " context",
      "-removed",
      "+added at 4",
      "@@ -20,2 +21,3 @@ function name() {",
      " context",
      "+added at 22",
      " context",
      "\\ No newline at end of file",
    ].join("\n");
    expect([...addedLines(patch)]).toEqual([2, 4, 22]);
  });

  it("handles single-line hunk headers", () => {
    expect([...addedLines("@@ -0,0 +1 @@\n+only line")]).toEqual([1]);
  });

  it("returns nothing for a missing patch", () => {
    expect(addedLines(undefined).size).toBe(0);
  });
});

describe("findingFingerprint", () => {
  const finding = { category: "correctness" as const, path: "src/a.ts", title: "Empty input returns NaN" };

  it("ignores punctuation and case in the title", () => {
    expect(findingFingerprint({ ...finding, title: "empty input — returns NaN!" })).toBe(
      findingFingerprint(finding),
    );
  });

  it("changes with path and category", () => {
    expect(findingFingerprint({ ...finding, path: "src/b.ts" })).not.toBe(findingFingerprint(finding));
    expect(findingFingerprint({ ...finding, category: "security" })).not.toBe(findingFingerprint(finding));
  });
});

describe("model output schemas", () => {
  const candidate = {
    category: "correctness",
    severity: "high",
    title: "Concrete defect title",
    body: "Failure condition and why the introduced code causes it.",
    path: "src/example.ts",
    line: 12,
    evidence: "Specific evidence.",
    suggestion: "Specific correction.",
  };

  it("has no low severity bucket", () => {
    const result = generationResultSchema.safeParse({
      summary: "",
      findings: [{ ...candidate, severity: "low" }],
    });
    expect(result.success).toBe(false);
  });

  it("limits generation to 20 findings", () => {
    const result = generationResultSchema.safeParse({
      summary: "",
      findings: Array.from({ length: 21 }, () => candidate),
    });
    expect(result.success).toBe(false);
  });

  it("does not let the model assert a confirmed fix", () => {
    const result = verificationResultSchema.safeParse({
      acceptedIndices: [],
      summary: "",
      previousFindings: [{ id: "f1", outcome: "confirmed_fixed", evidence: "looks fixed" }],
    });
    expect(result.success).toBe(false);
  });
});
