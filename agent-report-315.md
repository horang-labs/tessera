# Issue 315 implementation report

## Outcome

Implemented the conflict-recovery AI handoff described by issue 315 and ADR 0001. When the Git panel has a complete unresolved-path list and the current session has a compatible, connected GUI composer, Conflict Recovery offers **Resolve with AI**. The action re-reads Git state, rejects stale or unavailable handoffs, and places an editable request in that same session's composer. It does not submit a chat message, read conflict contents into the request, change the worktree/index/sequencer, continue the Git operation, or commit.

The prepared request contains only the worktree path, operation, and JSON-quoted unresolved relative paths plus instructions to resolve the files and leave continuation/commit to the user. The one-shot prepared-draft store is consumed on composer mount so later user edits are not overwritten by remounts.

## Implementation and TDD

The provider implementation skill was invoked as `$implement`, with issue 315 supplied as its ticket. Its implementation loop ran these seams through `/tdd`:

1. Handoff availability: complete conflict list, matching active session, provider GUI capability, connected composer, and the shared 10,000-character composer limit.
2. Editable prepared request: worktree/operation/relative paths only, same-session draft insertion, and no automatic submission.
3. Revalidation and non-mutation: stale conflict fingerprints, post-read session/connection compatibility, live panel refresh, and no Git/file side effects.

The red phases used focused invocations of `npx tsx --test tests/git-conflict-handoff.test.ts` and `npx tsx --test tests/git-conflict-handoff-ui.test.tsx`; they initially failed on the absent handoff module/action and subsequently on the deliberately introduced stale, unavailable, size-limit, and post-await compatibility expectations. Each seam was made green before the surrounding conflict-recovery tests were run.

Files and behavior added or changed:

- `src/lib/git/git-conflict-handoff.ts` owns availability, bounded request construction, stable conflict fingerprinting, and asynchronous revalidation.
- `src/components/git/git-conflict-ai-button.tsx` and the Git panel/controller integration expose the action only when it is usable and keep manual recovery visible on errors.
- `src/stores/chat-store.ts` and `src/components/chat/message-input.tsx` implement a one-shot, session-keyed editable draft without sending it.
- `src/lib/chat/message-input-limits.ts` shares the composer size boundary between the composer and handoff eligibility.
- English, Korean, Japanese, and Chinese strings and types cover the action, explanation, progress, and failure/stale states.
- Focused unit/UI tests and the existing conflict-recovery E2E cover content boundaries, stale/unavailable cases, submission boundaries, exact Git non-mutation, normal polling refresh, Abort reachability, and the index-lock retry extreme.

## Verification

- `npm ci`
  - Installed 1,042 packages successfully.
  - npm audit reported 46 dependency findings (2 low, 13 moderate, 28 high, 3 critical); no audit mutation was requested or applied.
- `npx tsx --test tests/git-conflict-handoff.test.ts tests/git-conflict-handoff-ui.test.tsx tests/git-conflict-recovery.test.ts tests/git-primary-action.test.ts tests/git-action-menu.test.ts tests/git-abort-action.test.ts tests/git-conflict-detection.test.ts tests/git-action-report.test.ts tests/git-action-session-refresh.test.ts tests/git-panel-poll-refresh.test.ts tests/git-desktop-commit-control.test.tsx`
  - Final: 127 passed, 0 failed, 0 skipped; test duration 7.040s, wall time 7.49s.
  - One earlier parallel run had a timing failure in the pre-existing session-refresh test; an identical rerun passed, and the final run above was clean.
- `npx tsc --noEmit`
  - Passed; wall time 4.41s.
- `npm run lint`
  - Passed with 0 errors and the same 3 pre-existing warnings (`preview-markdown.tsx` `<img>`, TanStack Virtual compiler compatibility, and an unused eslint-disable in `spawn-cli-runtime.ts`); wall time 42.50s.
- `node tests/git-conflict-recovery.e2e.mjs`
  - Passed; wall time 35.64s.
  - Measured result: `operation=merge`, `preparedOnly=true`, unresolved paths refreshed from 2 to 1 after an externally staged resolution, and retry after an index-lock failure succeeded.
  - Before/after assertions compared porcelain-v2 status, HEAD, the complete index bytes, both conflicted-file bytes, and `MERGE_HEAD`, `MERGE_MSG`, and `ORIG_HEAD` bytes.
  - The pending-session fixture does not own an agent runtime that can keep development WebSocket liveness stable. To deterministically exercise the compatible-session success path, the handoff read was pinned to a snapshot fetched immediately beforehand from the real `/api/sessions/:id/git` endpoint; the route was then removed and the unresolved-list polling assertion ran against the live endpoint.
  - Screenshot: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-ticket-315\conflict-handoff.png`
  - Screenshot SHA-256: `f589e3daef8ace835f851d28755d3e8ca3db43fa052df2ae6d84cd43527cafe9`.
- `git diff --check`
  - Passed with no whitespace errors.
- `graphify update .`
  - Passed; rebuilt 10,017 nodes, 26,627 edges, and 430 communities. Generated graph outputs are ignored and were not committed.

The full suite was deliberately not run, per the ticket's verification rule for child worktrees.

## Runtime-specific review

Loaded `$code-review` exactly as provided and reviewed the diff from the fixed point `feature/0809-t314` in two explicitly authorized parallel agents, without reviewing or rewriting earlier commits:

- Standards axis: initially found one hard repository-standard violation, a new local provider allowlist that bypassed the repository's provider capability abstraction. The implementation now uses `getProviderExecutionCapabilities`; the final Standards recheck reported no findings.
- Spec axis: across the initial pass and targeted rechecks, found five acceptance-criteria gaps: availability while the composer was disconnected/error, requests exceeding the composer limit, incomplete filesystem/index/sequencer non-mutation evidence, using only pre-await session context, and accepting unknown providers after removing the allowlist. All were fixed or covered; the final Spec recheck reported no findings.

The axes were kept separate as required. Final result: Standards — no findings; Spec — no findings.
Both axes were re-run after the final deterministic E2E adjustment; Standards again reported no findings, and Spec confirmed that the pinned fresh snapshot remains valid success-path evidence alongside the independent stale-state tests.

## Commits

- `969e55e0cb8aedf528fee33bd5e9e5b47ac26152` — `feat(git): add AI conflict handoff draft`
- `eab1b8eafff523c94d16829e46be43a305499ab4` — `fix(git): enforce conflict handoff compatibility`
- `455b47342f9b3d8a9becf9b73d6ad713f48b3d3a` — `fix(git): recheck live handoff context`
- `b26d2a9bc0861e8fb4a2f2a06412b37414acb4df` — `test(git): verify conflict handoff boundaries`

## Not verified or deliberately left out

- No full-suite run, push, or pull request.
- No isolated Windows Electron run. This ticket adds no new path translation or Windows-specific server behavior; the existing Git snapshot boundary supplies the worktree path, while the added behavior is renderer-side request preparation. The WSL dev browser E2E exercised the renderer, real Git repository, real server endpoint, and filesystem non-mutation. A live external provider runtime was not invoked because the feature must stop at an editable draft and must not auto-send it.
- No conflict contents, auto-resolution logic, automatic `git add`, operation continuation, commit, or changes to the existing manual Review diff / Abort flows were added.
- No dependency audit fixes, unrelated lint-warning cleanup, graph community relabeling, or changes to commits inherited from `feature/0809-t314` were made.
