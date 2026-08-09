# Agent report — GitHub issue #286

## What changed and why

Issue #286 makes the checkout opened by a Project a canonical, selectable Worktree without removing the project-owned compatibility model needed by later migration tickets.

- Added schema v34 with a canonical `worktrees` registry and `projects.project_worktree_id`. Path keys are canonicalized, branch-independent, and shared when multiple Project views expose the same checkout.
- Migrated eligible Git Projects and existing task-owned Worktree identities into the registry while leaving legacy non-Git Projects readable and unresolved.
- Added Project Worktree metadata to the Projects API. The live branch is read from Git administrative files during normal Project refresh; no continuous watcher and no Git child process per rendered row were added.
- Added a real Worktree target to panel state, a branch-icon Project Worktree row, and a minimal center overview with current branch, path, New Session, and New Worktree actions.
- Added direct Worktree Git and Files API routes and routed the right panel by Worktree identity when no Session exists. Existing Session routes and project-owned fields remain available.
- Added real SQLite/Git integration coverage, rendered component/store routing coverage, and a 133-line browser e2e covering sidebar selection, center overview, sessionless Git/Files, and reload persistence.

## Implementation skill and TDD

The user invoked `$implement` with issue #286 as the ticket. The OpenAI provider loaded `/home/work/.agents/skills/implement/SKILL.md`, used the supplied ADRs as the agreed design, and invoked `/tdd` at these pre-agreed public seams:

1. Real SQLite + Git: Project registration/import -> canonical Worktree persistence and Project-root resolution.
2. Rendered/store/API target: Project Worktree selection -> a real Worktree panel target -> sessionless Git/Files routing.

RED evidence:

- `npx tsx --test tests/project-worktree-root.test.ts` failed because `src/lib/db/worktrees` did not exist.
- `npx tsx --test tests/project-worktree-target.test.tsx` failed because the Worktree row/overview components did not exist.

Each seam was then implemented to GREEN. The post-review e2e was coverage hardening rather than a new domain seam; its first executions exposed and corrected test-harness assumptions about request origin, panel-open state, and duplicate visible labels.

## Exact verification commands and measured results

- `gh issue view 286 --repo horang-labs/tessera` — could not render because GitHub's Projects Classic GraphQL field is retired. `gh api repos/horang-labs/tessera/issues/286 --jq '{title,body,html_url}'` successfully retrieved the complete issue instead.
- `npm ci` — installed 1,042 packages. npm reported 46 dependency audit findings; no dependency or lockfile changes were made.
- `npx tsx --test tests/project-worktree-root.test.ts tests/project-worktree-target.test.tsx tests/worktree-identity-persistence.test.ts tests/worktree-identity-migration.test.ts tests/git-panel-poll-refresh.test.ts tests/workspace-file-scan.test.ts tests/tab-new-tab.test.ts tests/tab-session-open.test.ts` — 36 passed, 0 failed; final duration 2,481 ms.
- `node tests/project-worktree-selection.e2e.mjs` — passed: Project Worktree selection, direct Git/Files routing, and reload persistence. The new e2e is 133 lines and terminates only its own isolated server process group.
- `npx tsc --noEmit` — exit 0, no diagnostics.
- `npm run lint` — exit 0, 0 errors. Three pre-existing warnings remain in `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`; no warning is in changed code.
- `git diff --check` — no whitespace errors.
- `graphify update .` — code-only AST update completed; final graph: 9,895 nodes, 26,339 edges, 370 communities. Generated graph files are ignored and did not enter the commit.

The full test suite was deliberately not run because the ticket explicitly forbids a full-suite run in a child worktree; the orchestrator owns that decision after integration.

## Runtime verification

Before starting the server, `.claude/notes/dev-server.md` was read and inherited Tessera variables were checked. The isolated server was launched with:

```sh
env -u TESSERA_APP_ROOT -u TESSERA_PRODUCTION_DB -u TESSERA_ELECTRON_SERVER -u __CFBundleIdentifier \
  TESSERA_DATA_DIR=/home/work/tmp/tessera-t286-dev-ArzNGe \
  TESSERA_ELECTRON_AUTH_BYPASS=1 PORT=3100 npm run dev
```

The browser was opened with the required persistent form:

