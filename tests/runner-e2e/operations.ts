import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { EvalSpendState, openEvalCostLedger, type EvalSpendLimits } from "./cost-ledger.js";
import { evalRequestReservation, startEvalGateway, type EvalGatewayRoute, type EvalGatewayReceipt } from "./eval-gateway.js";
import type { MatrixExecution } from "./types.js";

export interface EvalOperationsManifest {
  version: 1;
  limits: EvalSpendLimits;
  ledgerPath: string;
  executionIds: string[];
  maxAttemptsPerExecution: number;
  route: "direct" | "braintrust";
  projectId?: string;
  models: Array<Omit<EvalGatewayRoute, "apiKey" | "projectId" | "endpointName" | "mode">>;
}
const fields = (value: object, names: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(name => !names.includes(name))) throw new Error("Invalid eval operations manifest fields");
};
export function validateEvalOperationsManifest(value: EvalOperationsManifest, executions: readonly MatrixExecution[], maxRetries: number) {
  fields(value, ["version", "limits", "ledgerPath", "executionIds", "maxAttemptsPerExecution", "route", "projectId", "models"]);
  new EvalSpendState(value.limits);
  if (value.version !== 1 || !["direct", "braintrust"].includes(value.route) || !path.isAbsolute(value.ledgerPath)
      || !Array.isArray(value.executionIds) || new Set(value.executionIds).size !== value.executionIds.length
      || JSON.stringify([...value.executionIds].sort()) !== JSON.stringify(executions.map(e => e.id).sort())
      || !Number.isSafeInteger(value.maxAttemptsPerExecution) || value.maxAttemptsPerExecution < 1
      || maxRetries + 1 > value.maxAttemptsPerExecution || !Array.isArray(value.models) || value.models.length === 0) throw new Error("Eval operations selection or limits mismatch");
  if (value.route === "braintrust" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.projectId ?? "")) throw new Error("Braintrust gateway requires an explicit project UUID");
  const models = new Set<string>();
  for (const model of value.models) {
    fields(model, ["provider", "price", "maximumInputTokens", "maximumOutputTokens", "timeoutMs"]);
    const rateFields = ["inputUsdPerMillion", "cachedReadUsdPerMillion", "outputUsdPerMillion", "cacheWrite5mUsdPerMillion", "cacheWrite1hUsdPerMillion", "cacheWrite30mUsdPerMillion", "cacheWrite12hUsdPerMillion"];
    fields(model.price, ["provider", "model", "version", "sourceUrl", "longContext", ...rateFields]);
    if (model.price.longContext) { fields(model.price.longContext, ["aboveInputTokens", "rates"]); fields(model.price.longContext.rates, rateFields); }
    const url = new URL(model.price.sourceUrl);
    if (!["openai", "anthropic"].includes(model.provider) || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid model price provenance");
    const key = `${model.provider}:${model.price.model}`;
    if (models.has(key)) throw new Error("Duplicate eval model price"); models.add(key);
    evalRequestReservation({ ...model, mode: value.route, apiKey: "validation" });
  }
  for (const execution of executions) {
    // These cells have one selected provider and no separate hosted judge/tool API.
    // Expand only after the new path has its own routing/accounting qualification.
    if (execution.environment.id !== "local" || execution.suite.id !== "core-compatibility"
        || !["runner-codex", "runner-acpx-claude", "legacy-codex", "legacy-claude"].includes(execution.profile.id)
        || execution.requiredCredentials.length !== 1) throw new Error(`Unqualified budgeted eval route: ${execution.id}`);
    const provider = execution.profile.credential === "ANTHROPIC_API_KEY" ? "anthropic" : "openai";
    if (!models.has(`${provider}:${execution.profile.model}`)) throw new Error(`Missing exact model pricing: ${execution.id}`);
  }
  return value;
}

export async function openEvalOperations(file: string, executions: readonly MatrixExecution[], maxRetries: number, env: NodeJS.ProcessEnv) {
  const manifest = validateEvalOperationsManifest(JSON.parse(await readFile(file, "utf8")), executions, maxRetries);
  if (Date.now() >= Date.parse(manifest.limits.deadlineAt)) throw new Error("Eval campaign deadline reached");
  const required = manifest.route === "braintrust" ? ["BRAINTRUST_API_KEY"] : executions.map(execution => execution.profile.credential);
  if (required.some(name => !env[name]?.trim())) throw new Error("Missing eval gateway upstream credential");
  const receiptDirectory = `${manifest.ledgerPath}.requests`;
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  const ledger = await openEvalCostLedger(manifest.ledgerPath, manifest.limits);
  const active = new Set<Awaited<ReturnType<typeof startEvalGateway>>>();
  const atomicJson = async (file: string, value: unknown) => {
    await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  return {
    manifest,
    async start(execution: MatrixExecution, attemptId: string, attempt: number) {
      if (attempt > manifest.maxAttemptsPerExecution || Date.now() >= Date.parse(manifest.limits.deadlineAt)) throw new Error("Eval operations attempt/deadline limit reached");
      const provider = execution.profile.credential === "ANTHROPIC_API_KEY" ? "anthropic" : "openai";
      const model = manifest.models.find(m => m.provider === provider && m.price.model === execution.profile.model)!;
      const route: EvalGatewayRoute = { ...model, mode: manifest.route, projectId: manifest.projectId,
        endpointName: provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
        apiKey: env[manifest.route === "braintrust" ? "BRAINTRUST_API_KEY" : execution.profile.credential] ?? "" };
      if (!route.apiKey) throw new Error("Missing eval gateway upstream credential");
      const gateway = await startEvalGateway({ ledger, route,
        identity: { executionId: execution.id, attemptId, phase: "agent" }, deadlineAt: Date.parse(manifest.limits.deadlineAt),
        persist: (receipt: EvalGatewayReceipt) => atomicJson(path.join(receiptDirectory, `${receipt.requestId}.json`), receipt),
      });
      active.add(gateway);
      return { ...gateway, async close() { if (!active.delete(gateway)) return; await gateway.close(); } };
    },
    async close() {
      const results = await Promise.allSettled([...active].map(gateway => gateway.close())); active.clear();
      try { await atomicJson(`${manifest.ledgerPath}.summary.json`, ledger.snapshot()); } finally { await ledger.close(); }
      if (results.some(result => result.status === "rejected")) throw new Error("Eval gateway cleanup failed");
    },
  };
}
export type EvalOperations = Awaited<ReturnType<typeof openEvalOperations>>;
