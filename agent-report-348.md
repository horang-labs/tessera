# Agent Report — GitHub Issue #348

## Completion status

Complete. Issue #348's Project-owned Control audit history is implemented from fixed start
`45e70331cc2e6d6df286eb985b6f122bcbe619b5`. Provider Integration work, high-risk
confirmation exceptions, and unrelated observability were not added.

Implementation commit: `b70f51894526a7e722d8b33ca392793cfd090da6`

## Acceptance mapping

| Acceptance requirement | Implementation and evidence |
| --- | --- |
| Record every Project-changing `tessera-cli` Worktree/Session operation | One `auditProjectMutation` seam in the Control Service wraps `worktree.create`, `session.create`, `session.start`, `session.launch`, `session.prompt`, `session.send-keys`, and `session.stop`. `tests/control-audit.test.ts` proves every operation is recorded once. |
| Attribute caller, operation, target, time, and outcome | Public records contain `projectId`, `sourceSessionId`, typed operation/target, `occurredAt`, `outcome`, and optional stable `failureCode`. Successful, mutation-failed, scope-failed, and composite-failed cases are covered. |
| Never retain prompt text or key-input contents | The audit API and SQLite table have no prompt/key-content field. Prompt/send-keys tests scan serialized records, and the persistence schema test verifies sensitive columns do not exist. |
| Retain after source Session deletion | `source_session_id` is deliberately plain source identity, with no Session foreign key. Persistence lifecycle tests delete the source Session and retain its record. |
| Retain on Project archive; delete with Project | Archive changes do not touch audit rows. Project deletion cascades through the Project foreign key and an explicit delete trigger (required for sql.js configurations where FK cascades are not active). |
| No cross-Project visibility | `listProjectAudit` uses the same current-Project authority and exact selector scope checks as other public Control reads. HTTP/CLI scoping tests reject foreign Projects. |
| Public Control Service and existing CLI seam | Added `GET /__tessera/control/v1/audit` and `tessera project audit (--current | --project <id>) [--json]`; runtime wiring uses the SQLite adapter. No new confirmation step was introduced. |
| Do not report a failed mutation as successful | The mutation result is captured only after the wrapped operation completes. Audit begins durably as `pending`, then is finalized as `succeeded` or `failed`; transient finalization failures receive three bounded retries and never invert the mutation result. |

## Persistence and lifecycle design

- Schema version 40 adds `control_audit_history`, indexed by `(project_id, id)`.
- UUID text IDs and a write-ahead `pending` insert make the attempt durable before mutation.
- `complete()` changes only a matching pending record to `succeeded` or `failed`, including only a stable public failure code.
- The deep `ControlAuditHistory` interface has database and in-memory implementations; transports do not duplicate audit logic.
- Project ownership is represented by `project_id` with delete cascade/trigger. Session identity is intentionally denormalized so deleting the caller cannot remove history.
- Archive is not a deletion and therefore retains history. Actual Project deletion removes it.

## Changed files

- Control audit domain/persistence: `src/lib/control/audit.ts`, `src/lib/control/database-audit-history.ts`.
- Single service seam and public transport/runtime wiring: `src/lib/control/service.ts`, `src/lib/control/http-handler.ts`, `src/lib/control/runtime-host.ts`, `bin/control-cli.mjs`.
- Schema and migration: `src/lib/db/schema.ts`, `src/lib/db/database.ts`.
- New audit tests: `tests/control-audit.test.ts`, `tests/control-audit-database.test.ts`, `tests/control-audit-migration.test.ts`.
- Updated Control fixtures/integration and migration expectations: `tests/control-authority.test.ts`, `tests/control-cli-bridge.test.ts`, `tests/control-cli-integration.test.ts`, `tests/control-http-handler.test.ts`, `tests/control-service.test.ts`, `tests/control-session-database.test.ts`, `tests/control-session-operations.test.ts`, `tests/control-worktree-creation.test.ts`, `tests/project-view-membership-migration.test.ts`.

Total implementation diff: 20 files, 1,311 insertions, 134 deletions.

## Test-first record and exact results

RED stages were observed before implementation for the missing audit module, sensitive
payload exclusion, complete mutation coverage, missing persistence adapter, inactive-FK
Project deletion, missing CLI integration, pre-wrapper scope/support failures, write-ahead
ordering, and transient audit-finalization retry. Each was made GREEN at its seam.

- Final affected command: `npx tsx --test --test-reporter=tap` over 13 audit, Control,
  CLI/bridge/runtime, and migration test files — **61 passed, 0 failed**, duration
  `9998.455913 ms`. TAP: `/home/work/tmp/t348-affected-final.tap`.
- `npx tsc --noEmit` — passed.
- `npm run lint -- --quiet` — passed.
- `git diff --check` — passed.
- `graphify update .` — passed after the final code change; graph contains 10,858 nodes,
  28,428 edges, and 417 communities.

Full-suite context:

- Final `tests/*.test.ts`: 1,576 total; 1,567 passed, 7 failed, 2 skipped, duration
  `25209.788049 ms`. The five deterministic failures are pre-existing, unrelated contract
  mismatches in active-workspace special sessions, parent-worktree authority, terminal input
  bar keys (two), and workspace-file drag payload. The other two (WSL bridge generation and
  huge-diff truncation) are parallel-run flakes; the WSL bridge test passed in the 61-test
  affected run and huge-diff truncation passed in isolation. The two schema-v40 failures found
  by the first full run were fixed and now pass. TAP: `/home/work/tmp/t348-full-ts-final.tap`.
- Final `tests/*.test.mjs`: 357 total; 345 passed, 12 failed, 0 skipped, duration
  `2002.274049 ms`. All 12 are unchanged, out-of-scope UI/terminal contract mismatches
  (model-default/new-tab/provider-rail, terminal contracts, and workspace-folder context
  menu); none exercises or imports the changed Control audit path. TAP:
  `/home/work/tmp/t348-full-mjs-final.tap`.

No affected test is failing.

## Code review findings and resolutions

`$code-review` ran in parallel Standards and Spec axes against fixed start
`45e70331cc2e6d6df286eb985b6f122bcbe619b5`.

- Standards initial review: no findings.
- Spec initial finding: scope/support failures occurred before the audit wrapper. Resolution:
  moved all post-authority mutation validation into the shared audited mutation closure and
  added a failure-history test.
- Spec initial finding: mutation execution and a later audit append could invert reported
  success when persistence failed. Resolution: introduced durable write-ahead `begin()` and
  outcome `complete()` phases, with a test proving reservation precedes mutation.
- Spec re-review finding: one completion failure could leave a permanent pending outcome.
  Resolution: added bounded completion retry with a RED-to-GREEN transient-failure test.
- Final Standards review: no findings.
- Final Spec review: no findings.

## Remaining risks

- A persistent storage failure across all three completion attempts can leave a durable
  `pending` attempt. This is intentionally honest rather than recording a false outcome; a
  later reconciliation worker is not included because unrelated observability/recovery work
  is outside #348.
- The repository-wide baseline failures listed above remain out of scope. The affected suite,
  typecheck, lint, and diff checks are green.
- No Electron E2E was run: this change is confined to the Control Service, SQLite persistence,
  HTTP/CLI contract, and bridge integration seams and has no renderer behavior.
- `npm ci` reported 46 existing dependency audit findings (2 low, 13 moderate, 28 high,
  3 critical); dependency remediation is outside this ticket.

## Final repository status

After committing this report, `git status --short --branch` is clean on
`feature/0811-t348` (branch header only). Nothing was pushed, no PR was opened, no issue was
edited or closed, and no other Worktree was touched.
