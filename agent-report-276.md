# Agent report — GitHub issue #276

## What changed and why

- Added a visible Worktree source selector to the shared creation control used by both the empty
  panel and collection quick-create sheet. Users can keep the existing `branch-off` behavior or
  choose `checkout-branch` to open a branch that already exists.
- Kept ref selection shared between the modes. The second control says **Start from** for a new
  branch and **Branch to open** for checkout mode, while preserving separate Local and Remote
  option groups.
- Extended `useWorktreeBaseRefs` to own source-mode state and derive the tagged
  `WorktreeCreationSource`. Checkout mode submits the exact selected ref; branch-off preserves
  the existing current-ref-to-`null` behavior.
- Changed `useWorktreeSession` and both callers to send the server's existing tagged `source`
  contract. Prefix, slug, and collision-suffix inputs are omitted in checkout mode.
- Hid and bypassed slug validation in checkout mode without clearing its state, so switching back
  restores the entered slug and the existing automatic collision-suffix behavior.
- Kept the existing suppressed-toast/inline-error path on both forms, so server checkout refusals
  appear in the form. Holder naming remains the responsibility of #277.
- Added the new copy to English, Korean, Japanese, and Chinese and extended focused contract tests
  for request wiring, both surfaces, shared layout, and locale completeness.

## Exact commands and measured results

Starting point and issue/design reading:

```text
git rev-parse HEAD
2ce5aa8d2690bba9e2b15272f668c69ebb2514fe

gh issue view 276 --repo horang-labs/tessera
gh issue view 273 --repo horang-labs/tessera
gh issue view 275 --repo horang-labs/tessera
sed -n '1,260p' docs/design/git-delivery.md
```

Baseline characterization before edits:

```text
timeout 35s node --import tsx --test tests/worktree-base-refs.test.ts
11 ok, 0 not ok, exit 0
```

Final targeted checks (the changed client contracts and the existing server/control callers):

```text
timeout 45s node --import tsx --test tests/worktree-base-refs.test.ts tests/worktree-checkout-branch.test.ts tests/control-worktree-creation.test.ts
21 ok, 0 not ok, exit 0

npx tsc --noEmit
exit 0, no diagnostics

npm run lint
exit 0, 0 errors, 3 pre-existing warnings
warnings: preview-markdown.tsx no-img-element; use-virtual-message-list.ts incompatible-library;
spawn-cli-runtime.ts unused eslint-disable

git diff --check
exit 0, no diagnostics
```

Per the ticket instructions, the full suite was not run.

Knowledge graph refresh:

```text
graphify update .
exit 0; 9,824 nodes, 26,172 edges, 357 communities
```

## Running-app verification

Before starting the server, the required environment check was run:

```text
env | grep -i tessera
```

The inherited environment contained Tessera session/control variables, but no inherited app-root,
data-directory, database, or dev-port variable. The server was started on loopback port `34276`
with the unique data directory `/home/work/tmp/tessera-276-VXW5i2/data` and a temporary Git fixture
at `/home/work/tmp/tessera-276-VXW5i2/project`. The fixture had:

- local branch `feature/local-276`;
- remote-only ref `origin/feature/remote-276`;
- current branch `main`.

The required persistent headful session ran only on the isolated display:

```text
DISPLAY=:99 playwright-cli -s=issue276 open about:blank --persistent --headed
DISPLAY=:99 playwright-cli -s=issue276 resize 1440 950
DISPLAY=:99 playwright-cli -s=issue276 resize 360 776
DISPLAY=:99 playwright-cli -s=issue276 close
```

The server was confirmed rather than inferred:

```text
ss -ltnp 'sport = :34276'
LISTEN 127.0.0.1:34276, node pid 2991012

curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:34276/chat
HTTP 307
```

The browser created both requested Worktrees through the UI. The Git panel reported:

```text
local selection:  Worktree feature/local-276; Branch feature/local-276
remote selection: Worktree feature/remote-276; Branch feature/remote-276
```

The fixture repository independently reported:

```text
git worktree list --porcelain
branch refs/heads/feature/local-276
branch refs/heads/feature/remote-276

git -C /home/work/.tessera/worktrees/project/feature/remote-276 symbolic-ref --short HEAD
feature/remote-276

git -C /home/work/.tessera/worktrees/project/feature/remote-276 config --get branch.feature/remote-276.remote
origin

git -C /home/work/.tessera/worktrees/project/feature/remote-276 config --get branch.feature/remote-276.merge
refs/heads/feature/remote-276
```

Mode switching was measured in the empty-panel form: a typed slug `preserved-276` disappeared in
checkout mode (`count = 0`) and returned with the same value after switching to branch-off. Trying
to open the already-created local branch returned the server refusal inline in the form:
`The managed Worktree path already exists: .../feature/local-276`.

