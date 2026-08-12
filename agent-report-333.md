# Agent report — GitHub issue #333

## Outcome

Implemented one Worktree-aware Session materialization path for adaptive List,
Kanban Peek/tab navigation, notification toasts, and the notification center.
Linked Task summaries now become complete retained navigation appearances without
being inserted into direct Project Session pages. Tabs, Peek, Git, and Files keep
the owning Worktree, including the extreme where the same canonical Session also
has a direct origin-Project appearance.

When no direct, retained, or loaded Task appearance exists, materialization now
loads one authenticated canonical Session detail from `GET /api/sessions/[id]`.
The endpoint enriches task-owned rows with the Task's public Worktree identity and
checkout before the client creates a surface or loads conversation history. This
removes the valid-linked-Session `Session Not Found` path from both notification
entry points.

Implementation commit:

`de678110c3e68b925999d2eae16c98876971f70e`

## Main changes

- Extended `ProjectViewWorkspaceState` with async load-and-materialize behavior.
- Added the live client loader and authenticated single-Session detail endpoint.
- Added a retained materialized-appearance lookup that does not pollute direct
  Project Session pagination.
- Routed List, Kanban, toast, and notification-center navigation through the
  shared materialization path.
- Assigned tab/panel Worktree targets from the latest materialized appearance.
- Made Kanban's Session summary conversion use the shared linked-Worktree mapper.
- Added a 175-line isolated browser acceptance test and focused state/navigation
  regressions.

## Ticket and implementation-skill invocation

The provider's `$implement` skill was explicitly invoked by the ticket request.
Its local `SKILL.md` was loaded before implementation, issue #333 was treated as
the supplied ticket, and issue #328 was used as the already-agreed architecture.
The tickets were read with:

```text
gh issue view 333 --repo horang-labs/tessera --json number,title,body
gh issue view 328 --repo horang-labs/tessera --json number,title,body
```

The initial bare `gh issue view` form hit GitHub's removed Projects Classic field;
the JSON form above returned both complete issue bodies successfully.

Graphify was used first for orientation around
`ProjectViewWorkspaceState`, `useSessionNavigation`, List/Kanban, notifications,
and tab/Worktree ownership. `graphify update .` was run after the final code;
the measured graph was 10,787 nodes, 28,341 edges, and 434 communities.

## `/tdd` seams and observed red/green cycles

The primary `/tdd` seam was the public stateful Project View workspace-state
contract agreed in #328. Consumer source-contract tests were supplementary.

- Missing public materialization operation: red was
  `workspace.materializeSession is not a function` (2 pass, 1 fail); green was
  3/3.
- Owning Worktree propagation into a new tab: red observed panel `worktreeId`
  `null` instead of `wt-linked` (1 pass, 1 fail); green passed after central tab
  assignment.
- Retention without direct-page pollution: the browser assertion observed one
  unexpected direct Session card; changing materialization from `upsertSession`
  to retained appearance storage made the direct Project Session count zero.
- Direct-origin plus linked-appearance extreme: focused state test red was 1/2
  with missing `wt-linked`; green was 2/2 after retaining and selecting the
  latest explicit materialized appearance.
- Reviewer-found notification fallback: added a deterministic contract case for
  an empty client snapshot plus a real packaged API boundary check. The case
  passes and verifies the loaded Session is retained with its Worktree.

## Exact verification commands and measured results

```text
npx tsx --test tests/project-view-workspace-state.test.ts tests/project-view-workspace-state-activation.test.ts tests/adaptive-linked-worktree-navigation.test.tsx tests/kanban-project-projection-render.test.tsx tests/kanban-session-peek-contract.test.mjs tests/session-activation-focus-contract.test.mjs tests/unread-notification-priority-contract.test.mjs tests/project-worktree-target.test.tsx tests/project-view-open-session.test.ts tests/project-view-tab-state.test.ts tests/task-child-session-cwd.test.ts tests/board-popout-live-sync-contract.test.mjs
```

Result: 66 tests, 66 pass, 0 fail, 0 skipped; 719 ms TAP duration.

```text
TESSERA_EVIDENCE_DIR="$PWD/.tmp/issue-333-evidence-final" node tests/linked-session-materialization.e2e.mjs
```

