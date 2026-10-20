# Bounded eval operations

The request ledger and gateway are opt-in. The ordinary launcher still supports
unmetered legacy campaigns. Do not infer a spending limit from a campaign ID.
Enable the bounded path with `PAPERCLIP_E2E_OPERATIONS_MANIFEST=/absolute/file.json`.
Keep this manifest, its journal, and request receipts private.

## Supported admission

The initial path admits local `core-compatibility` cells for `runner-codex`,
`runner-acpx-claude`, `legacy-codex`, and `legacy-claude`. Each cell must have one
provider credential and an exact priced model. Other suites, remote environments,
subscription profiles, hosted tools, multimodal inputs, premium service modes,
and separate judges fail admission. This whitelist is implementation scope, not
evidence that every admitted harness has passed live qualification.

The launcher owns one loopback HTTP gateway per attempt. The real provider key
stays in the parent launcher. Playwright receives an ephemeral token, and fixture
setup saves that token through a shared AI connection with the existing custom
Responses/Messages routing contract. The agent does not receive ambient provider
keys. The server environment strips the gateway token and upstream credentials.

Every upstream attempt reserves its maximum estimated charge in an fsynced
journal before dispatch. Requests, retries, and cancelled calls retain distinct
IDs. Unknown usage keeps the reservation held. One shared writer serializes
admission across cells, so concurrent requests cannot each spend the same remaining
allowance. Campaign deadline, request count, and in-flight count are also enforced.
Private request receipts retain transport IDs, response IDs, usage and cache TTLs,
route/cache/failover evidence, and final accounting status without request bodies
or credentials. Raw provider responses remain only in the normal private evidence.

## Manifest

A manifest contains no credentials. This structural example uses fixture prices;
replace them with independently verified model prices and context limits before
running a real campaign. The launcher does not discover current prices for you.

```json
{
  "version": 1,
  "limits": {
    "campaignId": "qualification-example",
    "maxUsd": "100",
    "deadlineAt": "2026-10-20T23:00:00Z",
    "maxRequests": 200,
    "maxConcurrent": 1
  },
  "ledgerPath": "/private/path/qualification/ledger.jsonl",
  "executionIds": ["EXACT_SELECTED_EXECUTION_ID"],
  "maxAttemptsPerExecution": 2,
  "route": "direct",
  "models": [{
    "provider": "anthropic",
    "maximumInputTokens": 1000000,
    "maximumOutputTokens": 16384,
    "timeoutMs": 180000,
    "price": {
      "provider": "anthropic",
      "model": "EXACT_SELECTED_MODEL",
      "version": "verified-pricecard-date",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing",
      "inputUsdPerMillion": "2",
      "cachedReadUsdPerMillion": "0.2",
      "cacheWrite5mUsdPerMillion": "2.5",
      "cacheWrite1hUsdPerMillion": "4",
      "outputUsdPerMillion": "10"
    }
  }]
}
```

`executionIds` must equal the launcher's selected set, and the retry option must
fit `maxAttemptsPerExecution`. Use `--list` to resolve the selection first.
The maximum input value is the verified provider context ceiling, **not** a
requested input cap. The gateway clamps output to `maximumOutputTokens`; it does
not tokenize or truncate prompts. The conservative reservation prices the whole
input ceiling at the highest cache-write/long-context rate, plus capped output.
A small daily budget may therefore admit Claude but refuse Codex even when the
expected charge is small. Do not reduce the context ceiling to bypass this guard.

For modern OpenAI models, specify both `cacheWrite30mUsdPerMillion` and
`cacheWrite12hUsdPerMillion`. Optional `longContext` contains `aboveInputTokens`
and a complete `rates` object with the same token-rate fields. Above that total
input threshold (including cache), the estimate uses those rates for the entire
request. Reservations use the maximum rate across both tiers. Missing cache-write
counters, missing TTL splits for nonzero writes, and model mismatches remain
unknown. Older OpenAI models without these usage fields need separate qualification.
Write prices are total token prices, not surcharges. Sources:
[OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[OpenAI prices](https://developers.openai.com/api/docs/pricing), and
[Claude prices](https://platform.claude.com/docs/en/about-claude/pricing).

For Braintrust, use `route: "braintrust"`, add the exact `projectId` UUID, and
provide `BRAINTRUST_API_KEY` securely. Configure project providers named
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Disable default provider fallback in the
project. The request pins that endpoint and project, disables gateway response
caching, and never automatically retries or requests fallback. A cache hit,
failover header, or unexpected successful endpoint invalidates the receipt and
holds its reservation. Provider prompt caching stays enabled and is metered.
The response stream is passed through and cumulative usage is counted once.
Gateway and native tracing are separate opt-ins; see the README tracing section.

## Inspection and limits

- `operations-preflight.json` preserves the exact manifest in the campaign folder.
- `ledger.jsonl` is the append-only authority for request admission and observations.
- `ledger.jsonl.requests/` contains private per-request checkpoints.
- `ledger.jsonl.summary.json` preserves known, reserved/held, conflicting, and
  unknown amounts on normal finalization, including failed campaign workers.
- `campaign.json` and the dashboard preserve retained attempts and show missing
  selected results after worker failure. Their request-ledger section shows the
  shared ledger's known subtotal, classifications, additional held reservations,
  unresolved requests and per-attempt totals. It can include earlier campaigns
  sharing that budget. It is a separate view of model spending: do not add it to
  heartbeat totals. The journal hash and record count identify the checkpoint.
- To regenerate a merged report with the same ledger, pass
  `PAPERCLIP_E2E_OPERATIONS_LEDGER=/absolute/ledger.jsonl` to `report.ts`.
  Dashboard refresh and public publication preserve and validate its closed
  numeric projection. Raw request receipts and the journal remain private.

All model amounts from usage times a pricecard are **estimated**, not billed or
reconciled. This path does not yet price CI compute, storage, subscriptions,
Daytona, separate judges, or gateway overhead. Unknown observations and these
coverage gaps must be included in operational reporting. Provider billing can
lag and discounts can differ; a local list-price cap is not a provider-side cap.

Resuming the same journal requires exactly the original limits. A dead process
can leave a lock and held reservations; inspect the owner and upstream receipts
before recovering it. Never delete a live writer's lock or reset a ledger merely
to regain budget. The per-invocation retry limit is not yet a durable cross-restart
attempt counter; the shared request and dollar caps still apply across restarts.

No recurring schedule is enabled by this integration. Qualification of actual
agent streams, tools, continuation, cancellation, native traces, and remote routes
is required before treating those routes as operationally proven. Forecasts,
provider reconciliation, and the campaign feedback disposition workflow are
separate remaining integration work.
