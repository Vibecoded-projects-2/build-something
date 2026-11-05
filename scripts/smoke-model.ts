import { loadConfig } from "../server/config.ts";
import { AnthropicReviewer, estimateCostUsd, type TokenUsage } from "../server/reviewer.ts";

// Sends synthetic source to the real provider and incurs charges. It proves that
// generation and verification work, and nothing about GitHub or the dashboard.
const config = loadConfig();
if (!config.anthropic.apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");

const reviewer = new AnthropicReviewer({
  apiKey: config.anthropic.apiKey,
  workspaceId: config.anthropic.workspaceId,
  model: config.reviewModel,
  maxInputTokens: config.maxReviewInputTokens,
  maxOutputTokens: config.maxReviewOutputTokens,
});

const context = JSON.stringify({
  pullRequest: { title: "Simplify average helper" },
  files: [
    {
      path: "src/average.ts",
      role: "changed",
      status: "modified",
      patch: [
        "@@ -1,4 +1,3 @@",
        " export function average(values: number[]): number {",
        "-  if (values.length === 0) return 0;",
        "   const total = values.reduce((sum, value) => sum + value, 0);",
        "+  const count = values.length;",
        "+  return total / count;",
        " }",
      ].join("\n"),
      source: [
        "export function average(values: number[]): number {",
        "  const total = values.reduce((sum, value) => sum + value, 0);",
        "  const count = values.length;",
        "  return total / count;",
        "}",
      ].join("\n"),
    },
  ],
});

const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const collect = async (next: TokenUsage) => {
  usage.inputTokens += next.inputTokens;
  usage.outputTokens += next.outputTokens;
  usage.cacheReadTokens += next.cacheReadTokens;
  usage.cacheWriteTokens += next.cacheWriteTokens;
};

const generation = await reviewer.generate(context, collect);
const verification = await reviewer.verify(context, generation.findings, [], collect);

console.log(
  JSON.stringify(
    {
      model: reviewer.model,
      candidates: generation.findings.length,
      accepted: verification.acceptedIndices.length,
      usage,
      estimatedCostUsd: estimateCostUsd(reviewer.model, usage),
    },
    null,
    2,
  ),
);
