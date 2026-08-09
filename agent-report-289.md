# Agent report — GitHub issue 289

## Outcome

Implemented issue 289 from fixed point `00e2aeca0ef2cff53c33f920f32cd4c1ad2411ef`.
A linked Worktree can be imported as another saved Project view while retaining one canonical
Worktree and Session identity. The Project View projection now exposes each Session's stable
origin Project separately from the Project view currently displaying it, and that origin
survives the API, client Session model, linked-Worktree child model, and live task merge.

Implementation commit: `097c43e9ce682da67daeeaf5b5a26bf4187a2ce9`
(`feat(projects): open linked worktrees as project views (#289)`).

## Acceptance-criterion mapping

1. **Known linked checkout reuses canonical identity.** `resolveCanonicalWorktree()` remains
   the single path-identity registry. The new A/C fixture and
   `tests/project-worktree-root.test.ts` prove that importing C reuses the linked task's
   `wt_...` ID.
2. **C resolves as C's Project Worktree.** The fixture imports the real linked checkout C and
   asserts Project C resolves the same canonical Worktree ID originally created from A.
3. **C Sessions remain nested in A.** A's matching Creation Scope projects both the Session
   created through A's linked task and the direct Session created from Project C under linked C.
4. **The same Sessions are direct in C.** C's live `feature/c` Session Scope projects the same
   two IDs as direct Project Sessions.
5. **One canonical Session state.** The fixture mutates the single SQLite Session row and
   verifies title, running, and archive state from both projections. The client-store test
   verifies title, unread, and running updates by canonical Session ID across A/C appearances.
6. **Project view lifecycle is non-owning.** Hiding C leaves both Sessions under A; reopening C
   restores both direct appearances. Hiding A leaves C's direct projection intact, with the
   original `sessions.project_id` unchanged.
7. **Only immediate linked Worktrees project.** A shows linked C but not descendant D; C shows
   D as its immediate linked Worktree.
8. **Origin information is explicit.** `originProjectId` accompanies direct and linked-child
   Session appearances while `projectDir` remains the selected view location. This gives later
   global surfaces one stable representative without changing current view-local navigation.
9. **Real Git/SQLite fixture.** `tests/linked-worktree-independent-project.test.ts` creates A,
   linked C, descendant D, two Projects, and two canonical Sessions against real temporary Git
   worktrees and the real sql.js-backed SQLite persistence. It is 146 lines.

## Files and architecture changed

- `src/lib/projects/project-view-projection.ts` adds the explicit `ProjectViewSession`
  read-model contract and enriches grouped and paginated Project View results with stable
  origin Project identity.
- `src/lib/db/sessions.ts` keeps origin identity in the Session API DTO even when a route later
  changes `projectDir` to the selected Project view.
- `src/lib/db/tasks.ts` includes the per-Session origin on linked Worktree child projections.
- `src/types/chat.ts`, `src/types/task-entity.ts`, `src/stores/session-store.ts`, and
  `src/lib/tasks/merge-tasks-with-live-sessions.ts` preserve the additive compatibility field
  through client loading, live insertion/upsert, canonical state mutation, and task merging.
- `tests/linked-worktree-independent-project.test.ts` is the dedicated A/C/D acceptance fixture.
- `tests/project-view-open-session.test.ts` covers canonical title/unread/running consistency
  across two client Project appearances.
- `tests/task-session-kind.test.ts` proves live task merging retains Session origin.

No schema migration, Session copy, Worktree copy, reparenting operation, or per-Project Session
overlay was introduced.

## Test-first record

- Initial command:
  `node --import tsx --test tests/linked-worktree-independent-project.test.ts`
  failed at the new origin assertion: actual `undefined`, expected `project-a`.
- After the first green slice, the task-merge assertion in
  `node --import tsx --test tests/task-session-kind.test.ts` failed: actual `undefined`,
  expected `origin-project`.
- The implementation added only enough projection/DTO propagation for those seams, then the
  complete A/C lifecycle and canonical-state assertions were added.

## Commands and measured results

### Intake and orientation

