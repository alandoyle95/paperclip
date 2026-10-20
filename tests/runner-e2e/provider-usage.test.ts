import { expect, it } from "vitest";
import { estimateProviderCost, normalizeProviderUsage, ProviderUsageAccumulator, type EvalModelPrice } from "./provider-usage.js";
const price: EvalModelPrice = { provider: "openai", model: "fixture", version: "fixture-1", sourceUrl: "https://provider.test/prices", inputUsdPerMillion: "2.5", cachedReadUsdPerMillion: "0.25", outputUsdPerMillion: "10" };

it("excludes cached reads from OpenAI input and treats reasoning as a subset of output", () => {
  const usage = normalizeProviderUsage("openai", { id: "response", model: "fixture", usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 15 } } });
  expect(usage).toMatchObject({ complete: true, tokens: { input: 60, cachedRead: 40, cachedWrite: 0, output: 20, reasoning: 15 } });
  expect(estimateProviderCost(usage, price)).toBe("0.000360000");
});
it("never turns missing usage or incompatible model/pricing into a free charge", () => {
  const absent = normalizeProviderUsage("openai", { model: "fixture", usage: { input_tokens: 0, output_tokens: 0 } });
  expect(absent.complete).toBe(false);
  expect(estimateProviderCost(absent, price)).toBeNull();
  const zero = normalizeProviderUsage("openai", { model: "fixture", usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0 } });
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
  expect(normalizeProviderUsage("openai", { usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 2 }, output_tokens: 1 } }).complete).toBe(false);
  expect(normalizeProviderUsage("openai", { usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 2 } } }).complete).toBe(false);
});
it("uses one terminal Responses usage receipt regardless of streamed text or repeat notifications", () => {
  const stream = new ProviderUsageAccumulator("openai");
  stream.observe({ type: "response.output_text.delta", delta: "not a usage receipt" });
  expect(stream.receipt().complete).toBe(false);
  const terminal = { type: "response.completed", response: { id: "response", model: "fixture", usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1 } } };
  stream.observe(terminal); stream.observe(terminal);
  expect(stream.receipt()).toMatchObject({ final: true, complete: true, tokens: { input: 1, output: 1 } });
  expect(estimateProviderCost(stream.receipt(), price)).toBe("0.000012500");
});
