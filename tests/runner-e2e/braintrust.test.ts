import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { EvalAttemptTrace, evalBraintrustConfig, exportBraintrustAttemptParent } from "./braintrust.js";
import { RunnerApi } from "./api.js";
import { buildPaperclipServerEnvironment } from "./harness-env.js";
import { setupLiveFixtures } from "./live-fixtures.js";
import { runnerMatrix } from "./catalog.js";
import { buildProviderObservabilityLaunch } from "../../packages/adapter-utils/src/agent-observability.js";
const require = createRequire(new URL("../../server/package.json", import.meta.url));
const protobuf = require("protobufjs") as typeof import("../../server/node_modules/protobufjs/index.js");
const projectId = "11111111-1111-4111-8111-111111111111", companyId = "22222222-2222-4222-8222-222222222222";
const config = { projectId, apiKey: "private-ingestion-fixture" };
const identity = { campaignId: "campaign", attemptId: "attempt", executionId: "hello.codex.local", provider: "codex", model: "fixture-model", environment: "local" };
const provenance = { suiteId: "core-compatibility", suiteDefinitionHash: "a".repeat(64), profileId: "runner-codex", caseId: "message-marker", sourceRevision: "b".repeat(40) };
const input = { failed: false, runIds: ["run-1"], cleanup: "passed", complaints: 1, suggestions: 2 };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("requires explicit export routing and keeps ingestion credentials out of server inheritance", () => {
  expect(evalBraintrustConfig({ BRAINTRUST_API_KEY: config.apiKey })).toBeUndefined();
  expect(() => evalBraintrustConfig({ PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID: projectId })).toThrow("API key");
  expect(() => evalBraintrustConfig({ PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID: "bad", BRAINTRUST_API_KEY: config.apiKey })).toThrow("UUID");
  expect(buildPaperclipServerEnvironment({ BRAINTRUST_API_KEY: config.apiKey, BRAINTRUST_OTHER_KEY: "private", KEEP: "yes" })).toEqual({ KEEP: "yes" });
});

it("exports the SDK-verified project-log parent format and refuses invalid identifiers", () => {
  const receipt = { projectId, spanId: "1234567890abcdef", traceId: "abcdef0123456789abcdef0123456789" };
  expect(exportBraintrustAttemptParent(receipt)).toBe("BAIAeyJvYmplY3RfaWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJyb3dfaWQiOiIxMjM0NTY3ODkwYWJjZGVmIiwic3Bhbl9pZCI6IjEyMzQ1Njc4OTBhYmNkZWYiLCJyb290X3NwYW5faWQiOiJhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OSJ9");
  for (const invalid of [{ projectId: "project" }, { spanId: "0".repeat(16) }, { traceId: "0".repeat(32) }, { spanId: "1234567890abcdeg" }]) {
    expect(() => exportBraintrustAttemptParent({ ...receipt, ...invalid })).toThrow("parent identity");
  }
});

it.each(["codex", "claude"] as const)("preserves the attempt parent through the production %s launch encoder", kind => {
  const trace = new EvalAttemptTrace(config, identity);
  const parent = exportBraintrustAttemptParent(trace.snapshot());
  const launch = buildProviderObservabilityLaunch({
    kind, companyId, agentId: projectId, revision: projectId, compatibilityKey: "fixture", enabled: true,
    capture: { userPrompts: true, assistantResponses: true, toolDetails: true, toolContent: true },
    tracesEndpoint: "https://api.braintrust.dev/otel/v1/traces", logsEndpoint: "https://api.braintrust.dev/otel/v1/logs",
    headers: { authorization: `Bearer ${config.apiKey}`, "x-bt-parent": parent },
  });
  if (kind === "codex") {
    const exporter = launch.otelConfig!.trace_exporter as { "otlp-http": { headers: Record<string, string> } };
    expect(decodeURIComponent(exporter["otlp-http"].headers["x-bt-parent"])).toBe(parent);
  } else {
    for (const name of ["OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_EXPORTER_OTLP_LOGS_HEADERS"]) {
      const encoded = launch.environment[name].split(",").find(header => header.startsWith("x-bt-parent="))!;
      expect(decodeURIComponent(encoded.slice("x-bt-parent=".length))).toBe(parent);
    }
  }
  expect(JSON.stringify(trace.snapshot())).not.toContain(config.apiKey);
});

