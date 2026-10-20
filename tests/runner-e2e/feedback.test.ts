import { expect, it } from "vitest";
import type { AgentCommentaryDetail } from "../../packages/shared/src/validators/agent-commentary.js";
import type { RunnerApi } from "./api.js";
import { collectAttemptFeedback, emptyFeedbackSummary, feedbackReview, observeFeedbackInvocations, summarizeCampaignFeedback, type FeedbackEvidence } from "./feedback.js";
import { runCleanupWithObservers } from "./cleanup-verification.js";
import { isHistoricalBundlePathAllowed } from "./history-publish.js";

function entry(id: string, body = "Please preserve the original tool error."): AgentCommentaryDetail {
  return { id, kind: "complaint", preview: body.slice(0, 280), body,
    createdAt: "2026-10-20T00:00:00.000Z", agent: { id: "agent", name: "Fixture", icon: null }, runId: "run", task: null };
}
const api = (read: (path: string) => unknown | Promise<unknown>) => ({ get: async <T>(path: string) => await read(path) as T }) as Pick<RunnerApi, "get">;
const event = (seq: number, eventType: string, payload: unknown, runId = "run") => ({ seq, eventType,
  payload: { prpEvent: { runId, sourceKind: "runner", eventType, payload } } });

it("collects full paginated company feedback, including feedback outside the selected task, and checkpoints it", async () => {
  const entries = Array.from({ length: 101 }, (_, i) => ({ ...entry(String(i), "a".repeat(300)), runId: `child-${i}` }));
  const checkpoints: FeedbackEvidence[] = [];
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async value => { checkpoints.push(structuredClone(value)); },
    api: api(path => {
      if (path.includes("agent-commentary?")) {
        const offset = Number(new URL(path, "http://fixture").searchParams.get("offset"));
        return { items: entries.slice(offset, offset + 100).map(({ body: _body, ...rest }) => rest), total: 101 };
      }
      if (path.includes("agent-commentary/")) return entries[Number(path.split("/").at(-1))];
      return [];
    }),
  });
  expect(summary).toMatchObject({ collection: "complete", complaints: 101, bodiesCollected: 101, toolAvailability: "unknown" });
  expect(summary.review).toEqual([{ fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), occurrences: 101, kind: "complaint", disposition: "needs_investigation" }]);
  expect(checkpoints.at(-1)!.entries[100]!.body).toHaveLength(300);
  expect(checkpoints.some(value => value.entries.length === 1)).toBe(true);
  expect(JSON.stringify(summary)).not.toContain("aaa");
});

it("keeps saved-feedback absence separate from unavailable reads and unknown tool availability", async () => {
  const empty = await collectAttemptFeedback({ companyId: "company", persist: async () => {},
    api: api(path => path.includes("agent-commentary") ? { items: [], total: 0 } : []),
  });
  expect(empty).toMatchObject({ collection: "complete", complaints: 0, suggestions: 0, toolAvailability: "unknown" });
  const unavailable = await collectAttemptFeedback({ companyId: "company", persist: async () => {}, api: api(() => { throw new Error("unavailable"); }) });
  expect(unavailable).toMatchObject({ collection: "unavailable", invocationCollection: "unavailable", complaints: 0 });
});

it("retains partial bodies and failed submissions without inventing persistence from a completed tool", async () => {
  let retained: FeedbackEvidence | undefined;
  const events = [
    event(1, "tool.execution.started", { name: "submit_suggestion", executionId: "failed" }),
    event(2, "tool.execution.completed", { name: "submit_suggestion", executionId: "failed", status: "failed" }),
    event(3, "tool.execution.started", { name: "submit_complaint", executionId: "done" }),
    event(4, "tool.execution.completed", { name: "submit_complaint", executionId: "done", status: "completed" }),
    event(5, "tool.execution.started", { name: "submit_suggestion", executionId: "interrupted" }),
  ];
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async value => { retained = structuredClone(value); },
    api: api(path => {
      if (path.includes("agent-commentary?")) return { items: [entry("1"), entry("2")], total: 2 };
      if (path.endsWith("agent-commentary/1")) return entry("1");
      if (path.endsWith("agent-commentary/2")) throw new Error("body unavailable");
      if (path.includes("/events?")) return events;
      return [{ id: "run", runtimeMode: "native", status: "failed" }];
    }),
  });
  expect(summary).toMatchObject({ collection: "partial", complaints: 2, bodiesCollected: 1, invocationCollection: "complete",
    invocations: { completed: 1, failed: 1, unknown: 1 } });
  expect(retained!.diagnostics).toContain("feedback_detail_failed");
});

