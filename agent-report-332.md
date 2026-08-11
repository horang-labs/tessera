# Agent report — GitHub issue #332

## Outcome

Implemented Project View mutation convergence for every loaded appearance of a canonical Task, Worktree, or Session. The initiating window updates optimistically, receiving windows update synchronously from the WebSocket payload, and both then reconcile from the server without allowing an older Project refresh to overwrite a newer transition.

The packaged Windows-server/WSL-agent workflow transition now converges in both the origin A client and alternate Worktree C client. The title check was retained as an additional assertion; it was not used as a substitute for workflow convergence.

Implementation commits:

- `44f9905` — `fix(project-view): converge cross-window mutations (#332)`
- `3172749` — `fix(project-view): preserve restore appearances (#332)`
- `49e3cbe` — `fix(project-view): converge remote workflow transitions (#332)`

Fixed point used for review: `4aa7e187387e6000b1925f13b3dba260ee975d57`.

## What changed and why

- Mutation messages now carry canonical `taskId`/`sessionId`, affected Project View IDs, and the changed title, workflow, preparation, or archive value. A receiving client can therefore apply the real transition immediately instead of waiting for a background fetch.
- Mutation producers and archive/restore endpoints resolve all loaded appearances, including the canonical Project and the Worktree-owning Project, and return/broadcast that scope.
- The shared Project View workspace reducer updates every A/C Task appearance, linked/direct Session appearance, and retained Session without leaking Project-local Collection state.
- Session-only alternate views are updated even when that client has no Task row in its Task store.
- Project loading is latest-request-wins. This prevents a slower response started by an earlier mutation from overwriting a newer workflow projection.
- Task and Session archive/restore use the same workspace-state transition on the initiating client, with rollback on request failure. Restore covers zero, one, and many active child Sessions.
- Archive projections preserve whether each Task child was archived independently. Optimistic Task restore filters those children, matching the server rule that restoring a Task does not restore a separately archived Session.
- Restored Tasks appear in every affected A/C Task view, but direct Session rows appear only in the Worktree-owning C view. This matches the A-task-child/C-direct topology.
- Added a focused 184-line packaged Electron E2E. Before mutation it fails closed unless CDP and server URLs are loopback, the server is not normal port `32123`, the data directory and port belong to the same launcher manifest, the renderer origin matches that server, and the renderer reports Electron.

## Root cause and runtime workflow evidence

The original packaged transition failed after 20 seconds in origin A even though the server log showed that the client received `task_mutated` and the API had persisted `workflow_status=in_progress`. The protocol did not include the changed workflow value, so every receiver depended on an asynchronous refetch.

The first synchronous projection made A pass, but C still timed out after 20 seconds. The logged workflow message had no `sessionId`: the Task route only looked up its single linked Session when the title changed. In addition, the reducer returned early when C contained only the linked direct Session and no Task row. Looking up the single linked Session for every Task patch and allowing Session-only matching fixed this failure.

The reverse `in_progress -> todo` transition then timed out in C. Two `loadProjects()` calls were in flight: an older title-triggered response completed after the newer workflow response and restored stale `in_progress`. A monotonically increasing request generation now discards stale Project responses.

The corresponding `/tdd` red observations were:

- immediate title projection: expected the renamed title, observed `Shared Worktree`;
- Session-only alternate projection: expected `in_progress`, observed `todo`;
- refresh ordering: expected final `todo`, observed stale `in_progress`.

After the fixes, the isolated packaged run completed with exit code 0:

- launcher session: `codex-332-08120308`;
- topology: packaged Windows Electron source A + packaged Windows server on `127.0.0.1:32124` + WSL `Ubuntu-24.04` agent setting; a separate headless Windows Edge client was paired to the same isolated server and selected alternate Project C;
- CDP: `http://127.0.0.1:9337`;
- portable artifact SHA-256: `022ee655bc96dc793848c959d7fa91cf18c27dd3cd728701648b5eda4e4b7ed1`;
- launched unpacked `Tessera.exe` SHA-256: `be14d05902124d2e4483d6b990a5fb88e253f9435801fdcd0a9ba33544f7cc60`;
- owner A: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\issue-332-runtime-a`;
- alternate C: `\\wsl.localhost\Ubuntu-24.04\home\work\.tessera\worktrees\issue-332-runtime-a\test\issue-332-runtime`;
- Task: `task_15b0d513-67c2-4a65-8f18-fc7addfba2ce`;
- linked Session: `70f20a5a-3a1c-492f-8fe6-70c43a459639`;
- measured workflow: `todo -> in_progress -> todo` in both source A Task and receiver C Session;
- measured title: `Issue 332 cross-window runtime fixture -> Issue 332 converged fba2ce -> Issue 332 cross-window runtime fixture` in both clients;
- source A and receiver C Project-strip selection assertions remained true throughout.

The mutation log corroborated the UI assertions:

- `17:43:45.716`: `task_mutated` with the Task ID, linked Session ID, and `workflowStatus:"in_progress"`;
- `17:43:45.947`: the same identities and the converged title;
- `17:43:46.157`: the title restoration;
- `17:43:46.292`: the same identities and `workflowStatus:"todo"`.

The server logged the corresponding successful Task update after every mutation. Screenshots were captured and inspected during the isolated run. The receiver screenshot visibly showed Project C, the Doing column, and the renamed linked Session. The source screenshot showed Electron A with the selected anchor terminal overlay; source Task correctness therefore rests on the explicit DOM/geometry assertion, not a visual claim. The screenshots lived under the isolated data root and were removed with that runtime.

Normalized runtime commands (WSL paths were converted to Windows/UNC paths before the Windows Node invocation):

```bash
bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" \
  --repo "$PWD" --count 1 --session-id codex-332-08120308 \
  --seed-data-dir /home/work/tmp/issue-332-runtime-seed \
  --artifact "$PWD/release/Tessera-0.2.3-hotfix.1-windows-x64.exe"

powershell.exe -NoProfile -Command \
  "& 'C:\Program Files\nodejs\node.exe' '\\wsl.localhost\Ubuntu-24.04\home\work\.tessera\worktrees_from_elec\tessera-dev\feature\0811-t332\tests\project-view-cross-window-electron.e2e.cjs' \
  '\\wsl.localhost\Ubuntu-24.04\home\work\.tessera\worktrees_from_elec\tessera-dev\feature\0811-t332' \
  'http://127.0.0.1:9337' 'http://127.0.0.1:32124' \
  'C:\Users\work\AppData\Local\TesseraTestInstances\codex-332-08120308\data' \
  '\\wsl.localhost\Ubuntu-24.04\home\work\tmp\issue-332-runtime-a'"
```

## Verification commands and measured results

```bash
npx tsx --test \
  tests/project-view-cross-window-mutation.test.ts \
  tests/project-view-workspace-state.test.ts \
  tests/project-view-task-mutation.test.ts \
  tests/task-session-archive.test.ts \
  tests/project-view-session-lifetime.test.ts \
  tests/linked-worktree-independent-project.test.ts \
  tests/control-session-database.test.ts \
  tests/control-worktree-creation.test.ts \
  tests/terminal-session-runtime-state.test.ts \
  tests/project-view-session-scope.test.ts
