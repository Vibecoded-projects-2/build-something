import type {
  FindingCandidate,
  GenerationResult,
  VerificationResult,
} from "../server/domain.ts";
import type { PreviousFinding, ReviewModel, TokenUsage, UsageSink } from "../server/reviewer.ts";

export const FAKE_USAGE: TokenUsage = {
  inputTokens: 10_000,
  outputTokens: 1_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function candidate(overrides: Partial<FindingCandidate> = {}): FindingCandidate {
  return {
    category: "correctness",
    severity: "high",
    title: "Empty input returns NaN",
    body: "Calling average with an empty list divides by zero and returns NaN.",
    path: "src/average.ts",
    line: 2,
    evidence: "The zero-length guard was removed.",
    suggestion: "Return 0 when the list is empty.",
    ...overrides,
  };
}

/** A controlled model. By default it accepts every candidate. */
export class FakeModel implements ReviewModel {
  readonly model = "claude-opus-5-5";
  generateCalls = 0;
  verifyCalls = 0;
  findings: FindingCandidate[] = [];
  accepted: number[] | null = null;
  assessments: VerificationResult["previousFindings"] = [];
  summary = "Reviewed the change.";
  lastPrevious: PreviousFinding[] = [];
  lastContext = "";
  beforeGenerate?: () => void | Promise<void>;
  failGenerate?: () => Error;

  async generate(context: string, onUsage: UsageSink): Promise<GenerationResult> {
    this.generateCalls += 1;
    this.lastContext = context;
    await this.beforeGenerate?.();
    await onUsage(FAKE_USAGE);
    if (this.failGenerate) throw this.failGenerate();
    return { summary: this.summary, findings: this.findings };
  }

  async verify(
    context: string,
    candidates: FindingCandidate[],
    previous: PreviousFinding[],
    onUsage: UsageSink,
  ): Promise<VerificationResult> {
    this.verifyCalls += 1;
    this.lastContext = context;
    this.lastPrevious = previous;
    await onUsage(FAKE_USAGE);
    return {
      acceptedIndices: this.accepted ?? candidates.map((_, index) => index),
      summary: this.summary,
      previousFindings: this.assessments,
    };
  }
}
