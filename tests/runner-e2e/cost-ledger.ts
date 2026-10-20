import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { usdToUnits } from "../../packages/shared/src/money.js";

export interface EvalSpendLimits {
  campaignId: string;
  maxUsd: string;
  deadlineAt: string;
  maxRequests: number;
  maxConcurrent: number;
}
export interface EvalChargeIdentity {
  executionId: string;
  attemptId: string;
  phase: "setup" | "agent" | "judge" | "feedback_review" | "tool" | "infrastructure";
  runId?: string;
}
export interface EvalCostObservation {
  observationId: string;
  requestId: string;
  source: "provider" | "gateway" | "native_otlp" | "heartbeat" | "infrastructure" | "invoice";
  provider: string;
  model?: string;
  providerRequestId?: string;
  currency: "USD";
  route: "direct" | "braintrust" | "other_gateway" | "subscription" | "infrastructure";
  classification: "reported" | "estimated" | "allocated" | "reconciled" | "unknown";
  costUsd?: string;
  pricingVersion?: string;
  /** Request totals only: input excludes reads/writes, reasoning is an output subset. */
  tokens?: { input?: number; cachedRead?: number; cachedWrite?: number; output?: number; reasoning?: number };
  /** Only final request receipts can release unused reservation. */
  final: boolean;
}

type Event =
  | { type: "campaign"; limits: EvalSpendLimits }
  | { type: "reserve"; requestId: string; identity: EvalChargeIdentity; maxUsd: string }
  | { type: "observe"; observation: EvalCostObservation }
  | { type: "finish"; requestId: string; outcome: "succeeded" | "failed" | "cancelled" };
interface Line { seq: number; at: string; previous: string; event: Event; hash: string }
interface RequestState { identity: EvalChargeIdentity; reserved: bigint; observations: EvalCostObservation[]; finished: boolean }
const usd = (units: bigint) => `${units / 1_000_000_000n}.${String(units % 1_000_000_000n).padStart(9, "0")}`;
const validId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,511}$/.test(value);
const amount = (value: string) => {
  // Refuse sub-nanodollar precision rather than silently rounding a cap upward.
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(value)) throw new Error("Invalid ledger USD amount");
  return usdToUnits(value);
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest("hex");
const fields = (value: object, allowed: string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unknown ledger field; refusing unreviewed data");
};
const ranks = { unknown: 0, allocated: 1, estimated: 2, reported: 3, reconciled: 4 };

