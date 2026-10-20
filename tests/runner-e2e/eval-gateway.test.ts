import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openEvalCostLedger, readEvalCostLedger } from "./cost-ledger.js";
import { evalRequestReservation, EvalUsageStream, forwardEvalRequest, startEvalGateway, type EvalGatewayRoute, type EvalGatewayReceipt } from "./eval-gateway.js";
const directories: string[] = [], closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const identity = { executionId: "hello", attemptId: "attempt", phase: "agent" as const };
const route: EvalGatewayRoute = { provider: "openai", mode: "braintrust", apiKey: "private-upstream-fixture", projectId: "11111111-1111-4111-8111-111111111111", endpointName: "OPENAI_API_KEY",
  maximumInputTokens: 1000, maximumOutputTokens: 100, timeoutMs: 2000,
  price: { provider: "openai", model: "fixture", version: "fixture-1", sourceUrl: "https://provider.invalid/prices", inputUsdPerMillion: "2", cachedReadUsdPerMillion: "1", outputUsdPerMillion: "10", cacheWrite30mUsdPerMillion: "2", cacheWrite12hUsdPerMillion: "2" } };
const usage = { object: "response", status: "completed", id: "provider-response", model: "fixture", usage: { input_tokens: 10, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 2 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } } };
const response = () => Response.json(usage, { headers: { "x-bt-used-endpoint": "OPENAI_API_KEY", "x-bt-cached": "MISS", "x-bt-request-id": "gateway-request", "x-bt-span-id": "gateway-span" } });
async function fixture(maxUsd = "1") {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-forward-test-")); directories.push(dir);
  const file = path.join(dir, "ledger.jsonl"), deadlineAt = Date.now() + 30_000;
  const ledger = await openEvalCostLedger(file, { campaignId: "campaign", maxUsd, deadlineAt: new Date(deadlineAt).toISOString(), maxRequests: 10, maxConcurrent: 2 });
  closes.push(() => ledger.close());
  const receipts: EvalGatewayReceipt[] = [];
  return { ledger, file, deadlineAt, identity, route, receipts, payload: { model: "fixture", input: "hello", max_output_tokens: 500 },
    persist: async (receipt: EvalGatewayReceipt) => { receipts.push(structuredClone(receipt)); }, onHeaders: vi.fn(), onChunk: vi.fn(async () => {}) };
}
it("fsyncs reservation before dispatch, pins gateway routing, and replaces reservation with one estimate", async () => {
  const f = await fixture();
  let captured: RequestInit | undefined;
  let reservedBeforeDispatch = false;
  const transport = vi.fn<typeof fetch>(async (_url, init) => { captured = init; reservedBeforeDispatch = (await readEvalCostLedger(f.file)).state.snapshot().inflight === 1; return response(); });
  const result = await forwardEvalRequest({ ...f, transport });
  expect(reservedBeforeDispatch).toBe(true);
  expect(transport.mock.calls[0]![0]).toBe("https://gateway.braintrust.dev/responses");
  expect(captured).toMatchObject({ redirect: "error", headers: { authorization: `Bearer ${route.apiKey}`, "x-bt-use-cache": "never", "cache-control": "no-cache, no-store", "x-bt-project-id": route.projectId, "x-bt-endpoint-name": route.endpointName, "x-bt-parent": `project_id:${route.projectId}` } });
  expect(JSON.parse(captured!.body as string)).toMatchObject({ max_output_tokens: 100, service_tier: "default" });
  expect(result).toMatchObject({ outcome: "succeeded", costUsd: "0.000068000", final: true, usageComplete: true, gatewaySpanId: "gateway-span" });
  expect(f.ledger.snapshot()).toMatchObject({ knownUsd: "0.000068000", heldUsd: "0.000000000", inflight: 0 });
  expect(await readFile(f.file, "utf8")).not.toContain(route.apiKey);
});
it("stops at the campaign cap before any upstream request", async () => {
  const f = await fixture("0.002"), transport = vi.fn<typeof fetch>();
  expect(evalRequestReservation(route)).toBe("0.003000000");
  await expect(forwardEvalRequest({ ...f, transport })).rejects.toThrow("spending cap");
  expect(transport).not.toHaveBeenCalled();
});
it("retains cancelled and provider-error requests as unknown, including repeated retries", async () => {
  const f = await fixture();
  const first = await forwardEvalRequest({ ...f, transport: async () => { throw new Error(route.apiKey); } });
  const second = await forwardEvalRequest({ ...f, transport: async () => Response.json({ error: "private-provider-message" }, { status: 429 }) });
  expect(first).toMatchObject({ outcome: "failed", errorCode: "request_failed", costUsd: null });
  expect(second).toMatchObject({ outcome: "failed", errorCode: "upstream_rejected", costUsd: null });
  expect(first.requestId).not.toBe(second.requestId);
  expect(f.ledger.snapshot()).toMatchObject({ heldUsd: "0.006000000", knownUsd: "0.000000000", unknownRequests: 2 });
  expect(JSON.stringify(f.receipts)).not.toMatch(/private-upstream|private-provider-message/);
});
it.each([
  { model: "other" }, { model: "fixture", background: true }, { model: "fixture", service_tier: "priority" },
  { model: "fixture", tools: [{ type: "web_search" }] }, { model: "fixture", input: [{ type: "input_image", image_url: "https://image.invalid" }] },
  { model: "fixture", speed: "fast" }, { model: "fixture", inference_geo: "us" },
])("rejects unpriced request shapes before admission", async payload => {
  const f = await fixture(), transport = vi.fn<typeof fetch>();
  await expect(forwardEvalRequest({ ...f, payload, transport })).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled(); expect(f.ledger.snapshot().requests).toHaveLength(0);
});
it("does not dispatch when the private pre-request receipt cannot be persisted", async () => {
  const f = await fixture(), transport = vi.fn<typeof fetch>();
  await expect(forwardEvalRequest({ ...f, persist: async () => { throw new Error("disk unavailable"); }, transport })).rejects.toThrow("disk unavailable");
  expect(transport).not.toHaveBeenCalled();
  expect(f.ledger.snapshot()).toMatchObject({ unknownRequests: 1, heldUsd: "0.003000000" });
});
it("parses actual fragmented SSE without summing cumulative counters", async () => {
  const f = await fixture();
  const wire = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello 👋" })}\r\n\r\ndata: ${JSON.stringify({ type: "response.completed", response: usage })}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const bytes = Buffer.from(wire);
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3)); controller.close(); } });
  const result = await forwardEvalRequest({ ...f, transport: async () => new Response(body, { headers: { "content-type": "text/event-stream", "x-bt-used-endpoint": "OPENAI_API_KEY" } }) });
  expect(result).toMatchObject({ costUsd: "0.000068000", final: true });
  expect(f.onChunk.mock.calls.length).toBeGreaterThan(1);
  const truncated = new EvalUsageStream(() => {});
  expect(() => truncated.push(Buffer.from('data: {"type":"response.completed"}'), true)).toThrow("incomplete_usage_stream");
});
it.each([{ "x-bt-cached": "HIT" }, { "x-bt-used-endpoint": "FOREIGN" }, { "x-bt-failover-to": "fixture/FOREIGN" }])("rejects cached/failover/foreign route evidence without releasing the reservation", async headers => {
  const f = await fixture();
  const result = await forwardEvalRequest({ ...f, transport: async () => Response.json(usage, { headers: Object.fromEntries(Object.entries({ "x-bt-used-endpoint": "OPENAI_API_KEY", ...headers }).filter((pair): pair is [string, string] => pair[1] !== undefined)) }) });
  expect(result).toMatchObject({ outcome: "failed", errorCode: "gateway_route_not_qualified", costUsd: null });
  expect(f.onChunk).not.toHaveBeenCalled();
  expect(f.ledger.snapshot().heldUsd).toBe("0.003000000");
});
it("uses the loopback gateway through real HTTP while withholding upstream credentials from the client", async () => {
  const f = await fixture();
  const transport = vi.fn<typeof fetch>(async () => response());
  const gateway = await startEvalGateway({ ...f, transport }); closes.push(() => gateway.close());
  const denied = await fetch(`${gateway.baseUrl}/v1/responses`, { method: "POST", body: "{}" });
  expect(denied.status).toBe(401); expect(transport).not.toHaveBeenCalled();
  const accepted = await fetch(`${gateway.baseUrl}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" }, body: JSON.stringify(f.payload) });
  expect(accepted.status).toBe(200); expect(await accepted.json()).toEqual(usage);
  expect(gateway.token).not.toBe(route.apiKey);
  expect(accepted.headers.get("x-paperclip-eval-request-id")).toBeTruthy();
  expect([...accepted.headers.values()].join(" ")).not.toContain(route.apiKey);
});

it("reserves the highest cache-write and long-context rates before dispatch", () => {
  expect(evalRequestReservation({ ...route, price: { ...route.price, cacheWrite12hUsdPerMillion: "5",
    longContext: { aboveInputTokens: 100, rates: { inputUsdPerMillion: "4", cachedReadUsdPerMillion: "2", cacheWrite30mUsdPerMillion: "5", cacheWrite12hUsdPerMillion: "10", outputUsdPerMillion: "15" } } } })).toBe("0.011500000");
  expect(() => evalRequestReservation({ ...route, price: { ...route.price, cacheWrite12hUsdPerMillion: undefined } })).toThrow("both provider cache-write");
});
it("propagates cancellation to an in-flight upstream request and retains its reservation", async () => {
  const f = await fixture(), controller = new AbortController();
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    controller.abort();
    init!.signal!.throwIfAborted();
    throw new Error("unreachable");
  });
  const receipt = await forwardEvalRequest({ ...f, signal: controller.signal, transport });
  expect(receipt).toMatchObject({ outcome: "cancelled", errorCode: "request_cancelled", final: false, costUsd: null });
  expect(transport).toHaveBeenCalledOnce();
  expect(f.ledger.snapshot()).toMatchObject({ heldUsd: "0.003000000", unknownRequests: 1, inflight: 0 });
});
it("does not release a reservation for an otherwise final response missing cache-write usage", async () => {
  const f = await fixture(), body = structuredClone(usage);
  delete (body.usage.input_tokens_details as any).cache_write_tokens;
  const receipt = await forwardEvalRequest({ ...f, transport: async () => Response.json(body, { headers: { "x-bt-used-endpoint": "OPENAI_API_KEY" } }) });
  expect(receipt).toMatchObject({ outcome: "succeeded", usageComplete: false, final: true, costUsd: null });
  expect(f.ledger.snapshot()).toMatchObject({ heldUsd: "0.003000000", unknownRequests: 1 });
});
it.each([{ version: "prices with spaces" }, { model: "model with spaces" }])("rejects invalid ledger price identities before reserving or dispatching", async invalid => {
  const f = await fixture(), transport = vi.fn<typeof fetch>();
  const price = { ...route.price, ...invalid };
  await expect(forwardEvalRequest({ ...f, route: { ...route, price }, payload: { model: price.model }, transport })).rejects.toThrow("price identity");
  expect(transport).not.toHaveBeenCalled();
  expect(f.ledger.snapshot().requests).toHaveLength(0);
});
it("retains invalid reasoning counters privately and finishes an unknown charge", async () => {
  const f = await fixture(), body = structuredClone(usage);
  body.usage.output_tokens_details.reasoning_tokens = 6;
  const receipt = await forwardEvalRequest({ ...f, transport: async () => Response.json(body, { headers: { "x-bt-used-endpoint": "OPENAI_API_KEY" } }) });
  expect(receipt).toMatchObject({ outcome: "succeeded", errorCode: "invalid_usage", usageComplete: false, final: true, costUsd: null,
    usage: { tokens: { output: 5, reasoning: 6 } } });
  expect(f.receipts.at(-1)).toEqual(receipt);
  expect(f.ledger.snapshot()).toMatchObject({ heldUsd: "0.003000000", unknownRequests: 1, inflight: 0 });
  const journal = await readFile(f.file, "utf8");
  expect(journal).not.toContain('"reasoning":6');
  expect(journal).toContain('"type":"finish"');
});
it("retains malformed provider identifiers without losing the final receipt or ledger finish", async () => {
  const f = await fixture();
  const receipt = await forwardEvalRequest({ ...f, transport: async () => Response.json({ ...usage, model: "unexpected model name" },
    { headers: { "x-bt-used-endpoint": "OPENAI_API_KEY", "x-request-id": "request with spaces" } }) });
  expect(receipt).toMatchObject({ providerRequestId: "request with spaces", usage: { model: "unexpected model name" }, final: true, costUsd: null });
  expect(f.receipts.at(-1)).toEqual(receipt);
  expect(f.ledger.snapshot()).toMatchObject({ heldUsd: "0.003000000", unknownRequests: 1, inflight: 0 });
});