it("rejects invalid provenance while retaining an explicitly unknown source revision", () => {
  expect(() => new EvalAttemptTrace(config, identity, { ...provenance, suiteDefinitionHash: "unknown" })).toThrow("provenance");
  expect(() => new EvalAttemptTrace(config, identity, { ...provenance, sourceRevision: "master" })).toThrow("provenance");
  expect(() => new EvalAttemptTrace(config, identity, { ...provenance, sourceRevision: null })).not.toThrow();
});

it("sends real protobuf with parented phases, exact project routing, and no duplicate model charges", async () => {
  const root = protobuf.parse(await readFile(new URL("../../server/src/__tests__/fixtures/otlp-observability.proto", import.meta.url), "utf8")).root;
  const trace = new EvalAttemptTrace(config, identity, provenance);
  trace.phase("setup"); trace.phase("execution"); trace.phase("feedback"); trace.phase("cleanup");
  let captured: RequestInit | undefined;
  const transport = vi.fn<typeof fetch>(async (_url, init) => { captured = init; return new Response(null, { status: 200 }); });
  expect(await trace.export(input, transport)).toMatchObject({ status: "accepted", verification: "unverified", nativeConfiguration: "not_started" });
  expect(captured).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: `Bearer ${config.apiKey}`, "x-bt-parent": `project_id:${projectId}`, "content-type": "application/x-protobuf" } });
  const bytes = captured!.body as Buffer;
  expect(bytes.includes(config.apiKey)).toBe(false);
  const decoded = root.lookupType("paperclip.test.otlp.ExportTraceServiceRequest").decode(bytes).toJSON();
  const spans = decoded.resourceSpans[0].scopeSpans[0].spans;
  expect(spans.map((span: { name: string }) => span.name)).toEqual(["paperclip.eval.attempt", "paperclip.eval.setup", "paperclip.eval.execution", "paperclip.eval.feedback", "paperclip.eval.cleanup"]);
  expect(spans[0].parentSpanId).toBeUndefined();
  for (const span of spans.slice(1)) {
    expect(span.traceId).toBe(spans[0].traceId);
    expect(span.parentSpanId).toBe(spans[0].spanId);
  }
  expect(JSON.stringify(decoded)).toContain("paperclip.eval.attempt_id");
  const attributes = Object.fromEntries(spans[0].attributes.map((attribute: { key: string; value: { stringValue: string } }) => [attribute.key, attribute.value.stringValue]));
  expect(attributes).toMatchObject({
    "paperclip.eval.suite_id": provenance.suiteId, "paperclip.eval.suite_definition_hash": provenance.suiteDefinitionHash,
    "paperclip.eval.profile_id": provenance.profileId, "paperclip.eval.case_id": provenance.caseId,
    "paperclip.eval.source_revision": provenance.sourceRevision, "paperclip.eval.grader": "tests/runner-e2e/runner.spec.ts",
  });
  expect(JSON.stringify(decoded)).not.toMatch(/gen_ai\.usage|cost_usd|private-ingestion/);
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each([
  [() => new Response("private-provider-error", { status: 403 }), "receiver_rejected"],
  [() => Response.json({ partialSuccess: { rejectedSpans: "1" } }), "partial_rejection"],
  [() => Response.json({ partialSuccess: { rejectedSpans: -1 } }), "export_failed"],
  [() => new Response("invalid", { status: 200, headers: { "content-type": "text/html" } }), "export_failed"],
  [() => new Response(Buffer.alloc(65_537)), "export_failed"],
])("retains export failure without raw receiver diagnostics", async (response, errorCode) => {
  const trace = new EvalAttemptTrace(config, identity);
  expect(await trace.export(input, async () => response())).toMatchObject({ status: "failed", verification: "unverified", errorCode });
  expect(JSON.stringify(trace.snapshot())).not.toMatch(/private-provider-error|private-ingestion/);
});