At `360x776`, the empty-panel source and ref controls were each 238 px wide; the quick-create
controls were each 296 px wide. In both states, `documentElement.scrollWidth` and `clientWidth`
were exactly 360 px, so there was no horizontal overflow. These measurements supplement rather
than replace the visual inspection below.

The Playwright browser was closed, the exact dev-server session was interrupted, port `34276` was
confirmed stopped, and only the two temporary Worktrees created by this verification were removed.
The orchestrator-owned Xvfb process on `:99` was left running.

## Screenshots captured and inspected

All seven captures were opened at original resolution and visually inspected. The desktop captures
are `1440x950`; the phone captures are `360x776`.

- [`artifacts/issue-276/desktop-local-selection.png`](artifacts/issue-276/desktop-local-selection.png)
  — empty-panel checkout mode with `feature/local-276`, dynamic **Branch to open** label, no slug
  field, and an unobstructed Create Worktree button.
- [`artifacts/issue-276/local-git-panel.png`](artifacts/issue-276/local-git-panel.png) — the running
  local session and Git panel both show the exact `feature/local-276` branch.
- [`artifacts/issue-276/desktop-remote-selection.png`](artifacts/issue-276/desktop-remote-selection.png)
  — empty-panel checkout mode visibly selects the remote-only `origin/feature/remote-276` ref.
- [`artifacts/issue-276/remote-git-panel.png`](artifacts/issue-276/remote-git-panel.png) — the
  resulting running session and Git panel show the matching local `feature/remote-276` branch.
- [`artifacts/issue-276/desktop-inline-refusal.png`](artifacts/issue-276/desktop-inline-refusal.png)
  — the already-held branch/path refusal is visible inline below the form rather than only in a
  toast.
- [`artifacts/issue-276/phone-source-selection.png`](artifacts/issue-276/phone-source-selection.png)
  — the empty-panel source/ref controls stack cleanly at phone width; the long refusal wraps inside
  the form. The dev overlay is visible at bottom-right but does not cover either control.
- [`artifacts/issue-276/phone-quick-create-source.png`](artifacts/issue-276/phone-quick-create-source.png)
  — the collection quick-create sheet shows both full-width selectors, the remote ref, and its
  action row without clipping or horizontal overflow. The dev overlay does not cover the form.

## Review invocation and findings

The requested `code-review` skill ran its two read-only agents in parallel over the sole
implementation commit made at invocation time:

```text
git diff 2ce5aa8...e79bebf
git log 2ce5aa8..e79bebf --oneline
e79bebf feat: add checkout branch creation mode
```

### Standards

Zero hard documented-standard violations. The reviewer reported one non-actionable Fowler smell:
the two creation surfaces repeat similar checkout-required and branch-slug normalization logic.
This was not applied because it is explicitly a judgement call, the surfaces already share the
source/ref state and control, and extracting form-specific validation was neither an acceptance
criterion nor a hard repository-standard requirement.

### Spec

One acceptance finding: the implementation commit itself did not contain running-app/E2E evidence
for the local and remote-only Git-panel criterion. The requested verification was performed before
review and is made durable by this report and the seven inspected screenshots above. The reviewer
found no implementation errors or scope creep in the remaining criteria. No code change was
required, so there was no affected code check to rerun after review; `git diff --check` remained
clean for the documentation/artifact addition.

Summary: Standards 0 hard findings and 1 non-actionable judgement call; Spec 1 evidence gap,
resolved by the runtime measurements and captures recorded here.

## What could not be verified

- The four locale objects were type-checked and contract-tested, but the Korean, Japanese, and
  Chinese translations were not each opened in the browser.
- Verification used the development web app on WSL, which is sufficient for this UI-only ticket.
  It did not exercise a packaged Windows Electron build or native Windows Git; server checkout
  behavior was already delivered by #275 and was not changed here.
- No actual missing-branch race was induced between ref selection and submission. The real
  already-held/path refusal and the shared non-OK response path prove that a server refusal is
  surfaced inline; existing #275 tests cover the distinct missing/held server responses.
- The existing alert heading renders the literal key `errors.title` in the captured refusal. That
  behavior predates this diff; the server's refusal message itself is fully visible inline.

## Commit

Implementation commit reviewed by the two-axis skill:

```text
e79bebfd05fa0815a447c13eb4079e76ab5c7f60
```

The later handoff commit contains only this report and its screenshot evidence, so its own hash
cannot be embedded in its contents. Obtain the branch tip with `git rev-parse HEAD`.

## Deliberately left out

- Holder naming for the already-checked-out refusal (#277).
- Any server checkout implementation, branch-management UI, fetch behavior, PR checkout, moving an
  existing session, or switching the current Worktree in place.
- Changes to branch-off naming, slug collision policy, path allocation, preparation, Git delegation,
  or agent-environment routing.
- Refactoring the two surface-specific submission handlers solely to remove the reviewer's
  non-actionable duplication smell.
- A new large E2E harness, the full test suite, dependency installation, pushing, and PR creation.
