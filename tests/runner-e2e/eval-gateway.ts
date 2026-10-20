import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { usdToUnits } from "../../packages/shared/src/money.js";
import { estimateProviderCost, ProviderUsageAccumulator, type EvalModelPrice, type ProviderUsageReceipt } from "./provider-usage.js";
import type { EvalChargeIdentity, openEvalCostLedger } from "./cost-ledger.js";

type Ledger = Awaited<ReturnType<typeof openEvalCostLedger>>;
export interface EvalGatewayRoute {
  provider: "openai" | "anthropic";
  mode: "direct" | "braintrust";
  apiKey: string;
  projectId?: string;
  endpointName?: string;
  price: EvalModelPrice;
  /** Verified provider input ceiling, with worst applicable long-context/cache-write prices. */
  maximumInputTokens: number;
  maximumOutputTokens: number;
  timeoutMs: number;
}
export interface EvalGatewayReceipt {
  requestId: string; status?: number; route: "direct" | "braintrust";
  gatewayRequestId?: string; gatewaySpanId?: string; providerRequestId?: string;
  endpoint?: string; cache?: string; failoverFrom?: string; failoverTo?: string; errorOrigin?: string;
  outcome: "succeeded" | "failed" | "cancelled"; errorCode?: string;
  usageComplete: boolean; final: boolean; costUsd: string | null;
  usage?: ProviderUsageReceipt;
}
const money = (n: bigint) => `${n / 1_000_000_000n}.${String(n % 1_000_000_000n).padStart(9, "0")}`;
const safeHeader = (value: string | null) => value && /^[A-Za-z0-9_.:/ -]{1,512}$/.test(value) ? value : undefined;
const row = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Conservative list-price reservation; provider invoices can still differ. */
export function evalRequestReservation(route: EvalGatewayRoute): string {
  if (![route.maximumInputTokens, route.maximumOutputTokens, route.timeoutMs].every(n => Number.isSafeInteger(n) && n > 0)
      || route.timeoutMs > 300_000 || route.provider !== route.price.provider || !route.price.version || !route.price.model) throw new Error("Invalid eval gateway limits");
  const parse = (rate: string) => {
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(rate)) throw new Error("Invalid eval gateway price");
    return usdToUnits(rate);
  };
  if (route.price.longContext && (!Number.isSafeInteger(route.price.longContext.aboveInputTokens) || route.price.longContext.aboveInputTokens < 1)) throw new Error("Invalid long-context threshold");
  const tiers = [route.price, ...(route.price.longContext ? [route.price.longContext.rates] : [])];
  let maximumInputRate = 0n, maximumOutputRate = 0n;
  for (const tier of tiers) {
    const writes = route.provider === "openai" ? [tier.cacheWrite30mUsdPerMillion, tier.cacheWrite12hUsdPerMillion] : [tier.cacheWrite5mUsdPerMillion, tier.cacheWrite1hUsdPerMillion];
    if (writes.some(rate => rate === undefined)) throw new Error("Reservation requires both provider cache-write prices");
    for (const rate of [tier.inputUsdPerMillion, tier.cachedReadUsdPerMillion, ...writes]) {
      const units = parse(rate!); if (units > maximumInputRate) maximumInputRate = units;
    }
    const output = parse(tier.outputUsdPerMillion); if (output > maximumOutputRate) maximumOutputRate = output;
  }
  const numerator = BigInt(route.maximumInputTokens) * maximumInputRate + BigInt(route.maximumOutputTokens) * maximumOutputRate;
  return money((numerator + 999_999n) / 1_000_000n);
}

function boundedPayload(value: unknown, route: EvalGatewayRoute) {
  const body = row(value);
  if (body.model !== route.price.model) throw new Error("unqualified_model");
  if (body.background === true || body.mcp_servers !== undefined || body.service_tier !== undefined && !["auto", "default", "standard_only"].includes(String(body.service_tier))) throw new Error("unqualified_billing_mode");
  if (body.speed !== undefined && body.speed !== "standard" || body.inference_geo !== undefined) throw new Error("unqualified_billing_mode");
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(tool => {
    const type = row(tool).type;
    return route.provider === "openai" ? !["function", "custom"].includes(String(type)) : type !== undefined && type !== "custom";
  }))) throw new Error("unqualified_hosted_tool");
  // This pilot price contract covers text and locally executed tools only.
  const inspect = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(inspect); return; }
    if (!item || typeof item !== "object") return;
    const r = row(item);
    if (["input_image", "input_audio", "input_video", "image", "audio", "document", "video", "input_file"].includes(String(r.type))) throw new Error("unqualified_multimodal_input");
    Object.values(r).forEach(inspect);
  };
  inspect(body);
  const field = route.provider === "openai" ? "max_output_tokens" : "max_tokens";
  if (body[field] !== undefined && (!Number.isSafeInteger(body[field]) || Number(body[field]) < 1)) throw new Error("invalid_output_limit");
  return { ...body, [field]: Math.min(Number(body[field] ?? route.maximumOutputTokens), route.maximumOutputTokens),
    service_tier: route.provider === "openai" ? "default" : "standard_only" };
}