it("configures native export through a revision-fenced sensitive PUT before any credential or agent setup", async () => {
  const order: string[] = [];
  const trace = new EvalAttemptTrace(config, identity);
  const api = {
    async get() { return [{ id: "local", driver: "local" }]; },
    async putSensitive(path: string, data: unknown) {
      order.push("observability");
      expect(path).toBe(`/api/companies/${companyId}/observability`);
      expect(data).toMatchObject({ expectedRevision: null, enabled: true,
        credentials: { mode: "replace", headers: [{ name: "authorization", value: `Bearer ${config.apiKey}` }, { name: "x-bt-parent", value: exportBraintrustAttemptParent(trace.snapshot()) }] },
        destination: { provider: "otlp", endpointBaseUrl: "https://api.braintrust.dev/otel" } });
      return { settings: { enabled: true, credentialsConfigured: true, revision: projectId, destination: { provider: "otlp", endpointBaseUrl: "https://api.braintrust.dev/otel" } } };
    },
    async postSensitive() { order.push("secret"); return { id: "secret" }; },
    async post(path: string) { order.push(path === "/api/companies" ? "company" : "agent"); return { id: companyId, name: "fixture" }; },
  } as unknown as RunnerApi;
  const execution = runnerMatrix.find(cell => cell.profile.id === "runner-codex" && cell.environment.id === "local" && cell.task.flow === "single_turn")!;
  expect(execution).toBeDefined();
  const fixtures = await setupLiveFixtures({ api, execution, executionNonce: "fixture", workspacePath: "/tmp/fixture", credentials: { OPENAI_API_KEY: "private-provider" }, onCompanyCreated: id => trace.configureCompany(api, id) });
  await fixtures.teardown();
  expect(order.slice(0, 3)).toEqual(["company", "observability", "secret"]);
  expect(trace.snapshot()).toMatchObject({ nativeConfiguration: "configured", companyId, revision: projectId });
});

it.each([
  { provider: "braintrust", projectId },
  { provider: "otlp", endpointBaseUrl: "https://elsewhere.invalid/otel" },
])("refuses a saved native destination that cannot carry the attempt parent", async destination => {
  const trace = new EvalAttemptTrace(config, identity);
  const api = { putSensitive: async () => ({ settings: { enabled: true, credentialsConfigured: true, revision: projectId, destination } }) } as unknown as RunnerApi;
  await expect(trace.configureCompany(api, companyId)).rejects.toThrow("configuration failed");
  expect(trace.snapshot().nativeConfiguration).toBe("failed");
});

it("never sends sensitive PUT bodies through Playwright and refuses redirects or foreign destinations", async () => {
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "43123");
  const playwright = { put: vi.fn() };
  const api = new RunnerApi(playwright as never);
  api.setBrowserSession("session=private");
  const transport = vi.fn().mockResolvedValue(Response.json({ ok: true })); vi.stubGlobal("fetch", transport);
  await api.putSensitive("/api/companies/fixture/observability", { apiKey: config.apiKey });
  expect(playwright.put).not.toHaveBeenCalled();
  expect(transport).toHaveBeenCalledWith(new URL("http://127.0.0.1:43123/api/companies/fixture/observability"), expect.objectContaining({ method: "PUT", redirect: "error", signal: expect.any(AbortSignal), headers: expect.objectContaining({ Cookie: "session=private" }) }));
  await expect(api.putSensitive("https://other.invalid/api/collect", { apiKey: config.apiKey })).rejects.toThrow("fixture API");
  transport.mockRejectedValue(new Error(config.apiKey));
  await expect(api.putSensitive("/api/fixture", {})).rejects.toThrow("details withheld");
});
