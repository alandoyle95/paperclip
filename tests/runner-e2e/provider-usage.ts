import { usdToUnits } from "../../packages/shared/src/money.js";
import type { EvalCostObservation } from "./cost-ledger.js";

type Tokens = NonNullable<EvalCostObservation["tokens"]>;
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export interface ProviderUsageReceipt {
  provider: "openai" | "anthropic";
  tokens: Tokens;
  complete: boolean;
  providerResponseId?: string;
  model?: string;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheWrite30m?: number;
  cacheWrite12h?: number;
}

/** Parse provider cumulative totals. Never sum intermediate stream counters. */
export function normalizeProviderUsage(provider: "openai" | "anthropic", payload: unknown): ProviderUsageReceipt {
  const body = row(payload), usage = row(body.usage);
  const output = count(usage.output_tokens);
  let tokens: Tokens;
  let cacheWrite5m: number | undefined, cacheWrite1h: number | undefined;
  let cacheWrite30m: number | undefined, cacheWrite12h: number | undefined;
  if (provider === "openai") {
    const totalInput = count(usage.input_tokens);
    const details = row(usage.input_tokens_details);
    const cachedRead = count(details.cached_tokens);
    let cachedWrite = count(details.cache_write_tokens);
    const writes = row(details.cache_write_tokens_details);
    cacheWrite30m = count(writes.ttl_30m_tokens);
    cacheWrite12h = count(writes.ttl_12h_tokens);
    if (cachedWrite !== undefined && cacheWrite30m !== undefined && cacheWrite12h !== undefined && cacheWrite30m + cacheWrite12h !== cachedWrite) cachedWrite = undefined;
    const reasoning = count(row(usage.output_tokens_details).reasoning_tokens);
    // Modern Responses models bill writes separately. Missing write counters are
    // unknown; an older model needs a separately qualified pricing contract.
    tokens = { input: totalInput !== undefined && cachedRead !== undefined && cachedWrite !== undefined && totalInput >= cachedRead + cachedWrite ? totalInput - cachedRead - cachedWrite : undefined,
      cachedRead, cachedWrite, output, reasoning };
  } else {
    const cache = row(usage.cache_creation);
    cacheWrite5m = count(cache.ephemeral_5m_input_tokens);
    cacheWrite1h = count(cache.ephemeral_1h_input_tokens);
    tokens = { input: count(usage.input_tokens), cachedRead: count(usage.cache_read_input_tokens), cachedWrite: count(usage.cache_creation_input_tokens), output };
    if (tokens.cachedWrite !== undefined && cacheWrite5m !== undefined && cacheWrite1h !== undefined && cacheWrite5m + cacheWrite1h !== tokens.cachedWrite) tokens.cachedWrite = undefined;
  }
  const complete = tokens.input !== undefined && tokens.cachedRead !== undefined && tokens.cachedWrite !== undefined && output !== undefined
    && !(tokens.reasoning !== undefined && tokens.reasoning > output);
  return { provider, tokens: Object.fromEntries(Object.entries(tokens).filter(([, value]) => value !== undefined)), complete,
    ...(typeof body.id === "string" ? { providerResponseId: body.id } : {}),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(cacheWrite5m !== undefined ? { cacheWrite5m } : {}), ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
    ...(cacheWrite30m !== undefined ? { cacheWrite30m } : {}), ...(cacheWrite12h !== undefined ? { cacheWrite12h } : {}) };
}

/** Anthropic message_start/delta usage fields are cumulative snapshots of one request. */
export class ProviderUsageAccumulator {
  private body: Row = {};
  private usage: Row = {};
  private final = false;
  constructor(readonly provider: "openai" | "anthropic") {}
  observe(event: unknown) {
    const value = row(event);
    if (this.provider === "openai") {
      const response = row(value.response);
      if (["response.completed", "response.incomplete", "response.failed"].includes(String(value.type))) {
        this.body = response;
        this.usage = row(response.usage);
        this.final = true;
      } else if (value.object === "response") {
        this.body = value;
        this.usage = row(value.usage);
        this.final = ["completed", "incomplete", "failed"].includes(String(value.status));
      }
    } else {
      if (value.type === "message_start") {
        this.body = row(value.message);
        this.usage = { ...this.usage, ...row(this.body.usage) };
      } else if (value.type === "message_delta") this.usage = { ...this.usage, ...row(value.usage) };
      else if (value.type === "message_stop") this.final = true;
      else if (value.type === "message") { this.body = value; this.usage = row(value.usage); this.final = true; }
    }
  }
  receipt() { return { ...normalizeProviderUsage(this.provider, { ...this.body, usage: this.usage }), final: this.final }; }
}

export interface EvalTokenRates {
  inputUsdPerMillion: string;
  cachedReadUsdPerMillion: string;
  outputUsdPerMillion: string;
  cacheWrite5mUsdPerMillion?: string;
  cacheWrite1hUsdPerMillion?: string;
  cacheWrite30mUsdPerMillion?: string;
  cacheWrite12hUsdPerMillion?: string;
}
export interface EvalModelPrice extends EvalTokenRates {
  provider: "openai" | "anthropic";
  model: string;
  version: string;
  sourceUrl: string;
  /** Applies to the entire request when total input (including cache) exceeds it. */
  longContext?: { aboveInputTokens: number; rates: EvalTokenRates };
}

/** List-price estimate, never a provider-reported or reconciled charge. */
export function estimateProviderCost(receipt: ProviderUsageReceipt, price: EvalModelPrice): string | null {
  if (!receipt.complete || receipt.model !== price.model || receipt.provider !== price.provider) return null;
  const { tokens } = receipt;
  const totalInput = tokens.input! + tokens.cachedRead! + tokens.cachedWrite!;
  if (!Number.isSafeInteger(totalInput)) return null;
  const rates = price.longContext && totalInput > price.longContext.aboveInputTokens ? price.longContext.rates : price;
  const priced = (count: number, rate: string) => {
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(rate)) throw new Error("Invalid nonnegative model price");
    return BigInt(count) * usdToUnits(rate);
  };
  let numerator = priced(tokens.input!, rates.inputUsdPerMillion) + priced(tokens.cachedRead!, rates.cachedReadUsdPerMillion) + priced(tokens.output!, rates.outputUsdPerMillion);
  if (tokens.cachedWrite! > 0) {
    const counts = receipt.provider === "openai" ? [receipt.cacheWrite30m, receipt.cacheWrite12h] : [receipt.cacheWrite5m, receipt.cacheWrite1h];
    const writeRates = receipt.provider === "openai" ? [rates.cacheWrite30mUsdPerMillion, rates.cacheWrite12hUsdPerMillion] : [rates.cacheWrite5mUsdPerMillion, rates.cacheWrite1hUsdPerMillion];
    if (counts[0] === undefined || counts[1] === undefined || counts[0] + counts[1] !== tokens.cachedWrite || writeRates[0] === undefined || writeRates[1] === undefined) return null;
    // Write rates are the total per-token price, not a surcharge on base input.
    numerator += priced(counts[0], writeRates[0]) + priced(counts[1], writeRates[1]);
  }
  // Round upward by at most one nanodollar, and never use a float to admit work.
  const units = (numerator + 999_999n) / 1_000_000n;
  return `${units / 1_000_000_000n}.${String(units % 1_000_000_000n).padStart(9, "0")}`;
}
