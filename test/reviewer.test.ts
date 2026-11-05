import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../server/config.ts";
import {
  AnthropicReviewer,
  createReviewModel,
  estimateCostUsd,
  generationPrompt,
  pricingFor,
  reservationUsd,
  SYSTEM_PROMPT,
  verificationPrompt,
  type TokenUsage,
} from "../server/reviewer.ts";

const MODEL = "claude-opus-5-5";
const validOutput = JSON.stringify({ summary: "All good.", findings: [] });

interface Responses {
  count?: () => Response;
  message?: () => Response;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const messageBody = (text: string, stop_reason = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: MODEL,
  stop_reason,
  content: [
    { type: "thinking", thinking: "...", signature: "sig" },
    { type: "text", text },
  ],
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 20,
  },
});

function reviewer(responses: Responses = {}, overrides = {}) {
  const requests: Array<{ url: string; body: any; headers: Headers }> = [];
  const fetchStub = vi.fn(async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    const headers = new Headers(init?.headers);
    requests.push({ url, body: JSON.parse(init.body), headers });
    if (url.includes("count_tokens")) {
      return responses.count?.() ?? json({ input_tokens: 500 });
    }
    return responses.message?.() ?? json(messageBody(validOutput));
  });
  const instance = new AnthropicReviewer({
    apiKey: "test-key",
    model: MODEL,
    maxInputTokens: 1000,
    maxOutputTokens: 800,
    fetch: fetchStub as unknown as typeof fetch,
    ...overrides,
  });
  return { instance, requests, fetchStub };
}

const usageSink = () => {
  const seen: TokenUsage[] = [];
  return { seen, sink: async (usage: TokenUsage) => void seen.push(usage) };
};

describe("pricing", () => {
  it("rejects a model with no pricing", () => {
    expect(() => pricingFor("some-other-model")).toThrow("MODEL_PRICING_NOT_CONFIGURED");
  });

  it("estimates cost from usage", () => {
    const cost = estimateCostUsd(MODEL, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(29.2);
  });

  it("reserves for two passes across three attempts", () => {
    expect(reservationUsd(MODEL, 100_000, 8_000)).toBeCloseTo(3.36);
  });
});

describe("prompts", () => {
  it("treats repository content as untrusted", () => {
    expect(SYSTEM_PROMPT).toContain("UNTRUSTED DATA");
  });

  it("wraps context", () => {
    expect(generationPrompt("{}")).toContain("<context>\n{}\n</context>");
  });

  it("caps previous findings at 50", () => {
    const previous = Array.from({ length: 60 }, (_, index) => ({
      id: `f${index}`,
      title: "t",
      body: "b",
      path: "p",
      line: 1,
      outcome: "open",
    }));
    const prompt = verificationPrompt("{}", [], previous);
    expect(prompt).toContain('"f49"');
    expect(prompt).not.toContain('"f50"');
  });
});

describe("AnthropicReviewer", () => {
  it("counts tokens first and requests structured adaptive high effort output", async () => {
    const { instance, requests } = reviewer();
    const { seen, sink } = usageSink();
    const result = await instance.generate("{}", sink);

    expect(result).toEqual({ summary: "All good.", findings: [] });
    expect(requests[0]?.url).toContain("count_tokens");
    expect(requests[1]?.body).toMatchObject({
      model: MODEL,
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema" } },
    });
    expect(seen).toEqual([
      { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 10, cacheWriteTokens: 20 },
    ]);
  });

  it("sends the workspace header only when configured", async () => {
    const withoutHeader = reviewer();
    await withoutHeader.instance.generate("{}", usageSink().sink);
    expect(withoutHeader.requests[0]?.headers.has("anthropic-workspace-id")).toBe(false);

    const withHeader = reviewer({}, { workspaceId: "wrkspc_1" });
    await withHeader.instance.generate("{}", usageSink().sink);
    expect(withHeader.requests[0]?.headers.get("anthropic-workspace-id")).toBe("wrkspc_1");
  });

  it("refuses oversized input before paying for generation", async () => {
    const { instance, requests } = reviewer({ count: () => json({ input_tokens: 1001 }) });
    await expect(instance.generate("{}", usageSink().sink)).rejects.toMatchObject({
      code: "CONTEXT_TOKEN_LIMIT",
      retryable: false,
    });
    expect(requests).toHaveLength(1);
  });

  it("records usage when paid output is invalid", async () => {
    const { instance } = reviewer({ message: () => json(messageBody("not json")) });
    const { seen, sink } = usageSink();
    await expect(instance.generate("{}", sink)).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    expect(seen).toHaveLength(1);
  });

  it("rejects output that fails the schema", async () => {
    const output = JSON.stringify({
      summary: "x",
      findings: [{ severity: "low" }],
    });
    const { instance } = reviewer({ message: () => json(messageBody(output)) });
    await expect(instance.generate("{}", usageSink().sink)).rejects.toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
    });
  });

  it("rejects an incomplete response and keeps its usage", async () => {
    const { instance } = reviewer({ message: () => json(messageBody(validOutput, "max_tokens")) });
    const { seen, sink } = usageSink();
    await expect(instance.generate("{}", sink)).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    expect(seen).toHaveLength(1);
  });

  it("does not let the SDK retry on its own", async () => {
    const { instance, fetchStub } = reviewer({
      count: () => json({ error: { type: "rate_limit_error", message: "slow down" } }, 429),
    });
    await expect(instance.generate("{}", usageSink().sink)).rejects.toMatchObject({
      code: "MODEL_RATE_LIMITED",
      retryable: true,
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "MODEL_ACCESS_DENIED", false],
    [403, "MODEL_ACCESS_DENIED", false],
    [400, "MODEL_REQUEST_FAILED", false],
    [500, "MODEL_REQUEST_FAILED", true],
    [529, "MODEL_RATE_LIMITED", true],
  ])("maps HTTP %i to %s without the provider message", async (status, code, retryable) => {
    const { instance } = reviewer({
      message: () => json({ error: { type: "error", message: "provider detail" } }, status),
    });
    const error = await instance.generate("{}", usageSink().sink).catch((caught) => caught);
    expect(error).toMatchObject({ code, retryable });
    expect(error.message).not.toContain("provider detail");
  });

  it("parses verification output", async () => {
    const output = JSON.stringify({
      acceptedIndices: [0],
      summary: "One defect.",
      previousFindings: [{ id: "f1", outcome: "suspected_fixed", evidence: "guard restored" }],
    });
    const { instance } = reviewer({ message: () => json(messageBody(output)) });
    const result = await instance.verify("{}", [], [], usageSink().sink);
    expect(result.acceptedIndices).toEqual([0]);
  });
});

describe("createReviewModel", () => {
  it("is null without an API key", () => {
    const config = parseConfig({ ADMIN_PASSWORD: "correct-horse-battery-staple" });
    expect(createReviewModel(config)).toBeNull();
  });
});
