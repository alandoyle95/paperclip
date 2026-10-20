import { createHash } from "node:crypto";
import type { AgentCommentaryDetail, AgentCommentaryPage } from "../../packages/shared/src/validators/agent-commentary.js";
import type { RunnerApi } from "./api.js";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export type FeedbackCollectionStatus = "complete" | "partial" | "unavailable" | "not_started";
export interface FeedbackSummary {
  version: 1;
  collection: FeedbackCollectionStatus;
  invocationCollection: FeedbackCollectionStatus;
  /** A successful list is evidence of no saved feedback, not of tool availability. */
  toolAvailability: "observed" | "unknown";
  complaints: number;
  suggestions: number;
  bodiesCollected: number;
  runsInspected: number;
  invocations: { completed: number; failed: number; unknown: number };
  review: Array<{ fingerprint: string; kind: "complaint" | "suggestion"; occurrences: number; disposition: "needs_investigation" }>;
}
interface FeedbackInvocation {
  runId: string;
  callId: string;
  kind: "complaint" | "suggestion";
  outcome: "completed" | "failed" | "unknown";
}
export interface FeedbackEvidence {
  version: 1;
  companyId: string;
  entries: AgentCommentaryDetail[];
  invocations: FeedbackInvocation[];
  diagnostics: Array<"feedback_read_failed" | "feedback_detail_failed" | "feedback_pagination_incomplete" | "run_read_failed" | "run_limit_reached" | "events_read_failed" | "deadline_reached">;
  summary: FeedbackSummary;
}

export function emptyFeedbackSummary(): FeedbackSummary {
  return { version: 1, collection: "not_started", invocationCollection: "not_started", toolAvailability: "unknown",
    complaints: 0, suggestions: 0, bodiesCollected: 0, runsInspected: 0,
    invocations: { completed: 0, failed: 0, unknown: 0 }, review: [] };
}

function feedbackKind(name: unknown): FeedbackInvocation["kind"] | undefined {
  if (typeof name !== "string") return undefined;
  if (/(?:^|[.\/])submit_complaint$/.test(name)) return "complaint";
  if (/(?:^|[.\/])submit_suggestion$/.test(name)) return "suggestion";
  return undefined;
}

/** Read tool receipts, never model prose claiming that a submission happened. */
export function observeFeedbackInvocations(runId: string, events: readonly Row[]): FeedbackInvocation[] {
  const calls = new Map<string, FeedbackInvocation>();
  for (const event of events) {
    const envelope = row(row(event.payload).prpEvent);
    if (envelope.runId !== runId || envelope.sourceKind !== "runner" || envelope.eventType !== event.eventType) continue;
    const payload = row(envelope.payload), item = row(payload.item);
    const execution = typeof event.eventType === "string" && event.eventType.startsWith("tool.execution.");
    const callId = execution ? payload.executionId : item.id;
    if (typeof callId !== "string" || !callId) continue;
    const kind = feedbackKind(execution ? payload.name : item.name);
    const started = event.eventType === "tool.execution.started" || event.eventType === "item.started" && (payload.kind === "tool_call" || item.type === "tool_call");
    if (started && kind) calls.set(callId, calls.get(callId) ?? { runId, callId, kind, outcome: "unknown" });
    const completed = event.eventType === "tool.execution.completed" || event.eventType === "item.completed" && (payload.kind === "tool_result" || item.type === "tool_result");
    const call = calls.get(callId);
    if (!completed || !call || kind && kind !== call.kind) continue;
    const status = execution ? payload.status : item.status;
    // Completion is transport evidence only. Saved commentary is read separately.
    if (payload.isError === true || item.isError === true || ["failed", "error", "cancelled"].includes(String(status))) call.outcome = "failed";
    else if (status === "completed") call.outcome = "completed";
  }
  return [...calls.values()];
}

export function feedbackReview(entries: readonly AgentCommentaryDetail[]): FeedbackSummary["review"] {
  const groups = new Map<string, FeedbackSummary["review"][number]>();
  for (const entry of entries) {
    const fingerprint = createHash("sha256").update(`${entry.kind}\n${entry.body.trim().replace(/\s+/g, " ")}`).digest("hex");
    const group = groups.get(fingerprint);
    if (group) group.occurrences++;
    else groups.set(fingerprint, { fingerprint, kind: entry.kind, occurrences: 1, disposition: "needs_investigation" });
  }
  return [...groups.values()];
}

export function summarizeCampaignFeedback(attempts: readonly { feedback?: FeedbackSummary }[]) {
  const review = new Map<string, FeedbackSummary["review"][number]>();
  let complaints = 0, suggestions = 0, incomplete = 0, failedSubmissions = 0, unknownSubmissions = 0;
  for (const { feedback } of attempts) {
    if (!feedback || feedback.collection !== "complete" || feedback.invocationCollection !== "complete") incomplete++;
    if (!feedback) continue;
    complaints += feedback.complaints;
    suggestions += feedback.suggestions;
    failedSubmissions += feedback.invocations.failed;
    unknownSubmissions += feedback.invocations.unknown;
    for (const group of feedback.review) {
      const previous = review.get(group.fingerprint);
      if (previous) previous.occurrences += group.occurrences;
      else review.set(group.fingerprint, { ...group });
    }
  }
  return { complaints, suggestions, incomplete, failedSubmissions, unknownSubmissions, review: [...review.values()] };
}

