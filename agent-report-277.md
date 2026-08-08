# Agent report — issue 277

## What changed and why

- `createGitWorktree` now asks Git for its NUL-delimited porcelain Worktree list before opening
  an existing local branch. If the branch is already held, it raises a structured
  `branch_already_checked_out` error containing the branch and holder Worktree path before any
  `git worktree add` invocation.
- The app HTTP route and Control creator preserve that message, code, branch, and
  `holderWorktreePath`. The existing client creation path already displays the HTTP `error`
  string, so the message reaches the current creation surface without changing the source picker
  owned by #276.
- Both callers retain their existing Git-stderr matching. This is the race backstop when a branch
  becomes held after the new lookup but before `git worktree add` runs.
- Focused real-repository tests now prove the preflight refusal, holder naming, absence of a new
  directory and Git Worktree record, caller propagation, and the lookup/invocation race.

## Exact commands and measured results

Starting point:

```text
git rev-parse HEAD
2ce5aa8d2690bba9e2b15272f668c69ebb2514fe
```

The first literal `gh issue view` call encountered GitHub's retired Projects Classic field, so
the issue reads were repeated with explicit supported fields:

```text
gh issue view 277 --repo horang-labs/tessera --json number,title,body,labels,state,url
gh issue view 273 --repo horang-labs/tessera --json body,comments --jq '.body, (.comments[]?.body // empty)'
gh issue view 275 --repo horang-labs/tessera --json body,comments --jq '.body, (.comments[]?.body // empty)'
all three issue bodies read successfully
```

Baseline and red/green characterization:

```text
timeout 60s npx tsx --test tests/worktree-checkout-branch.test.ts
before edits: 2 ok, 0 not ok, exit 0; Git supplied only its generic duplicate refusal

timeout 60s npx tsx --test tests/worktree-checkout-branch.test.ts
red: 2 ok, 1 not ok, exit 1; expected structured holder error but Git worktree add ran
green shared seam: 3 ok, 0 not ok, exit 0

timeout 60s npx tsx --test tests/control-worktree-creation.test.ts
red callers: 4 ok, 2 not ok, exit 1; HTTP and Control flattened the holder message
green callers: 6 ok, 0 not ok, exit 0
```

Final targeted caller checks (the `ok` lines were counted directly):

```text
timeout 60s npx tsx --test tests/worktree-checkout-branch.test.ts tests/worktree-base-refs.test.ts tests/worktree-path-template.test.ts tests/git-worktree-base-ref.test.ts
26 ok, 0 not ok, exit 0

timeout 60s npx tsx --test tests/control-worktree-creation.test.ts tests/control-http-handler.test.ts tests/control-cli-integration.test.ts
16 ok, 0 not ok, exit 0
```

Static and repository checks:

```text
npx tsc --noEmit
exit 0, no diagnostics

npm run lint
exit 0, 0 errors, 3 pre-existing warnings outside the diff

git diff --check
exit 0, no diagnostics

graphify update .
exit 0; 9,822 nodes, 26,161 edges, 395 communities
```

Per the ticket instructions, the full suite was deliberately not run.

## Review invocation and findings

The requested `code-review` skill ran two read-only review agents in parallel. The fixed point
resolved, the diff was non-empty, and the session commit list contained only the implementation:

```text
git diff 2ce5aa8d2690bba9e2b15272f668c69ebb2514fe...HEAD
git log 2ce5aa8d2690bba9e2b15272f668c69ebb2514fe..HEAD --oneline
24d5202 fix(worktrees): name existing branch holder (#277)
```

### Standards

No hard violations of documented repository standards found. The change uses the single Git
runner required by `docs/design/git-delivery.md` §10, preserves product-owned Git execution from
ADR 0005, and follows `CONTRIBUTING.md`'s local-pattern and cross-platform guidance. `npx tsc
--noEmit` and lint both pass; lint reports only three pre-existing warnings outside the diff.

### Spec

No in-scope findings. All acceptance criteria are implemented, including preflight holder
detection, branch-and-Worktree naming, unchanged repository state after refusal, stderr race
fallback, propagation through the existing creation error path, and real temporary-repository
coverage. Focused tests, `tsc`, and lint pass.

Summary: Standards 0 findings; Spec 0 findings. No review fixes were required.

## What could not be verified

- Node and Git ran in WSL against temporary WSL-filesystem repositories. Native Windows Git and
  the packaged Windows-server/WSL-agent topology were not exercised; the environment-aware Git
  runner path itself was unchanged.
- The app API was invoked directly as an authenticated `NextRequest`, and the existing
  `useWorktreeSession` error propagation was inspected. No browser or #276 source-picker UI was
  available on this branch, so no visual creation-form run is claimed.
- The race was injected deterministically at the shared Git seam. The HTTP and Control
  stderr-matching blocks were inspected and left in place, while their normal caller paths were
  exercised by the targeted tests; the race was not separately injected through each transport.
- No development server, browser, Electron process, external Git remote, push, or pull request was
  started. This ticket is server-side and did not require those harnesses.

## Commit

Implementation reviewed in this session:

```text
24d52025559c85d82afcb46aac97e434ae7eb5df
```

## Deliberately left out

- The source picker, form redesign, locale strings, screenshots, and responsive/UI work owned by
  #276.
- Navigation or automatic switching to the holder Worktree; #273 explicitly leaves that out.
- Any change to `branch-off`, remote-only checkout behavior, Worktree preparation, branch naming,
  Git execution/delegation policy, or agent-environment routing.
- Replacing Git's stderr fallback, broad refactors, dependency changes, pushes, and PR creation.