Result: exit 0 in 27.95 s. The isolated test created a real Git Project,
Worktree Task, and summary-only Session, asserted the new detail endpoint's
Worktree/path, verified the Session stayed out of direct Project Session pages,
then exercised Kanban Peek and split/tab modes. It also asserted Git panel
`data-worktree-target` in both modes.

Visual evidence:

- `.tmp/issue-333-evidence-final/linked-session-peek.png`
- `.tmp/issue-333-evidence-final/linked-session-tab.png`

Both screenshots were visually inspected. Peek remains open with the conversation;
tab mode shows one Worktree card and a usable conversation surface.

```text
npx tsc --noEmit
```

Result: exit 0, no diagnostics.

```text
npm run lint
```

Result: exit 0, 0 errors and 3 pre-existing warnings outside the diff
(`preview-markdown.tsx`, `use-virtual-message-list.ts`, and
`spawn-cli-runtime.ts`).

```text
bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" --repo "$PWD" --count 1 --session-id "codex-333-0812-0120" --seed-data-dir /home/work/.tessera
```

Result: production Next build, Electron compile/runtime preparation, Windows x64
packaging, and isolated launch all passed. The isolated topology was Windows
Electron main -> Windows packaged server on port 32124. CDP inspection on port
9337 reported `http://localhost:32124/chat`, title `Tessera`, and
`readyState: complete`.

From Windows PowerShell, the packaged server's real
`GET /api/sessions/9d2f1535-35fa-4f09-b34a-6aef40fa6216` response contained
`worktreeId: wt_f9122694498242a884e5d3abf46fc992` and a non-empty `workDir`.

The isolated instance was stopped only through:

```text
scripts/stop-electron-test-session.ps1 -SessionId codex-333-0812-0120 -RemoveData
```

Result: recorded PID 15192 stopped; manifest and isolated data removed. Test
server port 32124 and CDP port 9337 were closed, the installed app's port 32123
remained open, and the source DB SHA-256 matched the launch snapshot:
`fabdf9c2e088193b3aa64bf64c5cda1e1559f1ee5279c7a0958550ed78017b31`.
The generated Downloads portable artifact and unpacked app were moved to Trash
and are recoverable there.

`git diff --check` passed. No full test suite was run, per the wave verification
rule.

## `$code-review` invocation and findings

The exact `$code-review` skill was loaded. The fixed point was
`acc8a58a72c9241ede2c5359ed6bd0e1ad7f63e0`, with:

```text
git diff acc8a58...HEAD
git log acc8a58..HEAD --oneline
```

Two read-only reviewers were spawned in parallel with `fork_turns="none"`:

- **Standards:** initially found 0 hard documented-standard violations. It
  recorded duplicated normalization only as a judgement-only non-finding.
- **Spec:** initially found 1 acceptance gap: notification navigation had no
  canonical-detail fallback if direct, retained, and Task snapshot state were
  all absent.

The Spec finding was applied through the authenticated detail endpoint and async
workspace materialization. Both reviewers then re-ran against amended commit
`de67811`:

- **Standards:** 0 hard violations.
- **Spec:** 0 actionable findings; explicitly confirmed the prior notification
  gap was resolved and surface-before-history ordering remained correct.

## What could not be verified

- The existing broad `tests/adaptive-linked-worktree-navigation.e2e.mjs` was
  attempted twice before the focused e2e was added. It first timed out at
  `page.goto(..., waitUntil: 'networkidle')`, then reached the app but timed out
  in an unrelated zero-Session Worktree overview setup. Temporary edits to that
  file were reverted; it is not part of this diff.
- A second packaged CDP connection intended only to capture another screenshot
  timed out retrieving `/json/version`, although the Electron PID and both ports
  were still live. The initial packaged CDP inspection and Windows-side API
  request had already succeeded. Packaged visual screenshot evidence was not
  captured; the two isolated web screenshots above are the visual evidence.
- There is no literal notification-center click in the browser e2e. That extreme
  is covered by the empty-client-state workspace contract plus the real packaged
  single-Session API response and the notification navigation ordering contracts.

## Deliberately left out

- No visual redesign, spacing/icon/density changes, Collection synchronization,
  Project View domain-model change, store framework migration, or unrelated
  notification work.
- No cleanup of the three unrelated lint warnings or the reviewers' two
  judgement-only duplication observations.
- No full-suite run, push, PR, issue edit, or GitHub bookkeeping.