- `gh issue view 289 --repo horang-labs/tessera --json number,title,body,url,state` — exit 0;
  issue was open and fully read.
- `git rev-parse HEAD`, `git rev-parse 00e2aeca...`, and `git merge-base HEAD 00e2aeca...` — all
  resolved to `00e2aeca0ef2cff53c33f920f32cd4c1ad2411ef` before implementation.
- Read `AGENTS.md`, `.claude/notes/dev-server.md`,
  `.claude/notes/cross-boundary-testing.md`, `CONTRIBUTING.md`, and ADRs 0001–0005.
- `graphify reflect --if-stale` — exit 0. Auditable graph vocabulary expansion was
  `[canonical, identity, projection, origin, scope, worktree]`.
- `graphify query "canonical identity projection origin scope worktree" --budget 5000` and
  `graphify explain` for `project-view-projection.ts` and `projects.ts` identified the actual
  projection, Session, task, canonical-identity, and API files subsequently inspected.
- `npm install` — exit 0; installed 1,042 packages. npm reported 46 existing audit findings
  (2 low, 13 moderate, 28 high, 3 critical); no lockfile change resulted.

### Focused verification

- `node --import tsx --test tests/linked-worktree-independent-project.test.ts tests/project-worktree-root.test.ts tests/project-view-worktree-scope.test.ts tests/project-view-session-scope.test.ts tests/project-view-open-session.test.ts tests/task-session-kind.test.ts`
  — 14 tests, 14 passed, 0 failed; 3,080.53 ms.
- `npx tsc --noEmit` — exit 0; no diagnostics; 25.06 s.
- `npm run lint` — exit 0; 0 errors and 3 pre-existing unrelated warnings:
  `preview-markdown.tsx` (`no-img-element`), `use-virtual-message-list.ts`
  (`incompatible-library`), and `spawn-cli-runtime.ts` (unused disable directive).
- `git diff --check` and staged `git diff --cached --check` — exit 0.
- The repository-wide test suite was deliberately not run; the orchestrator owns that decision.
- `graphify update .` — exit 0; graph updated to 9,970 nodes, 26,473 edges, and 382
  communities. Graph outputs are ignored.

## Headful browser evidence

Before starting the server, `env | grep -i tessera` was inspected. The dangerous inherited
`TESSERA_APP_ROOT`, `TESSERA_PRODUCTION_DB`, and `TESSERA_ELECTRON_SERVER` variables were not
present. QA then used an explicitly isolated
`TESSERA_DATA_DIR=/home/work/tmp/tessera-289-browser-BNJDx0/data`; `TESSERA_PRODUCTION_DB=1`
selected the already-seeded DB inside that isolated directory, never the user's database.

Server command:

```text
env -u TESSERA_APP_ROOT -u TESSERA_ELECTRON_SERVER -u __CFBundleIdentifier \
  TESSERA_DATA_DIR=/home/work/tmp/tessera-289-browser-BNJDx0/data \
  TESSERA_PRODUCTION_DB=1 TESSERA_ELECTRON_AUTH_BYPASS=1 PORT=3100 npm run dev
```

The server reported `Ready on http://127.0.0.1:3100`. Headful Chrome ran through
`DISPLAY=:99 playwright-cli -s=t289 ... --persistent --headed` against an `Xvfb :99`
display, not WSLg. The browser, server, and Xvfb were stopped after capture.

Evidence (ignored QA artifacts retained in this worktree):

- `\\wsl.localhost\Ubuntu-24.04\home\work\.tessera\worktrees_from_elec\tessera-dev\feature\0809-t289\.playwright-cli\evidence-289\project-a-origin-view.png`
  and matching YAML: Project A showed branch `main`, linked `Linked C`, and nested
  `Direct C Session` plus `Shared C Session`.
- `\\wsl.localhost\Ubuntu-24.04\home\work\.tessera\worktrees_from_elec\tessera-dev\feature\0809-t289\.playwright-cli\evidence-289\project-c-independent-view.png`
  and matching YAML: Project C showed Project Worktree branch `feature/c`, both Sessions as
  direct rows, and no `Linked C` self-row.