/** Parses SSE event boundaries across arbitrary UTF-8/chunk/CRLF splits. */
export class EvalUsageStream {
  private readonly decoder = new TextDecoder();
  private pending = "";
  constructor(private readonly observe: (value: unknown) => void) {}
  push(bytes: Uint8Array, final = false) {
    this.pending += this.decoder.decode(bytes, { stream: !final });
    if (this.pending.length > 4 * 1024 * 1024) throw new Error("usage_frame_too_large");
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match) break;
      const frame = this.pending.slice(0, match.index); this.pending = this.pending.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (data && data !== "[DONE]") this.observe(JSON.parse(data));
    }
    if (final && this.pending.trim()) throw new Error("incomplete_usage_stream");
  }
}

/** One forwarding attempt, with no hidden retry/fallback and a durable reservation before fetch. */
export async function forwardEvalRequest(input: {
  ledger: Ledger; identity: EvalChargeIdentity; route: EvalGatewayRoute; payload: unknown;
  deadlineAt: number; signal?: AbortSignal; anthropicBeta?: string;
  onHeaders: (status: number, headers: Record<string, string>) => void;
  onChunk: (chunk: Uint8Array) => Promise<void>;
  persist: (receipt: EvalGatewayReceipt) => Promise<void>;
  transport?: typeof fetch;
}): Promise<EvalGatewayReceipt> {
  const { route, ledger } = input;
  const body = boundedPayload(input.payload, route), reservation = evalRequestReservation(route);
  if (!route.apiKey || /[\r\n]/.test(route.apiKey)) throw new Error("missing_gateway_credential");
  if (route.mode === "braintrust" && (!/^[0-9a-f-]{36}$/i.test(route.projectId ?? "") || !/^[A-Za-z0-9_-]+$/.test(route.endpointName ?? ""))) throw new Error("invalid_project_provider");
  if (input.signal?.aborted || Date.now() >= input.deadlineAt) throw new Error("request_deadline_reached");
  const requestId = randomUUID();
  const receipt: EvalGatewayReceipt = { requestId, route: route.mode, outcome: "failed", usageComplete: false, final: false, costUsd: null };
  const usage = new ProviderUsageAccumulator(route.provider);
  await ledger.reserve(requestId, input.identity, reservation);
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1, Math.min(route.timeoutMs, input.deadlineAt - Date.now()))), ...(input.signal ? [input.signal] : [])]);
  let response: Response | undefined;
  try {
    // Checkpoint before any chargeable action. A persistence failure prevents dispatch.
    await input.persist(receipt);
    const headers: Record<string, string> = { "content-type": "application/json", "accept-encoding": "identity" };
    if (route.mode === "braintrust") Object.assign(headers, {
      authorization: `Bearer ${route.apiKey}`, "x-bt-project-id": route.projectId!, "x-bt-endpoint-name": route.endpointName!,
      "x-bt-parent": `project_id:${route.projectId}`, "x-bt-use-cache": "never", "cache-control": "no-cache, no-store",
    });
    else if (route.provider === "openai") headers.authorization = `Bearer ${route.apiKey}`;
    else headers["x-api-key"] = route.apiKey;
    if (route.provider === "anthropic") {
      headers["anthropic-version"] = "2023-06-01";
      if (input.anthropicBeta && /^[A-Za-z0-9, _-]{1,2048}$/.test(input.anthropicBeta)) headers["anthropic-beta"] = input.anthropicBeta;
    }
    const base = route.mode === "braintrust" ? "https://gateway.braintrust.dev" : route.provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1";
    const endpoint = route.provider === "openai" ? "/responses" : "/messages";
    response = await (input.transport ?? fetch)(base + endpoint, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal });
    receipt.status = response.status;
    receipt.gatewayRequestId = safeHeader(response.headers.get("x-bt-request-id"));
    receipt.gatewaySpanId = safeHeader(response.headers.get("x-bt-span-id"));
    receipt.providerRequestId = safeHeader(response.headers.get("x-request-id") ?? response.headers.get("request-id"));
    receipt.endpoint = safeHeader(response.headers.get("x-bt-used-endpoint"));
    receipt.cache = safeHeader(response.headers.get("x-bt-cached"));
    receipt.failoverFrom = safeHeader(response.headers.get("x-bt-failover-from"));
    receipt.failoverTo = safeHeader(response.headers.get("x-bt-failover-to"));
    receipt.errorOrigin = safeHeader(response.headers.get("x-bt-error-origin"));
    await input.persist(receipt);
    if (route.mode === "braintrust" && (receipt.cache === "HIT" || receipt.failoverFrom || receipt.failoverTo
        || response.ok && receipt.endpoint !== route.endpointName)) throw new Error("gateway_route_not_qualified");
    const contentType = response.headers.get("content-type") ?? "application/json";
    input.onHeaders(response.status, { "content-type": contentType, "cache-control": "no-store", "x-paperclip-eval-request-id": requestId });
    const reader = response.body?.getReader();
    const stream = contentType.startsWith("text/event-stream") ? new EvalUsageStream(value => usage.observe(value)) : undefined;
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (reader) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.length; if (size > 32 * 1024 * 1024) throw new Error("response_too_large");
        if (stream) stream.push(next.value); else chunks.push(next.value);
        await input.onChunk(next.value);
      }
      if (stream) stream.push(new Uint8Array(), true);
      else if (size) usage.observe(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } finally { await reader?.cancel().catch(() => {}); }
    receipt.outcome = response.ok ? "succeeded" : "failed";
    if (!response.ok) receipt.errorCode = "upstream_rejected";
  } catch (error) {
    receipt.outcome = signal.aborted ? "cancelled" : "failed";
    // Only our own closed codes are retained. Transport messages may contain secrets.
    const code = error instanceof Error ? error.message : "";
    receipt.errorCode = ["gateway_route_not_qualified", "response_too_large", "usage_frame_too_large", "incomplete_usage_stream"].includes(code) ? code : signal.aborted ? "request_cancelled" : "request_failed";
  } finally {
    abort.abort();
    await response?.body?.cancel().catch(() => {});
    const observed = usage.receipt();
    receipt.usage = observed;
    receipt.usageComplete = observed.complete;
    receipt.final = observed.final;
    receipt.costUsd = estimateProviderCost(observed, route.price);
    // A transport-complete body with no priceable usage remains unknown, not free.
    await ledger.observe({ observationId: `${requestId}:usage`, requestId, source: route.mode === "braintrust" ? "gateway" : "provider",
      provider: route.provider, model: observed.model ?? route.price.model,
      ...(receipt.providerRequestId ? { providerRequestId: receipt.providerRequestId } : {}),
      currency: "USD", route: route.mode, classification: receipt.costUsd === null ? "unknown" : "estimated",
      ...(receipt.costUsd !== null ? { costUsd: receipt.costUsd, pricingVersion: route.price.version } : {}), tokens: observed.tokens, final: observed.final });
    await ledger.finish(requestId, receipt.outcome);
    await input.persist(receipt);
  }
  return receipt;
}