export class EvalSpendState {
  readonly requests = new Map<string, RequestState>();
  readonly observations = new Map<string, EvalCostObservation>();
  private providerRequests = new Map<string, string>();
  constructor(readonly limits: EvalSpendLimits) {
    fields(limits, ["campaignId", "maxUsd", "deadlineAt", "maxRequests", "maxConcurrent"]);
    if (!validId(limits.campaignId) || amount(limits.maxUsd) <= 0n || !Number.isFinite(Date.parse(limits.deadlineAt))
        || !Number.isSafeInteger(limits.maxRequests) || limits.maxRequests < 1
        || !Number.isSafeInteger(limits.maxConcurrent) || limits.maxConcurrent < 1) throw new Error("Invalid eval spend limits");
  }
  private authoritative(request: RequestState) {
    // A matching request observed by multiple systems is counted once. Same-rank
    // disagreements remain unresolved; arrival order cannot decide a charge.
    const priced = request.observations.filter(value => value.costUsd !== undefined);
    const finalized = priced.filter(value => value.final);
    const candidates = finalized.length ? finalized : priced;
    const bestRank = Math.max(-1, ...candidates.map(value => ranks[value.classification]));
    const best = candidates.filter(value => ranks[value.classification] === bestRank);
    if (!best.length) return { cost: null, classification: "unknown" as const, conflict: false, resolved: false };
    const amounts = new Set(best.map(value => amount(value.costUsd!).toString()));
    const cost = best.reduce((maximum, value) => amount(value.costUsd!) > maximum ? amount(value.costUsd!) : maximum, 0n);
    return { cost, classification: best[0]!.classification, conflict: finalized.length > 0 && amounts.size !== 1,
      resolved: finalized.length > 0 && amounts.size === 1 };
  }
  snapshot() {
    let known = 0n, held = 0n, committed = 0n, inflight = 0, unknown = 0, conflicts = 0;
    const breakdown: Record<"reported" | "estimated" | "allocated" | "reconciled", bigint> = { reported: 0n, estimated: 0n, allocated: 0n, reconciled: 0n };
    const requests = [...this.requests].map(([requestId, request]) => {
      const receipt = this.authoritative(request);
      if (!request.finished) inflight++;
      if (receipt.conflict) conflicts++;
      if (!receipt.resolved) unknown++;
      const cost = receipt.cost ?? 0n;
      known += cost;
      if (receipt.classification !== "unknown") breakdown[receipt.classification] += cost;
      // Missing/contradictory receipts and still-running calls hold their full
      // reservation. Even an observed cost above it remains charged in full.
      const commitment = !request.finished || !receipt.resolved
        ? (request.reserved > cost ? request.reserved : cost) : cost;
      committed += commitment;
      held += commitment - cost;
      return { requestId, ...request.identity, reservedUsd: usd(request.reserved), costUsd: receipt.cost === null ? null : usd(cost),
        classification: receipt.classification, conflict: receipt.conflict, receiptComplete: receipt.resolved, finished: request.finished };
    });
    return { campaignId: this.limits.campaignId, limitUsd: usd(amount(this.limits.maxUsd)), knownUsd: usd(known), heldUsd: usd(held), committedUsd: usd(committed),
      overBudget: committed > amount(this.limits.maxUsd), unknownRequests: unknown, conflictingRequests: conflicts, inflight,
      breakdown: Object.fromEntries(Object.entries(breakdown).map(([key, value]) => [key, usd(value)])), requests };
  }
  validate(event: Event, now = Date.now()) {
    if (event.type === "campaign") throw new Error("Duplicate campaign event");
    if (event.type === "reserve") {
      fields(event.identity, ["executionId", "attemptId", "phase", "runId"]);
      if (!validId(event.requestId) || !validId(event.identity.executionId) || !validId(event.identity.attemptId)
          || event.identity.runId !== undefined && !validId(event.identity.runId)
          || !["setup", "agent", "judge", "feedback_review", "tool", "infrastructure"].includes(event.identity.phase)) throw new Error("Invalid request identity");
      if (this.requests.has(event.requestId)) throw new Error("Request already reserved");
      if (amount(event.maxUsd) <= 0n) throw new Error("Request reservation must be positive");
      const current = this.snapshot();
      if (now >= Date.parse(this.limits.deadlineAt)) throw new Error("Eval campaign deadline reached");
      if (this.requests.size >= this.limits.maxRequests) throw new Error("Eval campaign request cap reached");
      if (current.inflight >= this.limits.maxConcurrent) throw new Error("Eval campaign concurrency cap reached");
      if (current.conflictingRequests) throw new Error("Eval cost receipts conflict; admission stopped");
      if (amount(current.committedUsd) + amount(event.maxUsd) > amount(this.limits.maxUsd)) throw new Error("Eval campaign spending cap reached");
    } else if (event.type === "observe") {
      const o = event.observation;
      fields(o, ["observationId", "requestId", "source", "provider", "model", "providerRequestId", "currency", "route", "classification", "costUsd", "pricingVersion", "tokens", "final"]);
      if (o.tokens) fields(o.tokens, ["input", "cachedRead", "cachedWrite", "output", "reasoning"]);
      if (!this.requests.has(o.requestId) || !validId(o.observationId) || !validId(o.provider)
          || o.model !== undefined && !validId(o.model) || o.providerRequestId !== undefined && !validId(o.providerRequestId)
          || o.currency !== "USD" || !Object.hasOwn(ranks, o.classification) || typeof o.final !== "boolean"
          || !["provider", "gateway", "native_otlp", "heartbeat", "infrastructure", "invoice"].includes(o.source)
          || !["direct", "braintrust", "other_gateway", "subscription", "infrastructure"].includes(o.route)) throw new Error("Invalid cost observation");
      if (o.classification === "unknown" ? o.costUsd !== undefined : o.costUsd === undefined) throw new Error("Cost classification requires an explicit amount or unknown");
      if (o.costUsd !== undefined) amount(o.costUsd);
      if ((o.classification === "estimated" || o.classification === "allocated") && !validId(o.pricingVersion)) throw new Error("Estimate requires pricing provenance");
      if (o.tokens && (Object.values(o.tokens).some(value => !Number.isSafeInteger(value) || Number(value) < 0)
          || o.tokens.reasoning !== undefined && o.tokens.output !== undefined && o.tokens.reasoning > o.tokens.output)) throw new Error("Invalid normalized token usage");
      const previous = this.observations.get(o.observationId);
      if (previous && digest(previous) !== digest(o)) throw new Error("Observation identity conflict");
      if (o.providerRequestId) {
        const request = this.providerRequests.get(`${o.provider}:${o.providerRequestId}`);
        if (request && request !== o.requestId) throw new Error("Provider request belongs to another reservation; reconcile identities before import");
      }
    } else if (event.type === "finish") {
      if (!this.requests.has(event.requestId) || !["succeeded", "failed", "cancelled"].includes(event.outcome)) throw new Error("Invalid request completion");
    } else throw new Error("Unknown ledger event");
  }
  apply(event: Event) {
    if (event.type === "reserve") this.requests.set(event.requestId, { identity: event.identity, reserved: amount(event.maxUsd), observations: [], finished: false });
    else if (event.type === "observe") {
      const o = event.observation;
      if (this.observations.has(o.observationId)) return;
      this.observations.set(o.observationId, o);
      this.requests.get(o.requestId)!.observations.push(o);
      if (o.providerRequestId) this.providerRequests.set(`${o.provider}:${o.providerRequestId}`, o.requestId);
    } else if (event.type === "finish") this.requests.get(event.requestId)!.finished = true;
  }
}

