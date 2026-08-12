# Agent report — issue 359

## Outcome

Implemented issue 359 against fixed point `282a2d1432c6f663905a077aa8f99b263283bfa6`.

Terminal-chat input no longer depends on whichever renderer terminal surface happens to be
registered after a stop/conflict/resume cycle. The renderer now sends a session-scoped request;
the server captures the currently managed PTY runtime, clears a bounded multiline stale composer
buffer with repeated Ctrl+U/Ctrl+K, writes one bracketed-paste body, waits 500 ms, and writes Enter only if that
same runtime object, terminal binding, and session binding are still current. The server returns
a request-scoped acknowledgement only after the complete byte sequence was written. A runtime
replacement between body and Enter returns failure and receives no bare Enter.

Optimistic terminal-chat messages now use collision-safe UUIDs. A transport/runtime rejection
marks the bubble not delivered immediately. If the PTY write succeeds but the provider never
records the turn, the existing ten-minute transcript deadline marks it failed. Failed bubbles
remain merged into later transcript refreshes until a matching canonical user turn appears, and
pending/failed bubbles do not offer the historical “From here” action.

The shared terminal-surface input helpers were returned to their pre-ticket behavior; the fix is
limited to terminal-chat delivery. The existing concurrent provider-runtime ownership guard was
not changed.

## Skill workflow

`$implement` was invoked by treating GitHub issue 359 as the supplied ticket. The workflow read
the issue, ADRs 0006/0012/0013, repository guidance, and
`.claude/notes/cross-boundary-testing.md`; characterized the relevant registry/manager/WS/chat
reconciliation seams; implemented the acceptance criteria; verified them; and ran `$code-review`.

`$tdd` covered these seams before their production changes:

- stale renderer generation routing after resume (initial RED showed both body and Enter selecting
  generation 1 instead of the resumed generation 2);
- generation replacement during the delayed submit (RED showed body on generation 1 and a bare
  Enter on generation 2);
- missing failed-delivery state for an unaccepted optimistic message;
- post-review server-managed runtime delivery (RED: `submitSessionChatInput is not a function`),
  failed-message refresh persistence (RED: merge helper missing), and collision-safe IDs (RED:
  two same-millisecond registrations had the same ID);
- stale-composer clearing (RED: the bounded multiline clear sequence was absent before the
  bracketed paste).

The first surface-level regression was deliberately replaced after review: it was a mocked
contract incorrectly named e2e and could not prove server receipt. The durable coverage now uses
the real `TerminalManager` generation/binding seam plus a separately named WS bridge contract.

## Changes

- Added `terminal_chat_input` / `terminal_chat_input_result` transport messages and request-scoped
  client acknowledgement/failure-on-disconnect behavior.
- Added exact-runtime terminal-chat submission in `TerminalManager`, including bounded multiline
  stale-draft clear,
  bracketed paste, delayed Enter, concurrent-send rejection, and generation/session revalidation.
- Routed the terminal-chat composer through that server boundary instead of the renderer surface
  registry.
- Added pending/failed delivery state, visible localized failure text, refresh-stable failed
  messages, UUID identities, and suppression of “From here” for noncanonical optimistic bubbles.
- Added deterministic WS bridge, manager generation, normalization, reconciliation, and rendered
  failure tests.

## Verification commands and measured results

Environment/setup:

- `npm ci --ignore-scripts` — completed; npm audit summary reported 46 dependency findings
  (2 low, 13 moderate, 28 high, 3 critical). No dependency files were changed.
- `graphify update .` — completed after the final implementation; 1,371 source files were
  re-extracted. Graphify reported 438 communities and the pre-existing zero-node warning for
  `provider-skill-ids.json`.

TDD RED evidence after the first review:

- `npx tsx --test --test-name-pattern="terminal chat delivery follows|terminal chat never sends Enter|undelivered optimistic|collision-safe" tests/terminal-manager-lifecycle.test.ts tests/terminal-chat-pending-reconciliation.test.ts`
  — 0/4 passed as intended: two missing manager-method failures, one missing merge-helper failure,
  and one same-millisecond ID collision.
- `npx tsx --test --test-name-pattern="terminal chat delivery follows|terminal chat never sends Enter" tests/terminal-manager-lifecycle.test.ts`
  — 0/2 passed as intended before stale-line clearing; both diffs showed missing `\x15`.

Targeted GREEN evidence:

