import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { EvalAttemptTrace, evalBraintrustConfig } from "./braintrust.js";
import { RunnerApi } from "./api.js";
import { buildPaperclipServerEnvironment } from "./harness-env.js";
import { setupLiveFixtures } from "./live-fixtures.js";
import { runnerMatrix } from "./catalog.js";
const require = createRequire(new URL("../../server/package.json", import.meta.url));
const protobuf = require("protobufjs") as typeof import("../../server/node_modules/protobufjs/index.js");
const projectId = "11111111-1111-4111-8111-111111111111", companyId = "22222222-2222-4222-8222-222222222222";
const config = { projectId, apiKey: "private-ingestion-fixture" };
const identity = { campaignId: "campaign", attemptId: "attempt", executionId: "hello.codex.local", provider: "codex", model: "fixture-model", environment: "local" };
const input = { failed: false, runIds: ["run-1"], cleanup: "passed", complaints: 1, suggestions: 2 };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("requires explicit export routing and keeps ingestion credentials out of server inheritance", () => {
  expect(evalBraintrustConfig({ BRAINTRUST_API_KEY: config.apiKey })).toBeUndefined();
  expect(() => evalBraintrustConfig({ PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID: projectId })).toThrow("API key");
  expect(() => evalBraintrustConfig({ PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID: "bad", BRAINTRUST_API_KEY: config.apiKey })).toThrow("UUID");
  expect(buildPaperclipServerEnvironment({ BRAINTRUST_API_KEY: config.apiKey, BRAINTRUST_OTHER_KEY: "private", KEEP: "yes" })).toEqual({ KEEP: "yes" });
});

it("sends real protobuf with parented phases, exact project routing, and no duplicate model charges", async () => {
  const root = protobuf.parse(await readFile(new URL("../../server/src/__tests__/fixtures/otlp-observability.proto", import.meta.url), "utf8")).root;
  const trace = new EvalAttemptTrace(config, identity);
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
      expect(data).toMatchObject({ expectedRevision: null, enabled: true, credentials: { mode: "replace", apiKey: config.apiKey }, destination: { provider: "braintrust", projectId } });
      return { settings: { enabled: true, credentialsConfigured: true, revision: projectId, destination: { provider: "braintrust", projectId } } };
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
