# Orca scheduled automation and PTY continuation research

Research for [Tessera #521](https://github.com/horang-labs/tessera/issues/521), within the [session automation wave](../design/session-automation-wave.md). This is a source-based design input, not a product implementation or runtime certification.

## Source revision and method

On 2026-10-02, inspected `/home/work/ade-tools/orca`: branch `main`, remote `https://github.com/stablyai/orca.git`, old HEAD `33351b00858e8619c4271d15ec46c8d220521770`. `git status --short` showed only the existing untracked `graphify-out/`; tracked files and index were clean. Authorized `git pull --ff-only` succeeded and fast-forwarded to **`1fc24d311481a85d5b4ae596898ee072389f040c`**. The graph directory was preserved; no isolated fallback checkout was needed. Post-update status still showed only that directory. All Orca links below pin this new commit, rather than moving `main`.

Used existing graph vocabulary (`automation scheduler precheck dispatch`), `graphify reflect --if-stale`, `graphify query ... --budget 1800`, and `graphify explain 'automations/service.ts'` for navigation. Query output was truncated (199 nodes, 60 shown), and the graph predates the pull; neither graph edges nor line numbers were treated as current behavior. Read current implementation files and followed imports/call sites directly. No graph regeneration or product edits were needed. Graph navigation used no LLM API extraction.

Evidence labels: **Implemented** means a branch was read at the pinned revision; **inference** means a consequence of those branches, not a reproduced incident; **gap** is scoped to the inspected built-in automation path. Test files were read as corroboration, **not executed**. External Hermes/OpenClaw jobs appear in Orca's types/UI but are separate provider-owned systems; this report does not infer their scheduler guarantees from Orca's built-in scheduler. [S1]

## Findings

### 1. Persisted recurrence, one scheduling authority, two launch paths

**Implemented.** An automation stores a prompt, `agentId`, target/run context, scheduler owner, workspace mode, optional session reuse, timezone string, recurrence, start and next-due timestamps, enabled flag, and missed-run grace. A run stores a distinct ID, scheduled time, trigger, status, workspace and exact tab/pane/PTY identity, precheck result, output snapshot, error and optional usage. The status vocabulary separates pending/dispatching/dispatched from completion and several skip/failure reasons. [S1]

`AutomationService` checks due definitions every 60 seconds with a process-local re-entrancy guard. Desktop starts a catch-up pass on renderer readiness; headless serve starts one without a renderer. It resolves the target and claims a run before dispatching. Desktop dispatch is an IPC request to the renderer; `isServeMode` supplies a backend dispatcher and allows `remote_host_service` ownership. This is an owner-aware authority model, **not evidence of a distributed lease across arbitrary processes**. [S2][S3]

Target resolution checks project setup readiness, matching host/repository/path and captured host identity; deleted or re-registered SSH targets can be refused instead of silently adopted. The request captures the definition and destination, durably writes intent, then re-reads them after asynchronous acknowledgement; a change, deletion or stopped generation blocks launch. Reuse these identity checks in Tessera, but adapt them to Tessera's actual user/environment model. [S4][S5]

### 2. Conditions mean a scheduled shell precheck, not a goal-completion loop

**Implemented.** Only a `scheduled` run executes its optional precheck. `manual` Run Now bypasses it. A precheck passes only with exit code 0, no timeout and no error; otherwise it records `skipped_precheck`. Empty stdout is not false, and nonempty stdout is not true. The command runs before new-workspace creation. Its cwd is the resolved target; for context-backed targets this is the setup path, while the legacy existing-workspace branch extracts the worktree path. [S2][S4][S6][S7]

Timeout defaults to 60 seconds, clamps to 1–600 seconds, and output tails are capped at 4,000 characters each. Local execution uses a shell and the host process environment; local timeout requests process-tree termination (with platform-specific fallbacks). SSH uses a separate execution path. This code is not proof that a Windows server will evaluate a WSL-owned condition in the intended environment. [S7][S8]

**Gap.** The examined service runs on calendar due times, not an “agent stopped but task unfinished” event. No goal evaluator, stop-hook continuation budget or explicit success predicate appears in this built-in automation path. A recurring precheck plus reused terminal can approximate a periodic continuation, but does not establish that a task remains unfinished or is safe to resume. The unrelated UI “session continuation” feature is not claimed here as an automatic wake-up scheduler. [S1][S2][S9]

### 3. Desktop reuse is best effort; busy falls back to a fresh session

**Implemented.** Reuse applies only to an existing workspace. Candidates are previous **completed runs of the same automation** in the same workspace, sorted newest first, with recorded pane and PTY IDs. A candidate needs a live matching pane/PTY and current agent state `done`; an unknown/absent agent type is tolerated, but a different known agent type is not. This is not a selector for any arbitrary user Session. [S9]

A renderer-local set prevents concurrent reuse dispatches to the same tab. If no candidate is eligible, the tab is already reserved, or submission returns false, the handler falls through to a new background session. Thus a busy previous run does **not** defer the schedule, and consecutive occurrences can overlap in new terminals. No per-automation active-run limit is checked in the scheduler or handler. The first fresh terminal is kept alive when reuse is requested, to seed later reuse. [S2][S10]

**Implemented difference.** The production headless dispatcher in `main-process-automations.ts` never branches on `reuseSession`: existing-workspace runs call `runtime.launchAgentTerminal`, and new-per-run runs create a worktree with an agent. Do not promise desktop reuse semantics on serve merely because the persisted type contains the flag. [S3]

### 4. PTY paste ordering helps; it is not a safe-input proof

**Implemented.** Desktop reuse calls `submitPromptToAgentPty`. It wraps bracketed paste and a delayed Enter in a per-PTY Promise transaction, marks input as `driving`, normalizes line endings, sanitizes escape characters and bounds/chunks large pastes. The transaction map lives in the renderer. Fresh sessions use the normal background launch plan; provider injection modes choose startup prompt versus follow-up delivery. [S10][S11][S11a][S11b][S12]

**Gap/inference.** Candidate selection reads `done` once before awaiting delivery. The inspected reuse path does not reserve an empty user input buffer or atomically recheck permission/busy state at the write boundary. A same-renderer transaction serializes cooperating writes, but does not prove that already-typed text is absent or that another client cannot change state. In the desktop PTY IPC path, writes enforce sender/ownership/size and mobile-driver restrictions; those are not equivalent to an empty-composer/idle lease. Treat a race with user typing or a newly shown permission prompt as a risk to test, not a reproduced failure. [S9][S10][S11][S11a][S11b][S13][S13a]

Also, `sendRuntimePtyInputVerified` returns true after a fire-and-forget fallback when local/SSH `writeAccepted` is false. Its boolean is explicitly not an agent-consumption receipt. Therefore “submitted” cannot alone prove a turn started; do not automatically replay after an ambiguous write. [S13][S13a]

### 5. Permission and completion evidence differ from task success

**Implemented.** Desktop preparation refuses an SSH reconnect needing interactive credentials with `skipped_needs_interactive_auth`; it attempts a noninteractive connection otherwise. It does not approve that credential prompt. Runtime `tui-idle` waiting distinguishes a blocked verdict from readiness; permission is not idle. An automation observation maps a blocked result to `dispatch_failed`, rather than sending approval. [S6][S14]

Desktop completion observes agent `done` or proven exit (zero → completed, nonzero → failure). Fresh launch session-boundary `done` is filtered; reused sessions require a post-start `working` edge before `done`. Unverifiable transport loss releases observation ownership without pretending to have seen a process exit. These guards avoid several false lifecycle completions, but **`completed` still means the run/turn settled, not that the user's objective was achieved**. [S10][S15]

There are **two backend observation paths**. The shared runtime observer checks for leaving an already-idle state (2-minute start deadline), re-arms timed-out waits within a 6-hour observation budget, and returns failure for blocking/unobserved completion. However, the actual serve launch provides its own `completion` promise, doing one `waitForTerminal(..., { condition: 'tui-idle' })` and a terminal read. `runHeadlessAutomationDispatch` uses that promise instead of installing this observer when present. Default `tui-idle` timeout is 5 minutes. Thus the 6-hour observer policy must not be generalized to freshly launched serve runs; timeout or read failure can reject their promise. These are observation limits, not process-kill or cost limits. [S3][S14][S16][S17][S17a]

### 6. Durable intent and occurrence deduplication, with a crash ambiguity window

**Implemented.** Run creation deduplicates by `(automationId, scheduledFor)` among retained records. Manual runs use `Date.now()` as their scheduled timestamp (same-millisecond calls may coalesce). The run writer awaits `flushPendingOrThrowAsync` for creation, transition and cursor advance. Dispatch intent (`dispatching`) is flushed before external launch; re-reading the current run prevents another in-process caller from claiming an already-transitioned row. The implementation has normalized SQLite run rows keyed by run ID; the occurrence search is application logic, not evidence of a database UNIQUE occurrence constraint. [S5][S18][S19][S19a]

The in-memory dispatch-token map binds automation/run IDs, expires after 30 minutes and targets 1,024 records (all-in-flight entries cannot be evicted by trimming). Token reservations protect workspace-creation provenance/retries, not end-to-end exactly-once PTY consumption. No durable PTY receipt is demonstrated. [S20][S6]

On startup, retained dispatched/dispatching runs and pending **manual** runs are reconciled. Surviving terminals get watchers; unresolved records wait for terminal-surface readiness plus a 2-minute settle grace, retrying every 2 seconds, before a truthful stranded-run failure is written. Scheduled pending runs are not included in that reconciliation filter. If their timestamp is still the latest eligible occurrence, normal evaluation can revisit them; if superseded by a newer occurrence, this inspected path does not demonstrate recovery of the old pending row. [S2][S21][S21a]

**Inference.** A crash after writing intent but before persisting terminal identity cannot distinguish “never sent” from “sent, acknowledgement lost” purely from the run record. The reconciliation policy favors observation/failure over replay of `dispatching`, sacrificing an automatic retry to avoid duplicate execution. No exactly-once guarantee across process death, multiple authorities or user-visible side effects is established. Durability tests corroborate persist-before-launch and handling of stalled/rejected acknowledgements, but were not run here. [S5][S16][S18][S21][S21a][S22][S22a]

### 7. Catch-up coalesces missed occurrences; timezone support is incomplete

**Implemented.** Evaluation selects the **latest** occurrence at or before now, then advances `nextRunAt` to an occurrence after the evaluation timestamp. It does not replay every missed interval. If lateness exceeds configured grace plus twice the tick interval, it records `skipped_missed`; default grace is 720 minutes, default tick tolerance is 2 minutes. Zero configured grace therefore still tolerates a short outage. Startup and the next post-sleep tick use persisted due times; no OS wake alarm is installed in this service. A frequent schedule can run its latest occurrence on wake even after a long sleep, because lateness is measured from that latest occurrence. [S2][S23][S24]

The whole evaluation pass holds its guard while awaiting dispatch work and captures `now` once. In serve mode, inline precheck/workspace work can delay later rows and drop interval ticks. The source comment explicitly calls out false missed-run classification after a long pass; the serial loop supports that concern, but this research did not reproduce timing behavior. [S2][S23]

**Implemented limitation.** The record stores `timezone`, and the CLI docs advertise IANA-zone scheduling. Actual occurrence functions accept only schedule, `dtstart`, and time; they use JavaScript local `Date` getters/setters. The stored zone is not passed through the persistence schedule operations. Therefore the inspected built-in scheduler follows the runtime's local zone, not an independently stored per-automation IANA zone. DST behavior needs targeted verification, especially fixed 24-hour day stepping. [S24][S25][S25a][S25b][S26][S26a]

Parsing supports five-field cron and a limited RRULE subset (`HOURLY`, `DAILY`, `WEEKLY`, day/hour/minute). `COUNT`, `UNTIL` and other RRULE fields are collected but not applied in the returned rule. No one-time scheduling variant, expiry timestamp or maximum-run budget appears in the automation definition. Do not represent `COUNT=1` as implemented one-shot support. [S1][S25][S25a][S25b]

### 8. History and UI are useful patterns; configuration needs stronger capture

**Implemented.** The editor offers hourly/daily/weekdays/weekly/custom-cron schedules and Fresh/Reuse selection. Detail/list UI exposes next run (or Paused), host, schedule, grace, precheck and agent, with Run Now, edit, pause/resume and delete actions. History includes status, workspace, usage and folded occurrence counts; run details expose saved output, truncation and rerun/open actions. These are source-confirmed render branches, not visual QA. [S27][S27a][S28][S28a][S29][S29a]

Retention preserves all nonfinal runs and up to 100 final runs per automation when pruning runs, so 100 is **not** a total active/history cap. Consecutive identical `skipped_unavailable` scheduled refusals can fold into one row with occurrence count and latest occurrence timestamp. Deleting a definition deletes its history; merely disabling it is not a request to stop an already-running agent. The dispatch-definition comparison can prevent a launch if disable happens before its final recheck; it is not an all-stage cancellation guarantee. [S5][S18][S24][S30]

The definition stores provider/agent choice but no dedicated model, effort or permission-settings snapshot. Desktop background launch reads current `agentDefaultArgs`, environment and command overrides. The usage record's model is observed attribution, not saved execution configuration. Tessera's explicit provider/model/effort/settings requirement needs its own persisted contract. [S1][S12]

## Failure modes and recommendations for Tessera

These are proposed design inputs for the orchestrator, not claims about implemented Tessera code.

| Situation | Orca evidence / limitation | Tessera decision to carry into design |
| --- | --- | --- |
| Turn settles before objective finishes | `done`/idle completes a run; no goal evaluator | Separate turn settlement, continuation eligibility and explicit task completion. Opt in per Session; never infer success from stop/exit alone. |
| User types or permission appears at due time | Reuse has a snapshot `done` check and renderer transaction | Require an owner-side delivery gate with current Session incarnation, idle status, no pending approval and no active draft/input. Recheck after async waits; busy/unknown defers with a bounded deadline. Never auto-approve. |
| Previous run remains busy | Desktop falls back to new terminal | For wake-up, target the exact opted-in Session and defer; for new-Session automations, define overlap policy explicitly. Enforce per-session/per-automation concurrency. |
| Crash around prompt submission | Durable intent; no durable agent-consumption receipt | Use unique occurrence identity, transactional claim and owner generation. Persist delivery/turn IDs when possible. Keep ambiguous delivery visible; do not blindly retry external effects. |
| Restart or sleep misses many intervals | Latest-only catch-up with grace/tick tolerance | Persist absolute due time; choose bounded catch-up explicitly (at most one suggested). Report skipped intervals. Test clock changes and long scheduler stalls separately from sleep. |
| Wrong host/account or recreated Session | Captured target checks and host generation | Carry `userId`, agent environment and stable Session incarnation through scheduler, lifecycle and normal prompt delivery. Resolve CLI paths on the correct side of Windows backend + WSL CLI. |
| Repeated failed/permission/empty wake-up | No run budget or expiry in inspected definition | Persist attempt count, expiry, maximum attempts and disable state. Count attempts consistently across restart; expose blocked reason and next decision time. |
| Schedule timezone, one-time run, settings drift | Stored zone not used; limited RRULE; launch defaults read live | Use a tested zoned recurrence implementation plus a distinct one-time timestamp. Snapshot provider/model/effort/permissions/settings at save, with an explicit edit policy. |
| No renderer or remote contact | Desktop launch depends on renderer; serve differs | One owner-aware backend scheduler, reusing existing lifecycle and delivery paths. UI observes durable next-run/history state; disconnected is unknown, not success. |
| User needs to inspect what happened | Run output, skip reason, usage, next run | Retain outcome/skip reason, original due time, actual delivery time and next run. Distinguish “turn settled”, “blocked”, “delivery unknown”, “expired” and explicit completion. |

Suggested first implementation seams: pure due-time/catch-up calculation; transactional claim and crash reconciliation; continuation eligibility and atomic delivery gate; run-budget/disable transitions. Future tests should cover competing ticks, restart before/after send, busy/permission/typed draft races, zero-grace jitter, clock/timezone/DST changes, host ownership changes, and absence of a renderer. Integration QA must use **Windows backend + WSL CLI**, with ordered screenshots from normal Session and Kanban Session Peek if input/focus surfaces change. This document does not select new Tessera APIs or bypass its existing lifecycle/prompt paths.

## Verification limits

No Orca or Tessera app was launched; no real provider prompt, SSH credential flow, OS sleep, renderer race, crash/disk failure or Windows/WSL topology was exercised. No product tests, typecheck, lint or full test suite were run: only this research document changes, and there is no agreed executable TDD seam in this ticket. TDD belongs at the follow-up seams above. Read tests describe intended assertions, not passing test results. Timing, UI usability, fallback delivery receipt and crash ambiguities remain runtime verification gaps.

Source refresh establishes the fetched `origin/main` tip at this observation, not the installed/released Orca version or every remote branch. Negative findings are limited to the built-in definition/service, desktop dispatch, serve dispatcher, recurrence and persistence paths cited below. External scheduler internals and competing products are outside #521.

## Commit-pinned source index

Paths are relative to `stablyai/orca`. Line anchors locate the relevant entry point; findings above follow the rest of each named function and its explicitly cited dependencies.

- **S1** — [`src/shared/automations-types.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/shared/automations-types.ts#L91).
- **S2** — [`src/main/automations/service.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/service.ts#L40).
- **S3** — [`src/main/startup/main-process-automations.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/startup/main-process-automations.ts#L7).
- **S4** — [`src/main/automations/run-target-resolution.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/run-target-resolution.ts#L56).
- **S5** — [`src/main/automations/automation-dispatch-request.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/automation-dispatch-request.ts#L46).
- **S6** — [`src/renderer/src/hooks/automation-dispatch-workspace.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/hooks/automation-dispatch-workspace.ts#L58).
- **S7** — [`src/shared/automation-precheck.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/shared/automation-precheck.ts#L3).
- **S8** — [`src/main/automations/precheck-runner.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/precheck-runner.ts#L132).
- **S9** — [`src/renderer/src/lib/automation-session-reuse.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/lib/automation-session-reuse.ts#L13).
- **S10** — [`src/renderer/src/hooks/automation-dispatch-handler.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/hooks/automation-dispatch-handler.ts#L29).
- **S11** — [`src/renderer/src/lib/agent-paste-draft.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/lib/agent-paste-draft.ts#L200).
- **S11a** — [`src/renderer/src/lib/agent-draft-paste-content.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/lib/agent-draft-paste-content.ts#L43).
- **S11b** — [`src/renderer/src/components/terminal-pane/terminal-pty-input-transaction.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/terminal-pane/terminal-pty-input-transaction.ts#L1).
- **S12** — [`src/renderer/src/lib/launch-agent-background-session.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/lib/launch-agent-background-session.ts#L59).
- **S13** — [`src/renderer/src/runtime/runtime-terminal-inspection.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/runtime/runtime-terminal-inspection.ts#L279).
- **S13a** — [`src/main/ipc/pty/ipc/write-input.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/ipc/pty/ipc/write-input.ts#L158).
- **S14** — [`src/main/runtime/runtime-terminal-wait.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/runtime/runtime-terminal-wait.ts#L166).
- **S15** — [`src/renderer/src/hooks/automation-dispatch-completion.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/hooks/automation-dispatch-completion.ts#L21).
- **S16** — [`src/main/automations/headless-dispatch-runner.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/headless-dispatch-runner.ts#L33).
- **S17** — [`src/main/automations/runtime-terminal-run-observer.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/runtime-terminal-run-observer.ts#L148).
- **S17a** — [`src/main/runtime/orca-runtime-postlude.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/runtime/orca-runtime-postlude.ts#L61).
- **S18** — [`src/main/persistence/scheduling-automations/automation-run-operations.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/persistence/scheduling-automations/automation-run-operations.ts#L68).
- **S19** — [`src/main/automations/automation-run-writer.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/automation-run-writer.ts#L20).
- **S19a** — [`src/main/persistence/profile-state/profile-state-automation-runs-writer.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/persistence/profile-state/profile-state-automation-runs-writer.ts#L98).
- **S20** — [`src/main/automations/dispatch-tokens.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/dispatch-tokens.ts#L3).
- **S21** — [`src/main/automations/run-completion-watcher.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/run-completion-watcher.ts#L143).
- **S21a** — [`src/main/automations/retained-run-reconciliation.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/retained-run-reconciliation.ts#L4).
- **S22** — [`src/main/automations/automation-worker-durability.test.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/automation-worker-durability.test.ts#L56).
- **S22a** — [`src/main/automations/headless-dispatch-durability.test.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/headless-dispatch-durability.test.ts#L40).
- **S23** — [`src/main/automations/dispatch-refusal.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/dispatch-refusal.ts#L147).
- **S24** — [`src/main/persistence/scheduling-automations/automation-definition-operations.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/persistence/scheduling-automations/automation-definition-operations.ts#L51).
- **S25** — [`src/shared/automation-schedule-parsing.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/shared/automation-schedule-parsing.ts#L39).
- **S25a** — [`src/shared/automation-schedule-occurrences.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/shared/automation-schedule-occurrences.ts#L85).
- **S25b** — [`src/shared/automation-cron-occurrence.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/shared/automation-cron-occurrence.ts#L18).
- **S26** — [`src/main/persistence/scheduling-automations/automation-schedule-operations.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/persistence/scheduling-automations/automation-schedule-operations.ts#L8).
- **S26a** — [`docs/site/content/docs/cli/automations.mdx`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/docs/site/content/docs/cli/automations.mdx#L23).
- **S27** — [`src/renderer/src/components/automations/AutomationSchedulePicker.tsx`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/automations/AutomationSchedulePicker.tsx#L23).
- **S27a** — [`src/renderer/src/components/automations/AutomationSessionField.tsx`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/automations/AutomationSessionField.tsx#L15).
- **S28** — [`src/renderer/src/components/automations/AutomationDetail.tsx`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/automations/AutomationDetail.tsx#L102).
- **S28a** — [`src/renderer/src/components/automations/AutomationListLocalRow.tsx`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/automations/AutomationListLocalRow.tsx#L156).
- **S29** — [`src/renderer/src/components/automations/AutomationRunHistory.tsx`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/automations/AutomationRunHistory.tsx#L55).
- **S29a** — [`src/renderer/src/components/automations/AutomationRunDetailsPage.tsx`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/automations/AutomationRunDetailsPage.tsx#L18).
- **S30** — [`src/shared/automation-run-retention.ts`](https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/shared/automation-run-retention.ts#L3).

[S1]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/shared/automations-types.ts#L91
[S2]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/service.ts#L40
[S3]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/startup/main-process-automations.ts#L7
[S4]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/run-target-resolution.ts#L56
[S5]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/automation-dispatch-request.ts#L46
[S6]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/hooks/automation-dispatch-workspace.ts#L58
[S7]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/shared/automation-precheck.ts#L3
[S8]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/precheck-runner.ts#L132
[S9]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/lib/automation-session-reuse.ts#L13
[S10]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/hooks/automation-dispatch-handler.ts#L29
[S11]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/lib/agent-paste-draft.ts#L200
[S11a]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/lib/agent-draft-paste-content.ts#L43
[S11b]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/terminal-pane/terminal-pty-input-transaction.ts#L1
[S12]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/lib/launch-agent-background-session.ts#L59
[S13]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/runtime/runtime-terminal-inspection.ts#L279
[S13a]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/ipc/pty/ipc/write-input.ts#L158
[S14]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/runtime/runtime-terminal-wait.ts#L166
[S15]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/hooks/automation-dispatch-completion.ts#L21
[S16]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/headless-dispatch-runner.ts#L33
[S17]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/runtime-terminal-run-observer.ts#L148
[S17a]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/runtime/orca-runtime-postlude.ts#L61
[S18]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/persistence/scheduling-automations/automation-run-operations.ts#L68
[S19]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/automation-run-writer.ts#L20
[S19a]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/persistence/profile-state/profile-state-automation-runs-writer.ts#L98
[S20]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/dispatch-tokens.ts#L3
[S21]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/run-completion-watcher.ts#L143
[S21a]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/retained-run-reconciliation.ts#L4
[S22]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/automation-worker-durability.test.ts#L56
[S22a]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/headless-dispatch-durability.test.ts#L40
[S23]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/automations/dispatch-refusal.ts#L147
[S24]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/persistence/scheduling-automations/automation-definition-operations.ts#L51
[S25]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/shared/automation-schedule-parsing.ts#L39
[S25a]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/shared/automation-schedule-occurrences.ts#L85
[S25b]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/shared/automation-cron-occurrence.ts#L18
[S26]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/main/persistence/scheduling-automations/automation-schedule-operations.ts#L8
[S26a]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/docs/site/content/docs/cli/automations.mdx#L23
[S27]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/automations/AutomationSchedulePicker.tsx#L23
[S27a]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/automations/AutomationSessionField.tsx#L15
[S28]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/automations/AutomationDetail.tsx#L102
[S28a]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/automations/AutomationListLocalRow.tsx#L156
[S29]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/automations/AutomationRunHistory.tsx#L55
[S29a]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/renderer/src/components/automations/AutomationRunDetailsPage.tsx#L18
[S30]: https://github.com/stablyai/orca/blob/1fc24d311481a85d5b4ae596898ee072389f040c/src/shared/automation-run-retention.ts#L3