- `npx tsx --test tests/terminal-chat-bridge.test.ts tests/terminal-chat-pending-reconciliation.test.ts tests/terminal-chat-send.test.ts tests/terminal-chat-interrupt.test.ts tests/terminal-user-input-surface.test.ts tests/terminal-manager-lifecycle.test.ts`
  — 64/64 passed in 18.242 s in the final run.
- `npx tsx --test --test-name-pattern="concurrent detached launches reject the loser without revoking the winning pane token" tests/provider-launch-module.test.ts`
  — 1/1 passed in 2.021 s in the final run; this is the preserved all-or-nothing concurrent
  ownership guard.
- `npx tsx --test tests/terminal-chat-bridge.test.ts`
  — 2/2 passed in 0.875 s.
- `npx tsx --test --test-name-pattern="terminal chat delivery follows|terminal chat never sends Enter" tests/terminal-manager-lifecycle.test.ts`
  — 2/2 passed in 1.542 s in the final run. The first test invoked the runtime ownership-conflict
  callback, observed its `terminal_error`, observed `terminal_started` generations `[1, 2]`, no
  write during the conflict/no-runtime window, and exactly one bounded clear sequence, one
  bracketed body, and one Enter on generation 2. The second observed clear+body only on generation 1 and no bytes on its
  replacement.
- `npx tsx --test tests/terminal-chat-bridge.test.ts tests/terminal-chat-pending-reconciliation.test.ts tests/terminal-chat-send.test.ts tests/terminal-chat-interrupt.test.ts tests/terminal-user-input-surface.test.ts`
  — 18/18 passed in 0.943 s.
- `npx tsc --noEmit` — passed with no diagnostics.
- `npm run lint` — passed with no diagnostics.
- `git diff --check` — passed.

Per instruction, the full test suite was not run in this child worktree.

## Code review

`$code-review` used fixed point `282a2d1432c6f663905a077aa8f99b263283bfa6` and ran its
Standards and Spec agents in parallel.

The first review found:

- the mocked `.e2e` name overstated its evidence;
- timestamp-only optimistic IDs could collide;
- surface/WS queue success did not establish server/runtime receipt;
- failed bubbles disappeared on refresh;
- generation coverage did not exercise the manager generation/binding seam; and
- shared surface routing expanded scope beyond terminal chat.

All were applied: the mocked e2e was removed, IDs use UUIDs, delivery crosses an acknowledged
server-managed exact-runtime boundary, failed bubbles survive refresh, manager generations 1→2
are asserted, and shared surface routing is unchanged from the fixed point.

The parallel re-review confirmed the earlier code findings were addressed, then reported:

- Spec, high: one Ctrl+U did not clear a stale multiline draft. Applied by using a bounded
  40-logical-line, any-cursor clear sequence (79 Ctrl+U followed by 79 Ctrl+K) and pinning the
  exact bytes in both resume-generation tests.
- Spec, medium: the conflict/resume evidence still did not invoke the actual runtime guard.
  Applied at the deterministic manager seam: the generation-1 guard callback now emits the
  ownership error and closes that runtime before the no-runtime rejection and generation-2
  resume.
- Standards, hard: the exact packaged Windows Electron → WSL Codex → real-home topology was not
  run. This finding cannot be applied in this child session because the ticket explicitly forbids
  launching/mutating Electron or a real provider home and assigns that verification to the root
  orchestrator. It remains a mandatory handoff item, not claimed evidence.

No other re-review findings remained.

## Commits

- `6f4432a` — initial terminal-chat generation/failure implementation.
- `066e04b` — review-driven exact managed-runtime bridge, persistent failure state, corrected test
  evidence, UUID identity, and removal of shared surface-routing scope.
- `ae3526c` — re-review fix for bounded multiline stale-draft clearing and actual runtime-guard
  conflict coverage in the deterministic generation test.

`ae3526c` is the implementation HEAD before the report-only handoff commit. The report-only commit
is the commit containing this file.

## Not verified / deliberately left out

- No packaged Windows Electron backend → WSL Codex CLI → real authoritative Codex-home run was
  performed. The root orchestrator owns that isolated instance and final verification.
- No live Electron instance was built, launched, stopped, or mutated, and no real provider home or
  rollout file was touched.
- The deterministic seams prove exact managed-runtime byte routing, generation isolation, request
  acknowledgement, transcript reconciliation, and visible failure. They do not prove that a real
  Codex version appends the rollout entry; that remains the named topology smoke test above.
- The full suite, unrelated terminal input actions, attachments/images, slash commands, provider
  session adoption, and any changes to ADR 0006/0012/0013 ownership semantics were deliberately
  left out.
- No push or pull request was performed.