```sh
playwright-cli -s=t286-root open http://127.0.0.1:3100 --persistent
```

The isolated account was configured with `agentEnvironment: wsl`, matching the WSL server/checkout used for this web verification. Measured observations with zero Sessions:

- Project Worktree row showed `feature/0809-t286`; selection survived reload.
- Center overview showed the checkout path, branch, New Session, and New Worktree; both actions reached their expected creation UI.
- `GET /api/worktrees/wt_86ff75197d2841479d203fe8e439996e/git` returned 200 and rendered 33 changed files.
- `GET /api/worktrees/wt_86ff75197d2841479d203fe8e439996e/files` returned 200 and rendered 1,386 files including `README.md`.
- Screenshots were captured and visually inspected at `/home/work/tmp/t286-project-worktree-git.png` and `/home/work/tmp/t286-project-worktree-files.png` (both 1280x720).

`DISPLAY=:99 xdpyinfo` reported unavailable, so no headful Linux/WSL run was attempted and no user-visible WSLg display was used. The persistent headless browser and the exact dev server were closed by session/PID. Electron was not used because this ticket's accepted behavior does not cross the Windows/WSL boundary; cross-boundary canonical routing is explicitly follow-up #295.

## `$code-review` invocation and findings

Fixed point: `1515ebe94d04d0fb33b8d4bd2f80a92e05c6c722`  
Reviewed commit at invocation: `38b83b3d0e6dc2867c06a261e44f0d0a7ea64f69`  
Diff: `git diff 1515ebe94d04d0fb33b8d4bd2f80a92e05c6c722...HEAD`  
Commits: `git log 1515ebe94d04d0fb33b8d4bd2f80a92e05c6c722..HEAD --oneline`

The `$code-review` skill ran two review-only agents concurrently with `fork_turns="none"`.

### Standards

The reviewer reported one alleged ADR violation: `src/app/api/sessions/projects/route.ts` still obtains Sessions through the project-owned compatibility query rather than projecting them through Worktree identity. No other hard documented-standard violation was found, and path handling was confirmed to use server-resolved filesystem paths with `userId` threaded into Git environment resolution.

Disposition: not applied. Issue #286 explicitly calls this the additive “expand” migration step and requires existing project-owned read paths to remain as compatibility. Moving Session projection now would violate this ticket's scope and acceptance criterion 9; follow-ups #287, #290, #292, and #296 own that contraction.

### Spec

The reviewer reported two findings:

1. The Worktree Files panel lists/copies paths directly but file-tab preview interactions remain Session-scoped.
2. Existing rendered tests did not click through sidebar selection and prove the center/Git/Files target end to end.

Disposition:

- Finding 1 was not treated as an acceptance gap. The ticket asks for a minimal Worktree experience and direct Files operation; the Worktree Files panel directly reads and browses the checkout with zero Sessions. Migrating the separate special file-tab/watch lifecycle would expand the ticket beyond its stated criteria.
- Finding 2 was valid and was applied as `tests/project-worktree-selection.e2e.mjs`; it exercises the actual rendered row, target persistence, center actions, direct Git route, and direct Files route with zero Sessions.

Review summary: Standards reported 1 finding, rejected as conflicting with the ticket's explicit compatibility requirement. Spec reported 2 findings; 1 was fixed and 1 was adjudicated outside the minimal acceptance scope. No accepted review finding remains unresolved.

## Commits

- `38b83b3d0e6dc2867c06a261e44f0d0a7ea64f69` — implementation and TDD coverage.
- `2741cebaa4b6fe4b6409b29d8538a9e3df0a5b07` — valid review finding: rendered target-selection e2e.

## Deliberately left out / not verified

- No push and no pull request, as requested.
- No full-suite run in this child worktree.
- No Windows packaged Electron run and therefore no claim about Windows-server/WSL-CLI path translation; issue #295 owns that boundary.
- No conversion of historical Session/Collection/Kanban projection from Project ownership to Worktree ownership; issues #287–#296 are the agreed migration follow-ups.
- No continuous filesystem watcher for Project Worktree branch metadata.
- No migration of special file-preview tabs or live file watching away from their existing Session-scoped lifecycle; Worktree Files browsing itself is direct and sessionless.
