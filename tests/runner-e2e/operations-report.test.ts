import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { openEvalCostLedger } from "./cost-ledger.js";
import { readEvalOperationsReport, renderEvalOperationsReport, validateEvalOperationsReport } from "./operations-report.js";
import { buildRunnerCampaign } from "./history.js";
import { regenerateRunnerDashboard } from "./dashboard-regenerate.js";

it("reports shared setup/retry spending once, preserves unknown holds and omits private provider receipts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-operations-report-"));
  const file = path.join(root, "ledger.jsonl");
  const ledger = await openEvalCostLedger(file, { campaignId: "pilot", maxUsd: "1", deadlineAt: "2099-01-01T00:00:00Z", maxRequests: 10, maxConcurrent: 2 });
  try {
    await ledger.reserve("setup", { executionId: "cell", attemptId: "first", phase: "setup" }, "0.2");
    await ledger.observe({ observationId: "gateway", requestId: "setup", provider: "fixture", providerRequestId: "private-provider-id", source: "gateway",
      currency: "USD", route: "direct", classification: "estimated", pricingVersion: "fixture", costUsd: "0.05", final: true });
    await ledger.observe({ observationId: "native", requestId: "setup", provider: "fixture", providerRequestId: "private-provider-id", source: "native_otlp",
      currency: "USD", route: "direct", classification: "reported", costUsd: "0.05", final: true });
    await ledger.finish("setup", "failed");
    await ledger.reserve("retry", { executionId: "cell", attemptId: "retry", phase: "agent" }, "0.2");
    await ledger.finish("retry", "cancelled");
    const report = await readEvalOperationsReport(file);
    validateEvalOperationsReport(report);
    expect(report).toMatchObject({ knownUsd: "0.050000000", heldUsd: "0.200000000", committedUsd: "0.250000000", requests: 2,
      unresolvedRequests: 1, inflight: 0, breakdown: { reported: "0.050000000", estimated: "0.000000000" },
      attempts: [{ attemptId: "first", requests: 1, knownUsd: "0.050000000" }, { attemptId: "retry", unresolvedRequests: 1, heldUsd: "0.200000000" }] });
    expect(JSON.stringify(report)).not.toContain("private-provider-id");
    const campaign = buildRunnerCampaign({ campaignId: "retry-campaign", generatedAt: new Date().toISOString(), expected: [], results: [], operations: report });
    expect(campaign.operations).toEqual(report);
    expect(campaign.billing.reportedLlmCostUsd).toBe(0);
    await writeFile(path.join(root, "normalized-results.json"), JSON.stringify(campaign));
    await regenerateRunnerDashboard({ bundle: root, historyFile: null });
    const rebuilt = JSON.parse(await readFile(path.join(root, "normalized-results.json"), "utf8"));
    expect(rebuilt.operations).toEqual(report);
    expect(await readFile(path.join(root, "dashboard.html"), "utf8")).toContain("$0.200000000 additional held reservations");
    expect(renderEvalOperationsReport(report)).toContain("Do not add its model subtotal to heartbeat totals");
    expect(renderEvalOperationsReport(report)).toContain("Infrastructure, storage, subscriptions");
    expect(() => validateEvalOperationsReport({ ...report, secret: "forbidden" } as never)).toThrow("Invalid retained");
    expect(() => validateEvalOperationsReport({ ...report, knownUsd: "0.060000000" })).toThrow("Invalid retained");
    expect(() => validateEvalOperationsReport({ ...report, attempts: [] })).toThrow("Invalid retained");
  } finally { await ledger.close(); await rm(root, { recursive: true, force: true }); }
});

it("keeps an in-flight final receipt reserved until the forwarding request finishes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-operations-report-")), file = path.join(root, "ledger.jsonl");
  const ledger = await openEvalCostLedger(file, { campaignId: "pilot", maxUsd: "1", deadlineAt: "2099-01-01T00:00:00Z", maxRequests: 10, maxConcurrent: 2 });
  try {
    await ledger.reserve("request", { executionId: "cell", attemptId: "attempt", phase: "agent" }, "0.2");
    await ledger.observe({ observationId: "usage", requestId: "request", provider: "fixture", source: "provider", currency: "USD", route: "direct", classification: "reported", costUsd: "0.05", final: true });
    const report = await readEvalOperationsReport(file);
    validateEvalOperationsReport(report);
    expect(report).toMatchObject({ inflight: 1, knownUsd: "0.050000000", heldUsd: "0.150000000", committedUsd: "0.200000000", unresolvedRequests: 0 });
  } finally { await ledger.close(); await rm(root, { recursive: true, force: true }); }
});
