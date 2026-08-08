# Agent report — GitHub issue #274

## What changed and why

Implemented the server-side prefactor requested by
[`horang-labs/tessera#274`](https://github.com/horang-labs/tessera/issues/274).

- Added `createGitWorktree` in `src/lib/worktrees/create.ts` as the single Git-creation seam.
- Added the tagged `WorktreeCreationSource` with its sole current member,
  `{ mode: 'branch-off', baseRef }`.
- Changed both the HTTP Worktree route and control Worktree creator to construct that source
  explicitly and call the shared function.
- Moved `git worktree add` argument construction and best-effort `branch.<name>.base` recording
  behind the shared function. The separately exported/tested argument builder was removed.
- Replaced the argument-array assertion with a real temporary-repository test that checks the
  created branches, commits, recorded local/remote bases, and absent upstream configuration.

The existing validation, naming/path allocation, persistence, preparation, compensation, and
caller-specific error mapping remain outside the new seam and unchanged.

## User-visible non-regression evidence

- **Branch names and Worktree paths:** the unchanged control-creation suite passed 4/4. It checks
  exact local and remote branch names and exact paths derived by the managed path policy.
- **Recorded bases:** the real-repository creation test reads Git config and observed
  `refs/heads/main` for the local base and `refs/remotes/origin/develop` for the remote base.
- **Remote-base upstream:** the same test found no
  `branch.tw/(local|remote).(remote|merge)` configuration. `branch-off` therefore continues to
  use its base only as a start point.
- **Returned errors:** HTTP validation and response mapping were not changed, and the HTTP
  creation argv shape was moved intact behind the new function. The unchanged control suite
  continued to observe `BRANCH_ALREADY_EXISTS`, `INVALID_START_POINT`, and
  `PROJECT_ENVIRONMENT_MISMATCH` for the same requests. Its generic Git-failure mapping was not
  changed.
- **Control edge cases:** the unchanged suite also passed its dash-prefixed exact-ref,
  preparation failure/timeout, and persistence-compensation cases.

## Exact commands and measured results

Starting fixed point:

```text
git rev-parse HEAD
9e3b897898dfee955970bcf47825431f8eedfbdc
```

Behavior characterization before the edit:

```text
npx tsx --test tests/worktree-base-refs.test.ts
12 ok, 0 not ok, exit 0
```

TDD red:

```text
npx tsx --test tests/worktree-base-refs.test.ts
0 ok, 1 not ok, exit 1
Expected failure: Cannot find module '../src/lib/worktrees/create'
```

Final targeted checks:

```text
npx tsx --test tests/worktree-base-refs.test.ts
11 ok, 0 not ok, exit 0

npx tsx --test tests/control-worktree-creation.test.ts
4 ok, 0 not ok, exit 0

timeout 30s npx tsx --test tests/git-worktree-base-ref.test.ts
5 ok, 0 not ok, exit 0

timeout 10s npx tsx --test tests/preparation-claim-timing.test.ts
6 ok, 0 not ok, exit 124 after all 6 expected assertions passed
```

The Worktree base-ref count changed from 12 to 11 because the obsolete argument-array test was
removed as required; its real-repository creation assertion was expanded instead.

Static checks:

```text
npx tsc --noEmit
exit 0, no diagnostics

npm run lint
exit 0

git diff --check
exit 0, no diagnostics
```

The first lint run reported three unrelated existing warnings and zero errors
(`preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`); the final lint
run exited 0 without diagnostics.

Knowledge graph:

```text
graphify update .
exit 0; graph rebuilt with 9,785 nodes, 26,092 edges, and 414 communities
```

No full test suite, development server, browser, or Electron instance was run, per the ticket's
verification rules.

## Review invocation and findings

Fixed point and review range:

```text
git diff 9e3b897898dfee955970bcf47825431f8eedfbdc...HEAD
git log 9e3b897898dfee955970bcf47825431f8eedfbdc..HEAD --oneline
757eaf9 refactor(worktrees): consolidate creation (#274)
```

The requested `code-review` skill ran two read-only agents in parallel.

### Standards

No hard documented-standard violations found. The review specifically confirmed the explicit
`GitRunner`, authoritative agent environment, app-owned preparation, and product-owned Git
execution rules remain intact.

### Spec

No acceptance-criteria gaps, scope creep, or incorrect implementation found.

Summary: Standards 0 findings; Spec 0 findings. No post-review code changes were required.

## What could not be verified

- Native Windows Git execution was not exercised. The real-repository tests ran Git from this
  WSL worktree and therefore prove the server-side WSL process/filesystem boundary only.
- The HTTP route was not driven through a live server; its targeted contract test and the shared
  creation function were exercised directly. The ticket explicitly excluded a server/browser/
  Electron harness.
- An initial control-suite attempt reported `Cannot find module 'pino'`. Before the later
  orchestrator note said not to reinstall dependencies, `npm ci` had already been run and
  completed successfully without changing tracked files. The suite then passed 4/4, as did the
  orchestrator's independent invocation. The transient initial resolution failure was not
  reproduced or attributed to a persistent dependency problem, and no further dependency repair
  was attempted after that note.

## Commit

Implementation commit:

```text
757eaf955439880c33ff693d6ff4a155546bd81f
```

## Deliberately left out

- The `checkout-branch` source and all remaining #273 behavior.
- UI, localization, HTTP contract, or control CLI option changes.
- Worktree allocation changes, duplicate-checkout probing, local/remote branch selection, or new
  error codes.
- Any development-server, browser, Electron, visual, or full-suite verification.
- Pushes and pull-request creation.