async function requestJson(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Loopback-only adapter endpoint. The agent receives an ephemeral token, never the upstream key. */
export async function startEvalGateway(input: Omit<Parameters<typeof forwardEvalRequest>[0], "payload" | "onHeaders" | "onChunk" | "signal" | "anthropicBeta">) {
  const token = randomBytes(32).toString("hex"), pending = new Set<Promise<void>>(), controllers = new Set<AbortController>();
  let closed = false, poisoned = false;
  const respond = (res: ServerResponse, status: number, code: string) => {
    if (!res.headersSent) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "eval_gateway", message: code } })); }
    else res.destroy();
  };
  const server = createServer((req, res) => {
    const operation = (async () => {
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "") || String(req.headers["x-api-key"] ?? "");
      if (Buffer.byteLength(auth) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(auth), Buffer.from(token))) { respond(res, 401, "unauthorized"); return; }
      const endpoint = input.route.provider === "openai" ? "responses" : "messages";
      if (closed || poisoned) { respond(res, 503, "gateway_unavailable"); return; }
      if (req.method !== "POST" || ![`/${endpoint}`, `/v1/${endpoint}`].includes(req.url ?? "")) { respond(res, 404, "unqualified_endpoint"); return; }
      const abort = new AbortController(); controllers.add(abort);
      const onClose = () => { if (!res.writableEnded) abort.abort(); }; res.on("close", onClose);
      try {
        const receipt = await forwardEvalRequest({ ...input, payload: await requestJson(req), signal: abort.signal,
          anthropicBeta: typeof req.headers["anthropic-beta"] === "string" ? req.headers["anthropic-beta"] : undefined,
          onHeaders: (status, headers) => { res.writeHead(status, headers); },
          onChunk: async chunk => { if (!res.write(chunk)) await once(res, "drain", { signal: abort.signal }); },
        });
        if (receipt.outcome === "succeeded" || receipt.errorCode === "upstream_rejected") res.end();
        else respond(res, 502, receipt.errorCode ?? "request_failed");
      } catch {
        // Ledger or receipt persistence failure must stop every later admission.
        poisoned = true; respond(res, 503, "eval_admission_or_persistence_failed");
      } finally { controllers.delete(abort); res.off("close", onClose); }
    })();
    pending.add(operation); void operation.then(() => pending.delete(operation), () => { poisoned = true; respond(res, 503, "gateway_unavailable"); pending.delete(operation); });
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Eval gateway did not bind loopback");
  return { baseUrl: `http://127.0.0.1:${address.port}`, token,
    async close() { closed = true; controllers.forEach(controller => controller.abort()); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await Promise.allSettled([...pending]); },
  };
}