/** Company-wide capture includes child/background runs. Caller persists each checkpoint before teardown. */
export async function collectAttemptFeedback(input: {
  api: Pick<RunnerApi, "get">;
  companyId: string;
  persist: (evidence: FeedbackEvidence) => Promise<void>;
  deadlineAt?: number;
}): Promise<FeedbackSummary> {
  const deadlineAt = input.deadlineAt ?? Date.now() + 30_000;
  const summary = emptyFeedbackSummary();
  const evidence: FeedbackEvidence = { version: 1, companyId: input.companyId, entries: [], invocations: [], diagnostics: [], summary };
  const get = <T>(url: string) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("Feedback collection deadline reached");
    return input.api.get<T>(url, { timeout: Math.min(5_000, remaining) });
  };
  const persist = async () => {
    summary.bodiesCollected = evidence.entries.length;
    summary.review = feedbackReview(evidence.entries);
    summary.invocations = { completed: 0, failed: 0, unknown: 0 };
    for (const invocation of evidence.invocations) summary.invocations[invocation.outcome]++;
    summary.toolAvailability = evidence.invocations.length ? "observed" : "unknown";
    await input.persist(evidence);
  };
  // This write is deliberately outside read-error handling: storage failure must
  // be visible to the caller rather than masquerading as successful collection.
  await persist();
  const seen = new Set<string>();
  let expectedTotal: number | undefined;
  let detailsFailed = false;
  for (let offset = 0; offset < 10_000; offset += 100) {
    let page: AgentCommentaryPage;
    try {
      page = await get<AgentCommentaryPage>(`/api/companies/${input.companyId}/agent-commentary?limit=100&offset=${offset}`);
      if (!Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0 || page.items.length > 100) throw new Error("Invalid feedback page");
    } catch {
      summary.collection = seen.size ? "partial" : "unavailable";
      evidence.diagnostics.push("feedback_read_failed");
      break;
    }
    expectedTotal ??= page.total;
    summary.collection = "partial";
    for (const entry of page.items) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (entry.kind === "complaint") summary.complaints++;
      else if (entry.kind === "suggestion") summary.suggestions++;
      else { detailsFailed = true; continue; }
      try {
        const detail = await get<AgentCommentaryDetail>(`/api/companies/${input.companyId}/agent-commentary/${encodeURIComponent(entry.id)}`);
        if (detail.id !== entry.id || detail.kind !== entry.kind || detail.runId !== entry.runId || typeof detail.body !== "string") throw new Error("Invalid feedback detail");
        evidence.entries.push(detail);
      } catch {
        detailsFailed = true;
        evidence.diagnostics.push("feedback_detail_failed");
      }
      await persist();
    }
    if (offset + page.items.length >= page.total || page.items.length < 100) {
      if (seen.size === page.total && expectedTotal === page.total && !detailsFailed) summary.collection = "complete";
      else evidence.diagnostics.push("feedback_pagination_incomplete");
      break;
    }
    if (offset === 9_900) evidence.diagnostics.push("feedback_pagination_incomplete");
  }
  await persist();
  let runs: Array<{ id: string; runtimeMode?: string; status?: string }>;
  try {
    runs = await get(`/api/companies/${input.companyId}/heartbeat-runs?limit=1000`);
    if (!Array.isArray(runs) || runs.some(run => typeof run.id !== "string")) throw new Error("Invalid runs");
  } catch {
    summary.invocationCollection = "unavailable";
    evidence.diagnostics.push("run_read_failed");
    await persist();
    return summary;
  }
  summary.invocationCollection = runs.length < 1000 ? "complete" : "partial";
  if (runs.length >= 1000) evidence.diagnostics.push("run_limit_reached");
  for (const run of runs) {
    if (!["succeeded", "interrupted", "failed", "cancelled", "timed_out"].includes(run.status ?? "")) {
      summary.collection = summary.collection === "complete" ? "partial" : summary.collection;
      summary.invocationCollection = "partial";
    }
    // Legacy shell helpers are not fully represented by native tool receipts.
    if (run.runtimeMode !== "native") summary.invocationCollection = "partial";
    const events: Row[] = [];
    let afterSeq = 0;
    try {
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = await get<Row[]>(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`);
        if (!Array.isArray(page) || page.length > 1000) throw new Error("Invalid events");
        for (const event of page) {
          if (!Number.isSafeInteger(event.seq) || Number(event.seq) <= afterSeq) throw new Error("Invalid event sequence");
          afterSeq = Number(event.seq);
          events.push(event);
        }
        if (page.length < 1000) break;
        if (pageNumber === 99) throw new Error("Event limit reached");
      }
      summary.runsInspected++;
    } catch {
      summary.invocationCollection = "partial";
      evidence.diagnostics.push("events_read_failed");
    }
    evidence.invocations.push(...observeFeedbackInvocations(run.id, events));
    await persist();
    if (Date.now() >= deadlineAt) {
      summary.invocationCollection = "partial";
      evidence.diagnostics.push("deadline_reached");
      break;
    }
  }
  await persist();
  return summary;
}