/** Reads survive process loss. A truncated/corrupt journal fails closed. */
export async function readEvalCostLedger(file: string) {
  const raw = await readFile(file, "utf8");
  if (!raw.endsWith("\n")) throw new Error("Eval ledger has an incomplete durable record");
  const lines = raw.trimEnd().split("\n").map(value => JSON.parse(value) as Line);
  let previous = "", state: EvalSpendState | undefined;
  for (const [index, line] of lines.entries()) {
    const { hash, ...body } = line;
    if (line.seq !== index || line.previous !== previous || digest(body) !== hash || !Number.isFinite(Date.parse(line.at))) throw new Error("Eval ledger integrity check failed");
    if (index === 0) {
      if (line.event.type !== "campaign") throw new Error("Eval ledger lacks campaign limits");
      state = new EvalSpendState(line.event.limits);
    } else {
      state!.validate(line.event, Date.parse(line.at));
      state!.apply(line.event);
    }
    previous = hash;
  }
  return { state: state!, sequence: lines.length, previous };
}

/** One durable writer per campaign; call reserve before any external paid action. */
export async function openEvalCostLedger(file: string, limits: EvalSpendLimits) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = `${file}.lock`;
  let lock: FileHandle;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { throw new Error("Eval ledger writer lock unavailable; inspect prior writer before recovery"); }
  let handle: FileHandle | undefined;
  try {
    await lock.writeFile(`${process.pid}\n`);
    await lock.sync();
    let state = new EvalSpendState(limits), sequence = 0, previous = "";
    try {
      const loaded = await readEvalCostLedger(file);
      if (digest(loaded.state.limits) !== digest(limits)) throw new Error("Eval campaign limits changed during resume");
      ({ state, sequence, previous } = loaded);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const write = async (event: Event) => {
      const body = { seq: sequence, at: new Date().toISOString(), previous, event };
      const hash = digest(body);
      await handle!.appendFile(`${JSON.stringify({ ...body, hash })}\n`);
      await handle!.sync();
      previous = hash;
      sequence++;
    };
    if (!sequence) await write({ type: "campaign", limits });
    let queue = Promise.resolve(), closed = false, poisoned = false;
    const append = (event: Event) => {
      if (closed) return Promise.reject(new Error("Eval ledger writer unavailable"));
      const operation = queue.then(async () => {
        if (poisoned) throw new Error("Eval ledger writer unavailable");
        state.validate(event);
        try { await write(event); } catch (error) { poisoned = true; throw error; }
        state.apply(event);
      });
      queue = operation.catch(() => {});
      return operation;
    };
    return {
      reserve: (requestId: string, identity: EvalChargeIdentity, maxUsd: string) => append({ type: "reserve", requestId, identity: structuredClone(identity), maxUsd }),
      observe: (observation: EvalCostObservation) => append({ type: "observe", observation: structuredClone(observation) }),
      finish: (requestId: string, outcome: "succeeded" | "failed" | "cancelled") => append({ type: "finish", requestId, outcome }),
      snapshot: () => state.snapshot(),
      async close() {
        if (closed) return;
        closed = true;
        await queue;
        try { await handle!.close(); } finally { await lock.close(); await rm(lockPath); }
      },
    };
  } catch (error) {
    await handle?.close();
    await lock.close();
    await rm(lockPath);
    throw error;
  }
}
