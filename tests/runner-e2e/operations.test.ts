import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { runnerMatrix } from "./catalog.js";
import { validateEvalOperationsManifest, openEvalOperations, type EvalOperationsManifest } from "./operations.js";
import { setupLiveFixtures } from "./live-fixtures.js";
import { createAiConnectionSchema, aiConnectionBindingSchema } from "../../packages/shared/src/ai-connections.js";
import type { RunnerApi } from "./api.js";
import { beginEvalAgentPhase, readEvalAttemptPhase } from "./attempt-phase.js";
const cell = runnerMatrix.find(e => e.suite.id === "core-compatibility" && e.profile.id === "runner-codex" && e.environment.id === "local")!;
function manifest(): EvalOperationsManifest {
  return { version: 1, limits: { campaignId: "pilot", maxUsd: "100", deadlineAt: new Date(Date.now() + 60_000).toISOString(), maxRequests: 20, maxConcurrent: 1 },
    ledgerPath: "/tmp/fixture-not-opened.jsonl", executionIds: [cell.id], maxAttemptsPerExecution: 2, route: "direct",
    models: [{ provider: "openai", maximumInputTokens: 1000, maximumOutputTokens: 100, timeoutMs: 1000,
      price: { provider: "openai", model: cell.profile.model, version: "fixture-only", sourceUrl: "https://provider.invalid/fixture", inputUsdPerMillion: "2", cachedReadUsdPerMillion: "1", outputUsdPerMillion: "10", cacheWrite30mUsdPerMillion: "2", cacheWrite12hUsdPerMillion: "2" } }] };
}
afterEach(() => vi.unstubAllEnvs());
it("admits only the exact bounded local selection and explicitly priced models", () => {
  expect(validateEvalOperationsManifest(manifest(), [cell], 1)).toMatchObject({ route: "direct" });
  expect(() => validateEvalOperationsManifest({ ...manifest(), executionIds: [] }, [cell], 1)).toThrow("selection");
  expect(() => validateEvalOperationsManifest(manifest(), [cell], 2)).toThrow("limits");
  const remote = runnerMatrix.find(e => e.suite.id === cell.suite.id && e.profile.id === cell.profile.id && e.environment.id === "daytona")!;
  expect(() => validateEvalOperationsManifest({ ...manifest(), executionIds: [remote.id] }, [remote], 1)).toThrow("Unqualified");
  const changed = manifest(); changed.models[0]!.price.model = "other";
  expect(() => validateEvalOperationsManifest(changed, [cell], 1)).toThrow("Missing exact model");
});
it("rejects credentials in the manifest and unknown pricing/billing policy fields", () => {
  expect(() => validateEvalOperationsManifest({ ...manifest(), apiKey: "private" } as never, [cell], 0)).toThrow("fields");
  const changed = manifest(); Object.assign(changed.models[0]!, { apiKey: "private" });
  expect(() => validateEvalOperationsManifest(changed, [cell], 0)).toThrow("fields");
  expect(() => validateEvalOperationsManifest({ ...manifest(), route: "braintrust" }, [cell], 0)).toThrow("project UUID");
});
it("retains a campaign summary and refuses changing its budget on restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-ops-test-"));
  try {
    const value = { ...manifest(), ledgerPath: path.join(root, "ledger.jsonl") }, file = path.join(root, "manifest.json");
    await writeFile(file, JSON.stringify(value));
    const operations = await openEvalOperations(file, [cell], 0, { OPENAI_API_KEY: "private-fixture" });
    const endpoint = await operations.start(cell, "attempt", 1);
    expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(await readEvalAttemptPhase(endpoint.phasePath, { executionId: cell.id, attemptId: "attempt" })).toMatchObject({ phase: "setup" });
    await beginEvalAgentPhase(cell.id, { PAPERCLIP_E2E_GATEWAY_PHASE_PATH: endpoint.phasePath, PAPERCLIP_E2E_ACCOUNTING_ATTEMPT_ID: "attempt" });
    expect(await readEvalAttemptPhase(endpoint.phasePath, { executionId: cell.id, attemptId: "attempt" })).toMatchObject({ phase: "agent" });
    await endpoint.close(); await operations.close();
    expect(JSON.parse(await readFile(`${value.ledgerPath}.summary.json`, "utf8"))).toMatchObject({ limitUsd: "100.000000000", knownUsd: "0.000000000", requests: [] });
    const resumed = await openEvalOperations(file, [cell], 0, { OPENAI_API_KEY: "private-fixture" });
    const retry = await resumed.start(cell, "retry-after-restart", 1);
    await retry.close();
    await expect(resumed.start(cell, "third-attempt", 1)).rejects.toThrow("attempt cap");
    await resumed.close();
    const summary = JSON.parse(await readFile(`${value.ledgerPath}.summary.json`, "utf8"));
    expect(summary.admittedAttempts).toEqual([{ executionId: cell.id, attemptId: "attempt" }, { executionId: cell.id, attemptId: "retry-after-restart" }]);
    await writeFile(file, JSON.stringify({ ...value, maxAttemptsPerExecution: 3 }));
    await expect(openEvalOperations(file, [cell], 0, { OPENAI_API_KEY: "private-fixture" })).rejects.toThrow("limits changed");
    await writeFile(file, JSON.stringify({ ...value, limits: { ...value.limits, maxUsd: "101" } }));
    await expect(openEvalOperations(file, [cell], 0, { OPENAI_API_KEY: "private-fixture" })).rejects.toThrow("limits changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("routes the fixture through a real shared connection contract without ambient provider bindings", async () => {
  vi.stubEnv("PAPERCLIP_E2E_GATEWAY_BASE_URL", "http://127.0.0.1:43123");
  vi.stubEnv("PAPERCLIP_E2E_GATEWAY_TOKEN", "ephemeral-fixture-token");
  const id = "11111111-1111-4111-8111-111111111111", grantId = "22222222-2222-4222-8222-222222222222";
  let connection: unknown, agent: Record<string, any> | undefined;
  const api = {
    async get() { return [{ id, driver: "local" }]; },
    async postSensitive(url: string, body: unknown) { if (url.endsWith("/ai-connections")) { connection = body; return { connectionId: id, grantId }; } return { id }; },
    async post(url: string, body: Record<string, unknown>) { if (url.endsWith("/agents")) agent = body; return { id, name: "fixture" }; },
  } as unknown as RunnerApi;
  const fixtures = await setupLiveFixtures({ api, execution: cell, executionNonce: "fixture", workspacePath: "/tmp/fixture", credentials: { OPENAI_API_KEY: "ephemeral-fixture-token" } });
  await fixtures.teardown();
  expect(createAiConnectionSchema.parse(connection)).toMatchObject({ ownership: "shared", apiKey: "ephemeral-fixture-token", routing: { kind: "gateway", protocol: "responses", baseUrl: "http://127.0.0.1:43123/v1", auth: "bearer" } });
  expect(aiConnectionBindingSchema.parse(agent!.runtimeConfig.aiConnection)).toEqual({ provider: "openai", method: "api_key", mode: "shared", connectionId: id, grantId });
  expect(agent!.adapterConfig.env).toBeUndefined();
});
