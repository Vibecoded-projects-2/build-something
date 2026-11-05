import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const PROMPT_VERSION = "2026-10-22.1";

export const CATEGORIES = [
  "correctness",
  "security",
  "reliability",
  "performance",
  "testing",
  "maintainability",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ["critical", "high", "medium"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Outcomes a model may assign. `confirmed_fixed` is reserved for humans. */
export const MODEL_OUTCOMES = ["open", "suspected_fixed", "unverifiable"] as const;
export type ModelOutcome = (typeof MODEL_OUTCOMES)[number];

export const FINDING_OUTCOMES = [...MODEL_OUTCOMES, "confirmed_fixed", "dismissed"] as const;
export type FindingOutcome = (typeof FINDING_OUTCOMES)[number];

export const RUN_STATES = [
  "queued",
  "reviewing",
  "publishing",
  "completed",
  "partial",
  "failed",
  "superseded",
  "skipped",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const JOB_STATES = ["pending", "running", "completed", "dead"] as const;
export type JobState = (typeof JOB_STATES)[number];

export const findingCandidateSchema = z.object({
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  title: z.string().min(5).max(140),
  body: z.string().min(20).max(2500),
  path: z.string().min(1).max(500),
  line: z.number().int().positive(),
  evidence: z.string().min(5).max(1500),
  suggestion: z.string().min(5).max(2000),
});
export type FindingCandidate = z.infer<typeof findingCandidateSchema>;

export const generationResultSchema = z.object({
  summary: z.string().max(2000),
  findings: z.array(findingCandidateSchema).max(20),
});
export type GenerationResult = z.infer<typeof generationResultSchema>;

export const verificationResultSchema = z.object({
  acceptedIndices: z.array(z.number().int().nonnegative()),
  summary: z.string().max(2000),
  previousFindings: z.array(
    z.object({
      id: z.string().min(1),
      outcome: z.enum(MODEL_OUTCOMES),
      evidence: z.string().max(1500),
    }),
  ),
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;

/**
 * Approximate duplicate boundary: category, path, and normalized title.
 * Two differently worded findings about the same defect will not collide.
 */
export function findingFingerprint(
  finding: Pick<FindingCandidate, "category" | "path" | "title">,
): string {
  const normalizedTitle = finding.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return createHash("sha256")
    .update(`${finding.category}\0${finding.path}\0${normalizedTitle}`)
    .digest("hex");
}

const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;

/** Verifies a GitHub HMAC over the exact bytes received, in constant time. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (!header || !SIGNATURE_PATTERN.test(header)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(header.slice("sha256=".length), "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Returns the right-side line numbers added by a unified diff patch. */
export function addedLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;

  let rightLine = 0;
  let insideHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      rightLine = Number(hunk[1]);
      insideHunk = true;
      continue;
    }
    if (!insideHunk) continue;
    if (line.startsWith("+")) {
      lines.add(rightLine);
      rightLine += 1;
    } else if (line.startsWith("-") || line.startsWith("\\")) {
      continue;
    } else {
      rightLine += 1;
    }
  }
  return lines;
}

export const SAFE_ERROR_CODES = [
  "GITHUB_APP_NOT_CONFIGURED",
  "ANTHROPIC_KEY_NOT_CONFIGURED",
  "INSTALLATION_ACCOUNT_MISMATCH",
  "REPOSITORY_ACCOUNT_MISMATCH",
  "CONTEXT_TOKEN_LIMIT",
  "MODEL_PRICING_NOT_CONFIGURED",
  "MODEL_OUTPUT_INVALID",
  "MONTHLY_BUDGET_LIMIT",
  "JOB_LEASE_LOST",
  "RUNTIME_CONFIGURATION_UNAVAILABLE",
  "GITHUB_ACCESS_DENIED",
  "GITHUB_NOT_FOUND",
  "GITHUB_RATE_LIMITED",
  "MODEL_ACCESS_DENIED",
  "MODEL_RATE_LIMITED",
  "MODEL_REQUEST_FAILED",
  "INTERNAL_ERROR",
] as const;
export type SafeErrorCode = (typeof SAFE_ERROR_CODES)[number];

/** An error whose code is safe to store and show. It carries no provider payload. */
export class SafeError extends Error {
  constructor(
    readonly code: SafeErrorCode,
    readonly retryable = false,
  ) {
    super(code);
    this.name = "SafeError";
  }
}

export function safeErrorCode(error: unknown): SafeErrorCode {
  return error instanceof SafeError ? error.code : "INTERNAL_ERROR";
}

/** The internal pull request identifier used across tables and URLs. */
export function pullRequestId(repoId: number, prNumber: number): string {
  return `${repoId}:${prNumber}`;
}

export function runMarker(runId: string): string {
  return `<!-- reviewgate:run:${runId} -->`;
}

export function findingMarker(findingId: string): string {
  return `<!-- reviewgate:finding:${findingId} -->`;
}
