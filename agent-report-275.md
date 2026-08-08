# Agent report — issue 275

## What changed and why

- Extended `WorktreeCreationSource` with `checkout-branch` and kept both the app HTTP route and
  Control path on the shared `createGitWorktree` execution seam introduced by #274.
- A local selection runs `git worktree add` against the existing local branch. A remote-only
  selection creates the matching local branch with `--track` against the explicitly selected
  remote-tracking ref. The creation result records whether the invocation created the local
  branch so Control persistence compensation never deletes a pre-existing branch.
- Added checkout-specific managed-path allocation. It derives the directory from the existing
  branch name and ignores branch prefix, slug, and suffix inputs while still refusing an occupied
  path.
- Added `BRANCH_NOT_FOUND` and `BRANCH_ALREADY_CHECKED_OUT` responses, while preserving the
  existing `branch-off` contract and legacy flat `baseRef` HTTP input.
- Added `--mode branch-off|checkout-branch` to `tessera worktree create`; the default remains
  `branch-off`, so existing commands keep their positional start-point contract.
- Added real temporary-repository coverage for local, remote-only, missing, and already-held
  branches, plus an authenticated `/api/worktrees` request proving non-default naming inputs do
  not alter checkout mode. Assertions inspect HEAD, commit IDs, the
  `branch.<name>.remote`/`.merge` pair, `branch.<name>.base`, and filesystem state.

## Exact commands and measured results

Starting point:

```text
git rev-parse HEAD
ea87a96525b913c18eea09fad27bda042babb0cc
```

Baseline characterization before edits:

```text
timeout 60s npx tsx --test tests/worktree-base-refs.test.ts
11 ok, 0 not ok, exit 0

timeout 60s npx tsx --test tests/control-worktree-creation.test.ts
4 ok, 0 not ok, exit 0

timeout 60s npx tsx --test tests/control-cli-integration.test.ts
8 ok, 0 not ok, exit 0

timeout 60s npx tsx --test tests/git-create-pr-action.test.ts
12 ok, 0 not ok, exit 0
```

The first focused checkout run exposed an incomplete remote fixture rather than an implementation
assertion: Git refused `--track upstream/feature/remote` because no `remote.upstream.fetch` mapping
existed. After the fixture modeled a real configured remote, the focused file passed 2/2.

Final targeted checks before review:

```text
timeout 60s npx tsx --test tests/worktree-checkout-branch.test.ts tests/worktree-base-refs.test.ts tests/worktree-path-template.test.ts tests/git-worktree-base-ref.test.ts
24 ok, 0 not ok, exit 0

timeout 60s npx tsx --test tests/control-worktree-creation.test.ts tests/control-http-handler.test.ts tests/control-cli-integration.test.ts
15 ok, 0 not ok, exit 0

timeout 60s npx tsx --test tests/git-create-pr-action.test.ts
12 ok, 0 not ok, exit 0

timeout 60s npx tsx --test tests/tessera-control-skill.test.ts
5 ok, 0 not ok, exit 0
```

Post-review affected check after adding the requested API naming-input assertion:

```text
timeout 60s npx tsx --test tests/control-worktree-creation.test.ts
6 ok, 0 not ok, exit 0
```

Static checks:

```text
npx tsc --noEmit
exit 0, no diagnostics

npm run lint
exit 0, 0 errors, 3 pre-existing warnings
warnings: preview-markdown.tsx no-img-element; use-virtual-message-list.ts incompatible-library;
spawn-cli-runtime.ts unused eslint-disable

git diff --check
exit 0, no diagnostics
```

Knowledge graph:

```text
graphify update .
exit 0; 9,811 nodes, 26,150 edges, 404 communities
```

The full suite was deliberately not run, per the ticket instructions.

## Review invocation and findings

The requested `code-review` skill ran its two read-only agents in parallel. At invocation time:

```text
git diff ea87a96525b913c18eea09fad27bda042babb0cc...HEAD
git log ea87a96525b913c18eea09fad27bda042babb0cc..HEAD --oneline
f527e9f feat(worktrees): open existing branches (#275)
```

### Standards

One judgement-call finding, zero hard violations. The reviewer noted duplicated discriminant
parsing between the app route and Control HTTP boundary, plus similar source-resolution flow at
their callers. This was not applied: the shared repository-changing behavior remains in
`createGitWorktree`, while the two boundary parsers intentionally produce different transport
errors. Consolidating those boundary contracts is not an acceptance criterion and would broaden
the ticket.

### Spec

One partial-verification finding: no API-level real-repository test proved branch prefix, slug,
and collision-suffix inputs are inert in checkout mode. Applied by adding an authenticated
`POST /api/worktrees` test that supplies all three non-default inputs and verifies the actual
checked-out branch, commit, derived path, and preserved base config. The affected test, `tsc`,
lint, and graph update were rerun successfully.

Summary: Standards 1 judgement-call finding (worst: duplicated boundary parsing), 0 hard
violations; Spec 1 finding (worst: missing inert-input API assertion), fixed.

## What could not be verified

- Git subprocess behavior was verified with Node and Git both running in WSL against temporary
  WSL filesystem repositories. Native Windows Git and the packaged Windows-server-to-WSL topology
  were not exercised; no claim is made for those topologies beyond the unchanged environment-aware
  Git runner path.
- The app API was invoked directly as an authenticated `NextRequest`, and the Control CLI was
  driven through its loopback HTTP endpoint. No development server, browser, or Electron process
  was started, as this ticket is server-side only.
- Pull-request fallback was verified with the existing fake-`gh` real-repository test; no actual
  GitHub pull request was created.

## Commit

Final implementation commit after the accepted review fix:

```text
2aa36faad3431167d053af4f9c30295d0e8e5c40
```

## Deliberately left out

- UI source selection, inline form errors, responsive verification, screenshots, and locale
  strings (#276).
- Pre-Git lookup and holder-naming for a branch already checked out elsewhere (#277); Git's own
  refusal remains the race-safe behavior required here.
- Fetching a branch hidden by a narrowed fetch refspec, `checkout-pr`, branch management, switching
  the current Worktree in place, or moving an existing session.
- Any change to `branch-off`, preparation policy, Git delegation policy, or agent-environment
  routing beyond threading the new source through their existing seams.
- Pushes, pull-request creation, a development-server/browser/Electron harness, and the full test
  suite.