Authenticated browser API observations:

- Project C used canonical Worktree `wt_2a6ffca64cb948c39af897fa9bd6f1d7` at branch
  `feature/c`.
- Both views returned the same IDs. `direct-c-session` retained origin Project C and
  `shared-c-session` retained origin Project A, while both C appearances used C as `projectDir`.
- Hiding C returned HTTP 200 and A still returned both Session IDs. Reimporting C returned
  HTTP 200 and C again returned both direct Session IDs.

The only browser console issues were unrelated fixture/setup noise: favicon 404 and provider
rate-limit polling unable to initialize the external Codex app-server. Neither affected the
Project/session APIs or rendered acceptance flow.

## Two-axis code review

Review fixed point: `git diff 00e2aeca0ef2cff53c33f920f32cd4c1ad2411ef...HEAD`.
Before spawning reviewers, the fixed point resolved and the diff was confirmed non-empty.
Standards and Spec ran as independent read-only agents in parallel.

### Initial Standards findings

1. Judgement call: possible Duplicated Code/Shotgun Surgery because `originProjectId` is
   explicitly propagated across projection, API, task-child, and client DTO boundaries.
2. Judgement call: the dedicated A/C fixture repeats some setup from the 196-line issue #288
   fixture.
3. Hard documented-standard violations: none.

Disposition: rejected both judgement calls. The origin value deliberately crosses distinct
public compatibility contracts; centralizing it in one layer would not populate the other DTOs
and would hide rather than remove the required mappings. The earlier fixture is already 196
lines, so extending it would violate the 200-line ceiling; extracting shared setup would broaden
the ticket into test-infrastructure refactoring, while the new 146-line fixture uniquely covers
origin metadata, hide/reopen lifecycle, canonical mutations, and the A/C/D view split.

### Initial Spec findings

1. P1: existing Move-to-Project UI/API remains.
2. P1: existing tab resolution can choose the first A/C appearance.
3. P2: existing foreign Collection placement is not normalized to Uncategorized.
4. Scope creep: none.

Disposition: rejected as explicitly decomposed follow-up scope, not omissions from issue #289.
Tabs and Collections are the complete subject of #290, which is blocked by #289. Removing Move
to Project and the broader lifecycle command changes are the complete subject of #293, also
blocked by #289. Implementing either dependent ticket here would violate the request to implement
#289 exactly. Issue #289's lifecycle criterion—hiding either Project view without copying,
reparenting, or deletion—is implemented and verified.

### Final Standards and Spec findings

No valid ticket-scoped finding required a code change, so the fixed diff did not change after
review and the skill's material-change rerun condition did not apply. Final findings therefore
equal the initial reports and dispositions: Standards has 0 hard findings and 2 rejected
judgement calls; Spec has 3 rejected follow-up-scope findings and no scope creep. Worst reported
Standards concern was cross-layer origin propagation; worst reported Spec concerns were the
existing Move action and tab placement, reserved for #293 and #290 respectively.

## What could not be verified

- No isolated Windows Electron instance was run. The implemented behavior is an in-process
  Project View/SQLite/Git/API/client read-model change and does not cross an OS, process,
  filesystem-translation, or network boundary. A Windows Electron shell pointed at the WSL dev
  server would not exercise a Windows server branch and would add no relevant evidence.
- No real provider conversation was started; provider startup is unrelated to Project projection.
- The orchestrator-owned repository-wide suite was not run.

## Deliberately excluded scope

- Project-local tabs and Collection fallback (#290).
- Adaptive zero/one/many linked Worktree navigation (#291).
- Kanban/global-surface consumption of the new origin field (#292). This ticket exposes the
  origin contract required by those surfaces but does not redesign them.
- Move-action removal, Worktree deletion guards, and broader lifecycle commands (#293).
- One-hop branch rename warnings (#294).
- Recursive Worktree trees, Session/Worktree reparenting, copied Session state, schema changes,
  provider diagnostics, dependency remediation, and unrelated lint warnings.
- Push and PR creation.
