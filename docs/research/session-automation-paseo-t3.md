# Paseo and T3 Code: scheduled automation and session continuation

Research for [Tessera #522](https://github.com/horang-labs/tessera/issues/522), feeding [the session automation wave](../design/session-automation-wave.md). Research snapshot: 2026-10-02, remote main tips rechecked at 13:37 UTC. This document describes source behavior, not a runtime certification or an approved Tessera implementation design.

## Source provenance and method

| Repository | Branch | Before pull | After `git pull --ff-only` |
| --- | --- | --- | --- |
| getpaseo/paseo | main → main | `5599f9e567128a1240b3b15afab28bceef9d36a5` | `1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05` |
| pingdotgg/t3code | main → main | `0fcd5f90611451cca842689faea53b5450c022da` | `54084ae1e6c32809db040e4fa571c80fdf2d8ae4` |

Both checkouts had only `?? graphify-out/` before and after their successful fast-forward pulls. Existing graph files were preserved; no competitor product files were edited. `gh api repos/{owner}/{repo}/commits/main` independently returned the same final SHAs. These are main snapshots, not claims about installed releases.

Used existing graph vocabulary and `graphify query "schedule cadence cron" --budget 2000` for Paseo and `graphify query "orchestration continuation queued reactor" --budget 2000` for T3 Code. Queries were truncated (61/135 and 58/868 nodes shown); they served only as navigation. `graphify explain` on `schedule-cadence-policy.ts` and `defaultProviderContinuationIdentity()` supplied narrower relationships. Graph freshness is unknown; for example the T3 identity function moved from graph line 81 to source line 98. All behavioral conclusions below use exact reads of the pulled source. Graph operations used no LLM extraction/API tokens; traversal budgets are output limits, not measured billing.

## Comparison

| Concern | Paseo | T3 Code |
| --- | --- | --- |
| Timed automation | Persisted cron schedules; new-agent jobs and existing-agent heartbeats | No user-configurable timed prompt scheduler identified in the searched scope below |
| Continuation | Heartbeat prompt plus provider-native autonomous turns | Provider-native synthetic turns; opt-in continuation after server restart |
| Storage | One JSON schedule with embedded run history, atomic rename writes | SQLite orchestration events/command receipts/provider resume state; separate client queues |
| Busy/approval handling | In-flight agent heartbeat fails; permission wait fails the schedule run | Web queue waits at approval/questions and dispatches at tool/turn boundaries; restart recovery is separate |
| Missed execution | Restart skips overdue slots; live delayed tick can run one overdue slot | Restart resumes eligible interrupted work; no timed-slot catch-up feature established |
| Main lesson | Concrete product model and cadence UX | Explicit lifecycle, environment identity, durable recovery intent and input gates |

Evidence and qualifications follow; neither product demonstrates a safe generic PTY continuation contract merely by exposing an idle status.

## Paseo findings

### Product, cadence and boundedness

Paseo separates fresh-agent **schedules** from same-agent **heartbeats** in its [public overview][p-overview]. The shared [schema][p-types] stores prompt, target, status (`active`, `paused`, `completed`), next/last run, expiry, max runs and run records. Each run has scheduled/start/end times, status, agent/workspace references, output and error. New-agent settings include provider, model, mode, thinking option, provider options, feature values, system prompt, MCP servers, working directory, isolation and archive behavior.

Public creation uses cron; the schema and [cadence engine][p-cron] retain legacy `everyMs`. Cron is five-field, minute-granular, UTC if timezone is omitted, otherwise evaluated using an IANA timezone through `Intl`. The implementation requires **both** day-of-month and day-of-week matches and scans at most 366 days. Do not assume another cron library's day-field semantics or rare-date behavior. DST cases need explicit tests before reuse. An explicit absolute-date one-shot cadence is absent from this schema: `maxRuns: 1` can bound the next recurring slot; `runOnce` is an immediate manual execution, not an at-time timer.

[Creation][p-create] persists `nextRunAt`; cron defaults to the next slot while legacy interval creation defaults to immediate execution. Limits and expiry default to null, including [MCP heartbeat creation][p-heartbeat], which binds the target to the caller agent. Therefore bounds are available, not mandatory. [Completion counting][p-count] includes failed as well as successful finished runs. [Manual run-once][p-manual] rejects completed/already-running schedules; its finish branch does not advance cadence or immediately recompute completion, though the persisted run contributes to later limit checks.

### Ownership, persistence and recovery

The daemon [constructs and starts one schedule service][p-bootstrap]. [Startup][p-start] recovers interrupted records, sweeps missing/archived heartbeat targets, then polls every second. [Store serialization][p-store] uses per-schedule and name/target promise maps within the process. Writes use [temporary file plus rename][p-atomic], without an explicit fsync. Named MCP creation upserts a matching noncompleted name/target; anonymous creation does not deduplicate. These mechanisms are not evidence of cross-process leases or exactly-once prompt delivery.

[Execution][p-execution] records a random run ID before calling the runner and uses an in-memory running-ID set. Run history remains embedded in the schedule JSON; no pruning appears in the inspected store/service. The append is before the runner's `try/finally`: an append failure can leave the in-memory running-ID guard set until restart (source-derived failure possibility, not reproduced). Atomic file replacement does not atomically couple a persisted run to an external provider receiving its prompt.

[Restart recovery][p-recovery] changes the first persisted running record to failed and advances overdue `nextRunAt` repeatedly until strictly in the future. It can archive an interrupted new-agent workspace. This skips missed slots instead of replaying them. By contrast, if the process survives a sleep/event-loop pause, [tick][p-tick] accepts an overdue active schedule and runs it once, then [finish][p-finish] advances to a future slot. This live-resume behavior is inferred from those branches; no machine-sleep experiment was run. An expired/exhausted schedule completes before dispatch. A missing target completes permanently; transient failures normally leave recurrence active.

### Input gates and success semantics

For an existing agent, [the runner][p-target] verifies existence/archive state, loads the agent and rejects `hasInFlightRun`. This exception becomes a failed run, rather than a pending busy retry; it can consume `maxRuns`. After that check the runner calls `startAgentRun` with `replaceRunning: true` and `activeTurnBehavior: "steer"`. [The helper][p-prompt] can steer or replace an active run, so this precheck is not proof of atomic idle-only delivery if another input races with it. No protection for a user's partially typed PTY line is established by these inspected functions.

The runner waits for an agent event and treats permission waiting/error as failure. New-agent execution additionally checks cancellation and forwards stored provider configuration through the existing create path. It requests unattended execution and defaults workspace archival on finish to true. [Mode resolution][p-mode] respects an explicit mode but can choose the provider's unattended mode when omitted. Tessera should make permission policy explicit rather than inherit such a default accidentally.

The generic run status becomes `succeeded` when the runner returns. This means a turn/run finished without the checked errors; it does **not** verify a build passed, a PR merged, or the user's objective is complete. Limits/expiry/target removal are termination mechanisms; this scheduler is not an objective-completion detector.

### Background continuation and UX

Separately from schedules, the [Claude adapter][p-autonomous] opens autonomous turns when assistant/tool-progress/task-notification messages arrive without a foreground turn, subject to interrupt suppression. Its [runtime-exit handling][p-runtime-exit] marks background runtime tasks failed and reports an error even when the process dies between turns. This observes provider-native wake-ups; it is not a persisted scheduler recreating background shells after a crash. Other provider implementations were not exhaustively audited.

The app [aggregates schedules by host and filters active/ended states][p-screen]. [Rows][p-row] show cadence, created/last/next run, host identity and edit/pause/resume/run/delete actions. The [CLI documentation][p-cli] exposes inspect/logs and remote-host targeting; the service returns full run history through `logs`. A full graphical per-run log viewer was not established from the screen/row files inspected. Those sources support a practical Tessera UI: clear target, execution host, saved settings, next run, explicit pause/delete and inspectable history.

## T3 Code findings

### Timed scheduling: scoped negative result

No user-configurable cron/at-time prompt automation, recurring heartbeat definition, or corresponding scheduler run history was identified in these pulled source trees: `apps/server/src`, `apps/web/src`, `apps/mobile/src`, `packages/contracts/src`, `docs`. Searches used `rg -n -i`, normal ignore rules, and excluded `*.test.*`, `*.spec.*`, `*.snap`:

- `\bcron\b|nextRunAt|scheduledFor|expiresAt|\bmaxRuns\b|heartbeat|scheduled automation`: 275 matching lines in 53 files; deadline fields mostly concern auth, assets and usage. Heartbeats concern telemetry/provider progress.
- `\bschedul(e|ed|er|ing)\b|catch.?up|wake.?up`: 162 lines in 61 files; matches include Effect retry/poll schedules, connection/subscription replay, UI timers, release automation and snooze UI.
- `continueThreadsAfterServerUpdate|continueAfterServerUpdate|promptlessTurnContinuation`: 56 lines in 11 files, leading to the positive restart findings below.

This is not proof of repository-wide or future absence. Excluded scope includes other branches, ignored files/dependencies, marketing/desktop/cloud-worker trees and externally installed provider features. In particular, [engineering guidance mentioning scheduled tasks][t-guidance] is an architectural recommendation, not an implementation. [Snooze UI][t-snooze] returns a `snoozedUntil` value, while [settlement policy][t-settle] uses it to decide eligibility; those reads do not establish prompt injection at the snooze deadline. Network catch-up is not missed-job replay.

### Restart continuation and provider configuration

[User guidance][t-updating] and [settings defaults][t-settings] make continuation after restarts opt-in and off by default; the app/server must actually restart, and saved provider resume state is required. Server-side preference is resolved per project/environment, not dependent on a connected renderer remaining alive.

[Preparation][t-mark] records the current active turn ID in the provider binding for unarchived, undeleted running threads with a resume cursor. [Startup reconciliation][t-reconcile] excludes already-live sessions; it recognizes matching explicit continuation markers or eligible interrupted running work under the preference. It handles a prepared session that already reports ready, persists `starting` plus a prepared marker before sending, and rejects missing resume state/archived/deleted candidates. Failed reconciliation settles the session as error, with a user-facing instruction to send a new message.

[Dispatch][t-dispatch] uses promptless continuation only when the provider advertises it; otherwise it sends a short explicit continuation prompt through `ProviderService.sendTurn`. The service [rejects unsupported promptless calls][t-capability]. Markers clear after successful send; interruption preserves them. This is crash-recovery intent, not recurring scheduling or proof that provider-side work executes exactly once. A process failure after provider acceptance but before marker clearing remains an uncertainty unless acknowledgment/turn identity can be reconciled; this audit did not fault-inject that window. The restart routine itself contains no explicit pending-approval/user-question preflight comparable to the web queue below; do not attribute that queue's gates to this path.

[SQLite runtime storage][t-runtime] persists resume cursor and runtime payload. [Model selection][t-model] carries provider instance ID, model and options. [Continuation identity][t-identity] normally includes driver kind and instance ID; [the command reactor][t-provider-switch] rejects cross-driver or incompatible resume-state instance switches. The lesson is to preserve the actual provider/account/environment identity and settings, not just a model display label.

### Queues, boundaries and deduplication

The [web queue][t-web-queue] snapshots prompt, attachments, model/modes and prompt effort. It is explicitly in-memory. `isQueuedMessageDue` blocks connecting/manual-hold states, allows a new completed-tool boundary while running, or sends when no longer running. The root-mounted [queue sender][t-web-sender] holds for disconnected/non-live state, missing config, rewind, another send, unacknowledged previous dispatch, approval and user-input requests. It serves offscreen threads, but still requires the client process. A tool-boundary steer is not necessarily a safe Tessera raw-PTY input boundary.

The [mobile outbox schema][t-mobile-model] includes environment/thread/message/command IDs and optional model/runtime/interaction snapshots; [storage][t-mobile-storage] saves JSON per message in the application's document directory and flushes in-flight writes before app updates. Its delivery policy waits for connected/live shell state when creating a thread and removes an already-created target. Existing-thread delivery returns send when connected: the `threadBusy` argument is not consulted in that function. Do not describe this mobile outbox as the web queue's idle/approval gate. Provider attachment/config checks and revision-aware editing exist in [the mobile drain][t-mobile-drain], but this audit did not establish identical provider-specific busy behavior across both clients.

Server-side [orchestration receipts][t-receipts] deduplicate accepted command IDs against their aggregate and commit event/projection updates plus receipt in a SQL transaction. This is a useful persistence seam; it is not a guarantee that an external provider side effect and its database acknowledgment share a transaction. Neither client queue inspected has a due-time recurrence model.

### Background liveness is separate from goal completion

The [Claude adapter][t-synthetic] synthesizes a new turn for assistant output arriving without an active turn. The [background-liveness registry][t-liveness] tracks active agent work vs monitoring tasks separately from foreground turns. It is in-memory and empty after server restart until events arrive; session death clears its entries. [Automatic settlement][t-settle] is blocked by pending approvals/questions, starting/running sessions, background liveness or a queued turn start. These are useful distinctions, but settlement is a product organization policy, not a verifier of a user objective.

## Concrete recommendations for the Tessera wave

These are proposed design inputs, not claims about existing Tessera internals. The architecture research ticket must map them to actual lifecycle/prompt-delivery seams before implementation.

1. **One execution engine, two explicit target kinds.** Adopt Paseo's existing-Session continuation versus create-Session distinction. Store user opt-in, owner user ID, execution environment, project/worktree/Session target, prompt, immutable provider/model/effort/settings snapshot, timezone, schedule kind, persisted due time, expiry, run cap and disabled state. Support absolute one-shot due times directly; do not simulate them with a recurring cron plus a limit.
2. **Backend owns due work and run records.** Use the existing Tessera persistence layer with one owner-aware scheduler, transactionally claiming an occurrence keyed by automation ID, configuration revision and scheduled time. Persist a stable delivery ID before dispatch, with bounded lease recovery if multiple backend owners are possible. UI timers only display state. Named-create upsert and an in-memory set alone are insufficient deduplication.
3. **Make safe admission a shared delivery contract.** Reuse normal Session prompt/lifecycle paths, carrying user ID and `agentEnvironment` throughout. Under a per-Session delivery lock, recheck runtime identity/generation, idle boundary, approvals/questions, active user draft/input, user queue and live background work. A simultaneous user send wins. If PTY draft emptiness cannot be established, defer and expose why; do not inject text or Enter over it. Never silently switch providers, auto-approve or use steer/replace to get around a busy boundary.
4. **Bound continuation and separate outcomes.** Default continuation off, with a finite run budget and expiry when enabled; exact default values belong to final design. Distinguish `deferred_busy`, `blocked_permission`, `dispatched`, `turn_ended`, `failed`, `unknown_delivery`, `expired`, and explicit goal outcome. A turn ending schedules a later reassessment only under opt-in; it never proves success. Busy deferrals should not consume a delivered-run budget but must still expire and back off. User disable prevents future sends; cancellation of an already-dispatched run is a separate action.
5. **Define one restart/sleep catch-up policy.** Proposed default: coalesce missed recurring slots to at most one due attempt within a configured grace window; record older misses and advance. One-shot execution after its grace window becomes missed/expired. Recheck caps/expiry and admission after either sleep or restart. Expose the policy in the UI; do not reproduce Paseo's implicit distinction. Never blindly redeliver an uncertain post-send crash: reconcile delivery identity or pause for review.
6. **Expose intent and evidence in both Session surfaces.** Show target, owner host, saved provider/settings, next run, expiry/remaining budget, blocked reason and per-occurrence history with Session links. Give existing-Session wake-ups a visible badge and disable control in normal panel and Kanban Session Peek. Distinguish schedule lifecycle from run failure and goal completion. Allow explicit history inspection without presenting transport acceptance as task success.
7. **Preserve the real OS boundary.** Apply the wave's Windows-backend + WSL-CLI path translation and owner requirements; a competitor's local `cwd` stat is not transferable proof. Resolve stored paths on the correct side, canonicalize overlay symlinks and do not read server-home provider state as CLI-home state. The future implementation must be verified in isolated packaged Electron, with ordered screenshots copied to Windows Downloads; normal panel and Peek must both be exercised if input changes.

## Verification limits and future test seams

This ticket changed documentation only. No product code, provider sessions, live profiles, runtime smoke tests, TDD tests, typecheck, lint or full test suite were run. TDD has no executable seam in this deliverable. Existing Paseo [schedule tests][p-tests] were read for restart advancement and config forwarding, not executed; test names alone are not pass evidence. No cross-platform, sleep/DST, multi-process, disk-failure or crash-after-send behavior was experimentally verified. Licensing/reuse of competitor code is outside scope; recommendations concern behavior and architecture.

Meaningful future implementation seams: deterministic clock/cadence (one-shot, DST, expiry, catch-up); atomic claim/delivery receipt with crash points before/after provider acceptance; input admission racing user typing, permission prompts and native background wake; provider identity/settings retention; owner/environment path translation; UI history/disable and panel/Peek parity. Runtime claims should wait for those checks. Orca is covered by the separate primary-competitor research ticket; optional Proliferate/Automaker expansion was unnecessary here.

[p-overview]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/public-docs/schedules.md
[p-types]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/protocol/src/schedule/types.ts
[p-cron]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/schedule/cron.ts#L79-L117
[p-create]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/schedule/service.ts#L301-L377
[p-heartbeat]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/agent/tools/paseo-tools.ts#L2603-L2649
[p-count]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/schedule/service.ts#L129-L148
[p-manual]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/schedule/service.ts#L537-L547
[p-bootstrap]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/bootstrap.ts#L1345-L1355
[p-start]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/schedule/service.ts#L266-L299
[p-store]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/schedule/store.ts
[p-atomic]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/atomic-file.ts
[p-execution]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/schedule/service.ts#L690-L747
[p-recovery]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/schedule/service.ts#L584-L687
[p-tick]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/schedule/service.ts#L549-L568
[p-finish]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/schedule/service.ts#L750-L811
[p-target]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/schedule/service.ts#L836-L969
[p-prompt]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/agent/agent-prompt.ts#L39-L81
[p-mode]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/agent/create-agent-mode.ts#L43-L81
[p-autonomous]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/agent/providers/claude/agent.ts#L3859-L3894
[p-runtime-exit]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/agent/providers/claude/agent.ts#L3681-L3715
[p-screen]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/app/src/screens/schedules-screen.tsx#L120-L155
[p-row]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/app/src/components/schedules/schedule-row.tsx
[p-cli]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/public-docs/schedules-cli.md
[p-tests]: https://github.com/getpaseo/paseo/blob/1d0df5c0b737ea1ee9bf774a15c5ad5812eb2f05/packages/server/src/server/schedule/service.test.ts#L1755-L1896
[t-guidance]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/docs/internals/effect-services.md
[t-snooze]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/web/src/components/CustomSnoozeDialog.tsx#L65-L100
[t-settle]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/server/src/orchestration/ThreadSettlementPolicy.ts#L117-L137
[t-updating]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/docs/user/updating.md
[t-settings]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/packages/contracts/src/settings.ts#L1122-L1125
[t-mark]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/server/src/serverRuntimeStartup.ts#L405-L447
[t-reconcile]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/server/src/serverRuntimeStartup.ts#L481-L690
[t-dispatch]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/server/src/serverRuntimeStartup.ts#L693-L747
[t-capability]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/server/src/provider/Layers/ProviderService.ts#L1715-L1729
[t-runtime]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/server/src/persistence/Migrations/004_ProviderSessionRuntime.ts
[t-model]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/packages/contracts/src/orchestration.ts#L75-L126
[t-identity]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/server/src/provider/ProviderDriver.ts#L93-L105
[t-provider-switch]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L685-L706
[t-web-queue]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/web/src/queuedMessageStore.ts
[t-web-sender]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/web/src/components/QueuedMessageSender.tsx
[t-mobile-model]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/mobile/src/state/thread-outbox-model.ts
[t-mobile-storage]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/mobile/src/state/thread-outbox-storage.ts
[t-mobile-drain]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/mobile/src/state/use-thread-outbox-drain.ts
[t-receipts]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L135-L320
[t-synthetic]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3425-L3473
[t-liveness]: https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/server/src/orchestration/ThreadBackgroundLiveness.ts