```

Result: 89 tests passed, 0 failed, 0 skipped; 5.65 seconds reported by the test runner (5.85 seconds wall time).

```bash
npx tsc --noEmit
```

Result: exit 0; 10.60 seconds.

```bash
npm run lint
```

Result: exit 0; 29.33 seconds; 0 errors and 3 existing warnings in `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`.

```bash
node --check tests/project-view-cross-window-electron.e2e.cjs
wc -l tests/project-view-cross-window-electron.e2e.cjs
git diff --check
```

Result: syntax check and whitespace check passed; E2E length is 184 lines.

```bash
graphify update .
```

Result: exit 0; 21.20 seconds; graph rebuilt with 10,845 nodes, 28,488 edges, and 434 communities. Graphify noted that saved community labels should be refreshed separately because the community set changed.

The installed application was preserved. Before and after isolated testing, `/home/work/.tessera/tessera-dev.db` SHA-256 was `fabdf9c2e088193b3aa64bf64c5cda1e1559f1ee5279c7a0958550ed78017b31`; the original Tessera process set remained present, and isolated ports `32124`/`9337` were closed after cleanup. Temporary test repositories/data were removed, and only the uniquely named failed-launch partial directory and installer were removed from Windows Downloads.

## Implementation skill and `/tdd`

The provider `$implement` skill was invoked by reading and following `/home/work/.agents/skills/implement/SKILL.md`, with GitHub issues #332 and #328 treated as the supplied ticket and agreed design context. Its exploration, characterization, design, implementation, validation, review, and delivery phases were followed.

The implementation skill delegated test-first seams through `$tdd` (`/home/work/.agents/skills/tdd/SKILL.md`): the public Project View workspace reducer, WebSocket handler with refetch held pending, stale Project-load race, affected-view database projection, archive/restore projection, and packaged Electron A/C scenario. The packaged and focused red results above were retained as the evidence that each seam failed for the intended reason before its green change.

## `$code-review` invocation and findings

The exact `$code-review` skill at `/home/work/.agents/skills/code-review/SKILL.md` was loaded and used against fixed point `4aa7e187387e6000b1925f13b3dba260ee975d57`. Its two explicitly authorized agents ran in parallel:

- Standards axis (`standards_review`, James): initially found no production-code hard violation, then found that the new E2E needed a fail-closed launcher-manifest guard before persistent mutation. The guard was added. Follow-up result: accepted, no remaining hard documented-standard violation.
- Spec axis (`spec_review`, Descartes): first found that restore needed stable affected Project View IDs and initiating-window optimistic projection. After those fixes, it found independently archived Task children could be resurrected and direct Sessions were being inserted into both A and C. Archive flags, filtering, canonical direct placement, and zero/one/many source tests were added. Follow-up result: no remaining acceptance-criteria findings.

The runtime E2E deliberately remains focused on the key observed workflow failure plus title non-regression and reverse-transition extreme. Preparation, archive, restore, and zero/one/many density are exercised at deterministic reducer, handler, database, and service seams rather than expanding the packaged E2E beyond the ticket's size rule.

## What could not be verified

- A later attempt to relaunch the isolated package after adding the test-only manifest guard failed before startup: Windows C: had about 353 MB free, and copying the uniquely named unpacked app ended with `No space left on device`. The partial unpacked directory and copied installer were removed. No normal Tessera process or data was touched. Consequently, the manifest guard itself has syntax, focused-test, type, lint, and reviewer evidence but was not rerun against Electron.

  ```bash
  bash .codex/skills/tessera-electron-dev/scripts/build_and_launch.sh \
    --repo "$PWD" --count 1 --session-id codex-332-final-08120255 \
    --seed-data-dir /home/work/tmp/issue-332-final-seed \
    --artifact "$PWD/release/Tessera-0.2.3-hotfix.1-windows-x64.exe"
  ```

  Result: exit 1 after 2.71 seconds during the pre-launch copy; no manifest-owned runtime started.
- The final restore-only archive projection refinements were not rebuilt into another Windows package because of that disk limit. They are covered by the 89-test targeted run and TypeScript/lint gates. The workflow code exercised by `codex-332-08120308` is the same workflow implementation committed in `49e3cbe`.
- Preparation, archive, and restore were not claimed as packaged visual observations. Their acceptance coverage is deterministic and cross-view, but not screenshot evidence.
- The full test suite was not run, as required by the orchestrator's child-worktree verification rule.

## Deliberately left out

- No schema migration, broad Project View redesign, or unrelated refactor.
- No full-suite run, push, or pull request.
- No changes for the three unrelated lint warnings.
- `npm ci` reported 46 existing audit findings (2 low, 13 moderate, 28 high, 3 critical); dependency remediation is outside #332.
- No user-owned Windows files or older test artifacts were deleted to manufacture free space for another packaged run.
