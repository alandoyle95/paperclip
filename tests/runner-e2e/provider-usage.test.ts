import { expect, it } from "vitest";
import { estimateProviderCost, normalizeProviderUsage, ProviderUsageAccumulator, type EvalModelPrice } from "./provider-usage.js";
const price: EvalModelPrice = { provider: "openai", model: "fixture", version: "fixture-1", sourceUrl: "https://provider.test/prices", inputUsdPerMillion: "2.5", cachedReadUsdPerMillion: "0.25", outputUsdPerMillion: "10", cacheWrite30mUsdPerMillion: "2", cacheWrite12hUsdPerMillion: "2" };

it("excludes cached reads from OpenAI input and treats reasoning as a subset of output", () => {
  const usage = normalizeProviderUsage("openai", { id: "response", model: "fixture", usage: { input_tokens: 100, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 40 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 15 } } });
  expect(usage).toMatchObject({ complete: true, tokens: { input: 60, cachedRead: 40, cachedWrite: 0, output: 20, reasoning: 15 } });
  expect(estimateProviderCost(usage, price)).toBe("0.000360000");
});
it("never turns missing usage or incompatible model/pricing into a free charge", () => {
  const absent = normalizeProviderUsage("openai", { model: "fixture", usage: { input_tokens: 0, output_tokens: 0 } });
  expect(absent.complete).toBe(false);
  expect(estimateProviderCost(absent, price)).toBeNull();
  const zero = normalizeProviderUsage("openai", { model: "fixture", usage: { input_tokens: 0, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 }, output_tokens: 0 } });
  expect(estimateProviderCost(zero, price)).toBe("0.000000000");
  expect(estimateProviderCost(zero, { ...price, model: "other" })).toBeNull();
});
it("does not add Anthropic cumulative output counters and prices cache writes by TTL", () => {
  const stream = new ProviderUsageAccumulator("anthropic");
  stream.observe({ type: "message_start", message: { id: "message", model: "fixture", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 } } } });
  stream.observe({ type: "message_delta", usage: { output_tokens: 5 } });
  stream.observe({ type: "message_delta", usage: { output_tokens: 8 } });
  expect(stream.receipt().final).toBe(false);
  stream.observe({ type: "message_stop" });
  expect(stream.receipt()).toMatchObject({ final: true, complete: true, tokens: { input: 10, cachedRead: 20, cachedWrite: 30, output: 8 } });
  expect(estimateProviderCost(stream.receipt(), { ...price, provider: "anthropic", cacheWrite5mUsdPerMillion: "3.125", cacheWrite1hUsdPerMillion: "5" })).toBe("0.000222500");
});
it("retains missing cache TTL and malformed token subsets as unknown", () => {
  const write = normalizeProviderUsage("anthropic", { model: "fixture", usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 4, output_tokens: 1 } });
  expect(estimateProviderCost(write, { ...price, provider: "anthropic" })).toBeNull();
  expect(normalizeProviderUsage("openai", { usage: { input_tokens: 1, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 2 }, output_tokens: 1 } }).complete).toBe(false);
  expect(normalizeProviderUsage("openai", { usage: { input_tokens: 1, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 2 } } }).complete).toBe(false);
});
it("uses one terminal Responses usage receipt regardless of streamed text or repeat notifications", () => {
  const stream = new ProviderUsageAccumulator("openai");
  stream.observe({ type: "response.output_text.delta", delta: "not a usage receipt" });
  expect(stream.receipt().complete).toBe(false);
  const terminal = { type: "response.completed", response: { id: "response", model: "fixture", usage: { input_tokens: 1, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 }, output_tokens: 1 } } };
  stream.observe(terminal); stream.observe(terminal);
  expect(stream.receipt()).toMatchObject({ final: true, complete: true, tokens: { input: 1, output: 1 } });
  expect(estimateProviderCost(stream.receipt(), price)).toBe("0.000012500");
});

const modernPrice: EvalModelPrice = { ...price, inputUsdPerMillion: "4", cachedReadUsdPerMillion: "0.4", outputUsdPerMillion: "20",
  cacheWrite30mUsdPerMillion: "5", cacheWrite12hUsdPerMillion: "10",
  longContext: { aboveInputTokens: 272_000, rates: { inputUsdPerMillion: "8", cachedReadUsdPerMillion: "0.8", outputUsdPerMillion: "30", cacheWrite30mUsdPerMillion: "10", cacheWrite12hUsdPerMillion: "20" } } };
const modernUsage = (total = 12_000, read = 4000, shortWrite = 3000, longWrite = 4000) => ({ model: "fixture", usage: {
  input_tokens: total, input_tokens_details: { cached_tokens: read, cache_write_tokens: shortWrite + longWrite,
    cache_write_tokens_details: { ttl_30m_tokens: shortWrite, ttl_12h_tokens: longWrite } }, output_tokens: 100,
} });
it("separates modern OpenAI ordinary input and mixed-TTL writes without adding the base rate twice", () => {
  const receipt = normalizeProviderUsage("openai", modernUsage());
  expect(receipt).toMatchObject({ complete: true, tokens: { input: 1000, cachedRead: 4000, cachedWrite: 7000 }, cacheWrite30m: 3000, cacheWrite12h: 4000 });
  expect(estimateProviderCost(receipt, modernPrice)).toBe("0.062600000");
});
it("applies long-context pricing to the entire request using total input including cache", () => {
  expect(estimateProviderCost(normalizeProviderUsage("openai", modernUsage(272_000, 270_000, 0, 1000)), modernPrice)).toBe("0.124000000");
  expect(estimateProviderCost(normalizeProviderUsage("openai", modernUsage(272_001, 270_000, 0, 1000)), modernPrice)).toBe("0.247008000");
});
it("keeps missing modern write counters or missing/inconsistent TTL splits unknown", () => {
  const missing = modernUsage(); delete (missing.usage.input_tokens_details as any).cache_write_tokens;
  expect(normalizeProviderUsage("openai", missing).complete).toBe(false);
  expect(estimateProviderCost(normalizeProviderUsage("openai", missing), modernPrice)).toBeNull();
  const noTtl = modernUsage(); delete (noTtl.usage.input_tokens_details as any).cache_write_tokens_details;
  expect(estimateProviderCost(normalizeProviderUsage("openai", noTtl), modernPrice)).toBeNull();
  const mismatch = modernUsage(); mismatch.usage.input_tokens_details.cache_write_tokens_details.ttl_12h_tokens++;
  expect(normalizeProviderUsage("openai", mismatch).complete).toBe(false);
});
