# Issue #294 implementation report

## Outcome

Implemented [#294: Warn about exact one-hop external branch renames](https://github.com/horang-labs/tessera/issues/294) from fixed point `00e2aeca0ef2cff53c33f920f32cd4c1ad2411ef`.

Tessera now reads local reflog files once at the Project projection boundary and shows a non-destructive warning only when it can prove one exact direct rename and the previous branch name owns hidden active Session Scope or Worktree Creation Scope. The warning never reveals or migrates those records. Dismissal persists only for the exact reflog rename event; a later distinct event, including one reusing the same branch names, warns again. A newly observed branch clears stale warning evidence synchronously while Project refresh establishes any new evidence.

Implementation commits:

- `6e41b9020308b135596170dd84221acd6e0adf45` — `feat(projects): warn on direct branch renames (#294)`
- `f939508d991edd0db8dfc2875e3549d84da73040` — `fix(projects): harden branch rename evidence (#294)`
- `0a0f0ccc1b52937217de44534cad73a03e0dd353` — `fix(projects): clear stale rename warnings (#294)`
- `3e62e358a4097095c84db7ee43af0eb44cedb9f2` — `fix(projects): accept valid reflog identities (#294)`

The branch and merge-base were both confirmed at `00e2aeca0ef2cff53c33f920f32cd4c1ad2411ef` before editing. The fixed-point diff is non-empty.

## Acceptance-criterion mapping

1. **Exact direct one-hop detection:** `readExactOneHopBranchRename()` resolves main and linked-worktree Git directories, reads the current branch reflog directly, validates Git record structure, proves a complete retained history, requires exactly one rename, and requires its destination to equal the current branch. It accepts valid SHA-1/SHA-256 records and empty committer email identities.
2. **Warn only for hidden prior scope:** Project projection gates the warning through aggregate SQLite existence checks for active Session Scope or Worktree Creation Scope belonging to the prior branch and originating Project Worktree.
3. **No reveal, rewrite, or mutation:** the API exposes only previous/current names plus an opaque event identity. Real SQLite tests snapshot `projects`, `worktrees`, `sessions`, and `tasks`, and assert the snapshot, stored Session Scope, Worktree Creation Scope, and Start Point remain unchanged.
4. **No speculative mismatch warning:** a real checkout onto an unrelated branch produces ordinary exact-name filtering and no warning. A changed observed branch also removes stale client evidence immediately.
5. **Conservative fallback:** real tests cover two consecutive renames, a partially truncated multi-hop reflog, a missing reflog, malformed message-only records, and unrelated branch mismatches; all yield no special recovery or warning.
6. **Project-level refresh/no per-item Git process:** inspection runs once from `getProjectViewProjection()`. It uses filesystem reads and aggregate database queries, not a spawned Git process for each Session or Worktree.
7. **Real Git/SQLite coverage:** temporary repositories perform actual commits and `git branch -m`; the test database contains real Session and Worktree scope rows and proves filtering plus immutability.
8. **Understandable, non-blocking rendering:** browser and Electron evidence shows the old/new names, why items are hidden, and that Tessera did not move/change them. New Session and New Worktree remain reachable. Dismiss/reload/new-event behavior and a 44px phone dismissal target are covered.

The implementation does not change ADR 0002 Worktree Creation Scope, ADR 0003 Session Scope, or Start Point semantics.

## Files and architecture changed

- `src/lib/db/worktree-identity.ts`: shared Git-directory resolution, Windows-host/WSL linked-worktree pointer translation, strict direct-reflog proof, and opaque rename-event identity.
- `src/lib/db/sessions.ts`, `src/lib/db/tasks.ts`: aggregate active-scope existence queries.
- `src/lib/projects/project-view-projection.ts`, `src/app/api/sessions/projects/route.ts`: Project-level warning computation and API projection.
- `src/lib/projects/branch-rename-warning.ts`, `src/stores/session-store.ts`, `src/types/chat.ts`: event-specific persistent dismissal, stale-warning clearing, and client contract.
- `src/components/worktree/branch-rename-warning.tsx`, `src/components/chat/sidebar.tsx`: non-blocking warning UI and accessible phone-sized dismissal control.
- `src/lib/i18n/{en,ko,ja,zh,types}.ts`: localized warning copy and keys.
- `tests/project-branch-rename-warning.test.ts`: real Git and SQLite behavior/immutability coverage.
- `tests/project-branch-rename-warning-dismissal.test.ts`: exact-event persistence, same-name/new-event behavior, and stale-warning clearing.
- `tests/project-branch-rename-warning.e2e.mjs`: rendered browser behavior (150 lines).
- `tests/project-branch-rename-warning-electron.e2e.cjs`: isolated packaged Electron bridge/dismissal behavior (42 lines).

`graphify query`/`graphify explain` oriented the work around Project projection, Worktree identity, Session/Task scope, the Projects API, store, and sidebar. Final `graphify update .` rebuilt an ignored graph with 9,998 nodes, 26,532 edges, and 390 communities.

## Verification

### Test-first evidence

Before implementation, the new focused tests failed because `branchRenameWarning` was absent and dismissal was not retained. After implementation and review fixes, they passed.

Final focused command:

```text
node --import tsx --test tests/project-branch-rename-warning.test.ts tests/project-branch-rename-warning-dismissal.test.ts tests/project-view-session-scope.test.ts tests/project-view-worktree-scope.test.ts tests/project-view-open-session.test.ts tests/project-worktree-root.test.ts
```

Result: 14 tests passed, 0 failed, 0 skipped in 2,579.3651 ms. This includes real rename, immutable database, unrelated mismatch, multi-hop, truncated/missing/malformed reflog, empty-email reflog, persistent exact-event dismissal, stale clearing, and the existing Session/Worktree projection compatibility contracts.

Rendered browser command:

```text
DISPLAY=:99 TESSERA_E2E_PORT=34294 TESSERA_E2E_SCREENSHOT=/home/work/tmp/tessera-294-branch-rename-warning-final.png node tests/project-branch-rename-warning.e2e.mjs
```

Result: passed. It rendered the warning, measured the phone close control at the repository's 44px minimum, kept New Session reachable, persisted dismissal through reload, and displayed a new warning for a distinct event. No WSLg was used.

Static verification:

```text
npx tsc --noEmit
npm run lint
git diff --check
```

Results: TypeScript passed; lint completed with 0 errors and three existing warnings outside this ticket's diff (`preview-markdown.tsx`, `use-virtual-message-list.ts`, `spawn-cli-runtime.ts`); diff check passed.

No repository-wide full test suite was run, per the ticket instruction.

### Headful browser evidence

Inherited variables were checked with `env | grep -i tessera` before starting a server. Port 3100 was already owned by another Tessera process and was left untouched. A sanitized isolated dev server used port 34295 and an isolated data directory. Browser automation used `DISPLAY=:99` and the required persistent named Playwright session (`-s=t294-rename --persistent --headed`), which was closed and deleted afterward.

- Final rendered E2E screenshot: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-294-branch-rename-warning-final.png` (SHA-256 `699c9bdd9b6decb4c1bc59c1a1366abdd6552c19626a65cabca732f723bbe7b7`)
- Manual headful acceptance screenshot: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-294-branch-rename-warning-headful.png` (SHA-256 `499e88253b6057a243116de03866fd90d1527fed8a90f44aab6c1591d692ca49`)

Observed UI: the sidebar displayed “Branch renamed outside Tessera,” `main` to `renamed`, the hidden-scope explanation, and the explicit statement that Tessera did not move/change the items. New Session and New Worktree remained usable. Dismissal removed the warning and reload did not restore the same event.

### Isolated Windows Electron evidence

The bridge-specific path handling was exercised because packaged Tessera is a Windows server reading a WSL CLI-owned linked-worktree `.git` pointer.

Build/launch command:

```text
bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" --repo "$PWD" --count 1 --session-id "t294-6e41b90-2149" --seed-data-dir /home/work/tmp/t294-electron-qa-6e41b90/seed --output-name Tessera-t294-6e41b90.exe --output-dir-name Tessera-t294-6e41b90-unpacked
```

The isolated package compiled successfully and launched Electron PID 44120 with its real packaged server on `http://localhost:32124/` and CDP on `http://127.0.0.1:9337`. `tests/project-branch-rename-warning-electron.e2e.cjs` passed against that renderer: the Windows server read an absolute WSL linked-worktree pointer and reflog, rendered `rename-source -> renamed`, kept New Session reachable, and retained dismissal after reload.

- Electron screenshot: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\tessera-294-electron-branch-rename.png` (SHA-256 `06c812dc01468f9349c605037fb14fd41bab12121043fe07e8c04b4e0fd0d047`)
- Isolated database hash before/after: `2e34ef5913f79655224e140238560d3f6760486544e71c2d54cc6560660ca59c` (unchanged)
- User's source development database hash before/after: `e3271c7dc7a9ef4babfc82be8bb84e2c50ae0828f59509097c1e360fbea9c380` (unchanged)
- Installed Tessera PID 33516 remained on port 32123; the test used 32124/9337 and did not use `TESSERA_DEV_PORT`.

The instance was stopped through its ownership manifest; ports 32124/9337 closed and isolated data was removed. The unique generated Downloads artifacts and seed/release directories were moved to trash. Other Tessera and issue-304 instances were not touched.

## Code review

The required `$code-review` ran two independent agents against the fixed point: Standards read repository guidance plus ADRs 0001-0005; Spec read issue #294 plus ADRs 0001-0005.

Initial review of `6e41b90`:

- Standards: no hard violation. Accepted the judgment finding to remove duplicate `.git` pointer resolution. Rejected sharing the TypeScript store fixture with the standalone MJS browser fixture: they intentionally test separate public seams/runtimes, and sharing would couple the browser harness to store-test construction without removing production duplication.
- Spec: accepted high findings for partially expired multi-hop history and Windows-server/WSL linked-worktree pointer translation. The claim that persistent dismissal was unrequested was rejected because the user explicitly required one-time persistence; its valid reused-name concern was accepted by adding an opaque exact-event identity.

Review after `f939508`:

- Standards: accepted the phone touch-target and malformed reflog-record findings.
- Spec: accepted the stale-warning finding and cleared warning evidence synchronously when the observed branch changes.

Review after `0a0f0cc`:

- Standards and Spec independently found that valid empty-email reflog identities were rejected and that `{40,64}` admitted invalid intermediate object-ID lengths. Both were accepted; `3e62e35` permits `<>`, requires exactly 40 or 64 hex characters, and adds a real Git regression test.

Final review of `00e2aeca..3e62e35`:

- Standards hard violations: none.
- Standards judgment findings: none.
- Spec findings: none. The reviewer confirmed all issue criteria, ADR constraints, exact-event persistence, stale clearing, and Windows/WSL bridge handling are covered.

## What could not be verified

- The repository-wide full test suite was intentionally not run; the orchestrator owns that decision.
- The isolated Windows package exercised the bridge and valid real reflog path after the bridge/truncation fix, but was not rebuilt after the later platform-neutral event-key, stale-client-state, phone touch-target, and reflog-format refinements. Those later changes were covered by final real-Git unit tests, browser E2E, TypeScript, and lint.
- No production database or installed Tessera instance was modified.

## Deliberately excluded scope

- No Session Scope, Worktree Creation Scope, Start Point, Project, Session, or Worktree migration/rewrite.
- No hidden item names or records are returned by the warning API.
- No general branch history, multi-hop recovery, expired-history recovery, or ambiguous-history guessing.
- No per-item Git process spawning.
- No unrelated lint-warning cleanup, no push, and no pull request.