it("binds native invocations to their run, ignores prose, and recognizes compatibility receipts", () => {
  const events = [
    event(1, "item.started", { kind: "tool_call", item: { type: "tool_call", id: "call", name: "paperclip.submit_complaint" } }),
    event(2, "item.completed", { kind: "tool_result", item: { type: "tool_result", id: "call", status: "completed", isError: true } }),
    event(3, "tool.execution.started", { name: "submit_suggestion", executionId: "foreign" }, "foreign-run"),
    event(4, "item.completed", { item: { type: "agentMessage", text: "I used submit_complaint" } }),
  ];
  expect(observeFeedbackInvocations("run", events)).toEqual([{ runId: "run", callId: "call", kind: "complaint", outcome: "failed" }]);
});

it.each([{ runtimeMode: "legacy", status: "succeeded" }, { runtimeMode: "native", status: "running" }])("does not claim complete invocation coverage for legacy helpers or still-active work: %o", async run => {
  const summary = await collectAttemptFeedback({ companyId: "company", persist: async () => {}, api: api(path => {
    if (path.includes("agent-commentary")) return { items: [], total: 0 };
    if (path.includes("/events?")) return [];
    return [{ id: "run", ...run }];
  }) });
  expect(summary.invocationCollection).toBe("partial");
});

it("captures feedback after cancellation failure but before destructive teardown, and still tears down if persistence fails", async () => {
  const calls: string[] = [];
  const result = await runCleanupWithObservers({
    retireRuns: async () => { throw new Error("cancel failed"); }, assertions: [],
    teardown: async () => {
      try {
        await collectAttemptFeedback({ companyId: "company", api: api(() => []), persist: async () => { calls.push("capture"); throw new Error("disk full"); } });
      } finally { calls.push("teardown"); }
    },
  });
  expect(calls).toEqual(["capture", "teardown"]);
  expect(result.errors).toHaveLength(2);
});

it("bounds collection by a deadline and retains content-free diagnostics", async () => {
  let requests = 0, last: FeedbackEvidence | undefined;
  const summary = await collectAttemptFeedback({ companyId: "company", deadlineAt: 0,
    persist: async value => { last = structuredClone(value); }, api: api(() => { requests++; throw new Error("secret response"); }),
  });
  expect(requests).toBe(0);
  expect(summary.collection).toBe("unavailable");
  expect(JSON.stringify(last)).not.toContain("secret response");
});

it("groups identical feedback for one review without conflating kinds", () => {
  expect(feedbackReview([entry("1", " slow  request "), entry("2", "slow request"), { ...entry("3", "slow request"), kind: "suggestion" }]))
    .toMatchObject([{ kind: "complaint", occurrences: 2 }, { kind: "suggestion", occurrences: 1 }]);
});

it("groups feedback across retries without omitting incomplete collection and keeps bodies out of public history", () => {
  const feedback = { ...emptyFeedbackSummary(), complaints: 1, review: feedbackReview([entry("1")]) };
  const aggregate = summarizeCampaignFeedback([{ feedback }, { feedback }, {}]);
  expect(aggregate).toMatchObject({ complaints: 2, incomplete: 3, review: [{ occurrences: 2 }] });
  expect(feedback.review[0]!.occurrences).toBe(1);
  expect(JSON.stringify(aggregate)).not.toContain(entry("1").body);
  expect(isHistoricalBundlePathAllowed("evidence/case/attempt-1/snapshots/agent-feedback.json")).toBe(false);
});
