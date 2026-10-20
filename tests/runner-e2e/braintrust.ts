import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { RunnerApi } from "./api.js";

export const EVAL_OBSERVABILITY_SECRET_NAMES = ["BRAINTRUST_API_KEY"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface EvalBraintrustConfig { projectId: string; apiKey: string }
export function evalBraintrustConfig(env: NodeJS.ProcessEnv): EvalBraintrustConfig | undefined {
  const projectId = env.PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID;
  if (!projectId) return undefined;
  if (!uuid.test(projectId) || !env.BRAINTRUST_API_KEY?.trim() || /[\r\n]/.test(env.BRAINTRUST_API_KEY)) {
    throw new Error("Eval Braintrust export requires an explicit project UUID and API key");
  }
  return { projectId, apiKey: env.BRAINTRUST_API_KEY.trim() };
}

type Attributes = Record<string, string | number | boolean | string[]>;
type Phase = "setup" | "execution" | "feedback" | "cleanup";
interface PhaseSpan { name: Phase; spanId: string; start: number; end?: number; failed?: boolean }
export interface EvalTraceIdentity { campaignId: string; attemptId: string; executionId: string; provider: string; model: string; environment: string }
export interface EvalTraceReceipt {
  projectId: string; traceId: string; spanId: string;
  status: "pending" | "accepted" | "failed";
  verification: "unverified";
  nativeConfiguration: "not_started" | "configured" | "failed";
  companyId?: string; revision?: string; errorCode?: string; httpStatus?: number;
}
const require = createRequire(new URL("../../server/package.json", import.meta.url));
const time = (ms: number): [number, number] => [Math.floor(ms / 1000), (ms % 1000) * 1_000_000];

export class EvalAttemptTrace {
  private readonly startedAt = Date.now();
  private readonly phases: PhaseSpan[] = [];
  private active?: PhaseSpan;
  private readonly receipt: EvalTraceReceipt;
  constructor(private readonly config: EvalBraintrustConfig, private readonly identity: EvalTraceIdentity) {
    if (Object.values(identity).some(value => !value || value.length > 512 || /[\r\n]/.test(value))) throw new Error("Invalid eval trace identity");
    this.receipt = { projectId: config.projectId, traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"),
      status: "pending", verification: "unverified", nativeConfiguration: "not_started" };
  }
  snapshot(): EvalTraceReceipt { return { ...this.receipt }; }
  phase(name: Phase, previousFailed = false) {
    this.endPhase(previousFailed);
    this.active = { name, spanId: randomBytes(8).toString("hex"), start: Date.now() };
    this.phases.push(this.active);
  }
  endPhase(failed = false) {
    if (this.active) { this.active.end = Date.now(); this.active.failed = failed; this.active = undefined; }
  }
  async configureCompany(api: Pick<RunnerApi, "putSensitive">, companyId: string) {
    if (!uuid.test(companyId)) throw new Error("Invalid eval trace company identity");
    this.receipt.companyId = companyId;
    try {
      const saved = await api.putSensitive<{ settings: { revision: string; enabled: boolean; credentialsConfigured: boolean; destination: { provider: string; projectId?: string } } }>(
        `/api/companies/${companyId}/observability`, {
          expectedRevision: null, enabled: true,
          destination: { provider: "braintrust", projectId: this.config.projectId },
          credentials: { mode: "replace", apiKey: this.config.apiKey },
          capture: { userPrompts: true, assistantResponses: true, toolDetails: true, toolContent: true },
        });
      if (!saved.settings?.enabled || !saved.settings.credentialsConfigured || !uuid.test(saved.settings.revision)
          || saved.settings.destination.provider !== "braintrust" || saved.settings.destination.projectId !== this.config.projectId) throw new Error("Unexpected observability setting");
      this.receipt.revision = saved.settings.revision;
      this.receipt.nativeConfiguration = "configured";
    } catch {
      this.receipt.nativeConfiguration = "failed";
      throw new Error("Eval native observability configuration failed; response withheld");
    }
  }
  async export(input: { failed: boolean; runIds: string[]; cleanup: string; complaints: number; suggestions: number }, transport: typeof fetch = fetch): Promise<EvalTraceReceipt> {
    this.endPhase(input.failed);
    const endedAt = Date.now();
    const { resourceFromAttributes } = require("@opentelemetry/resources") as { resourceFromAttributes(attributes: Attributes): unknown };
    const { ProtobufTraceSerializer: serializer } = require("@opentelemetry/otlp-transformer") as {
      ProtobufTraceSerializer: { serializeRequest(spans: unknown[]): Uint8Array | undefined; deserializeResponse(bytes: Uint8Array): unknown };
    };
    const attributes: Attributes = {
      "paperclip.eval.campaign_id": this.identity.campaignId, "paperclip.eval.attempt_id": this.identity.attemptId,
      "paperclip.eval.execution_id": this.identity.executionId, "paperclip.eval.provider": this.identity.provider,
      "paperclip.eval.model": this.identity.model, "paperclip.eval.environment": this.identity.environment,
      "paperclip.eval.cleanup": input.cleanup, "paperclip.eval.run_ids": input.runIds,
      "paperclip.eval.feedback.complaints": input.complaints, "paperclip.eval.feedback.suggestions": input.suggestions,
      ...(this.receipt.companyId ? { "paperclip.company.id": this.receipt.companyId } : {}),
    };
    const resource = resourceFromAttributes({ "service.name": "paperclip-evals" });
    const instrumentationScope = { name: "paperclip.eval-operations", version: "1" };
    const rootContext = { traceId: this.receipt.traceId, spanId: this.receipt.spanId, traceFlags: 1 };
    const span = (name: string, spanId: string, start: number, end: number, failed: boolean, parent = false) => ({
      name, kind: 0, spanContext: () => ({ ...rootContext, spanId }), ...(parent ? { parentSpanContext: rootContext } : {}),
      startTime: time(start), endTime: time(end), duration: time(end - start), status: { code: failed ? 2 : 1 }, attributes,
      links: [], events: [], ended: true, resource, instrumentationScope,
      droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
    });
    try {
      const body = serializer.serializeRequest([
        span("paperclip.eval.attempt", this.receipt.spanId, this.startedAt, endedAt, input.failed),
        ...this.phases.map(phase => span(`paperclip.eval.${phase.name}`, phase.spanId, phase.start, phase.end!, phase.failed ?? false, true)),
      ]);
      if (!body) throw new Error("serialization");
      const response = await transport("https://api.braintrust.dev/otel/v1/traces", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${this.config.apiKey}`, "x-bt-parent": `project_id:${this.config.projectId}`,
          "content-type": "application/x-protobuf", accept: "application/x-protobuf, application/json" },
        body: Buffer.from(body),
      });
      this.receipt.httpStatus = response.status;
      if (!response.ok) { this.receipt.errorCode = "receiver_rejected"; await response.body?.cancel(); throw new Error("rejected"); }
      const contentType = response.headers.get("content-type")?.split(";")[0].trim();
      if (contentType && !["application/json", "application/x-protobuf"].includes(contentType)) { await response.body?.cancel(); throw new Error("invalid_response"); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (reader) {
          const next = await reader.read(); if (next.done) break;
          length += next.value.length; if (length > 65_536) throw new Error("response_too_large");
          chunks.push(next.value);
        }
      } finally { await reader?.cancel().catch(() => {}); }
      if (length) {
        const bytes = Buffer.concat(chunks);
        const decoded = contentType === "application/json" ? JSON.parse(bytes.toString("utf8"))
          : contentType === "application/x-protobuf" ? serializer.deserializeResponse(bytes) : null;
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid_response");
        const partial = (decoded as { partialSuccess?: { rejectedSpans?: unknown } }).partialSuccess;
        if (partial !== undefined && (!partial || typeof partial !== "object" || Array.isArray(partial))) throw new Error("invalid_response");
        const rejected = partial?.rejectedSpans ?? 0;
        if (!/^[0-9]+$/.test(String(rejected)) || !Number.isSafeInteger(Number(rejected))) throw new Error("invalid_response");
        if (Number(rejected) !== 0) { this.receipt.errorCode = "partial_rejection"; throw new Error("partial_rejection"); }
      }
      this.receipt.status = "accepted";
    } catch {
      this.receipt.status = "failed";
      this.receipt.errorCode ??= "export_failed";
    }
    return this.snapshot();
  }
}
