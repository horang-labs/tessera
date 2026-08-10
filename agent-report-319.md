# agent-report-319 — File tab: edit existing files and create new files (wave 1)

Branch: `feature/319-file-editing`. Five commits, not pushed, not merged.

- `6768e46` feat(workspace): edit and create files from the File tab
- `b541670` feat(workspace): put the create actions where the File Explorer actually is
- `a8962a6` fix(workspace): address the standards review
- `e9375b8` docs: add agent-report-319
- `2eb26a7` fix(workspace): address the spec review

## What was built

### Server

- **`GET /api/sessions/[id]/file` now returns `mtimeMs`**, and `WorkspaceFileData` gained the
  field (`src/types/workspace-file.ts`). This was the precondition for the optimistic lock.
- **`PUT /api/sessions/[id]/file`** — `{ path, content, baseMtimeMs? }` → `{ path, size, mtimeMs }`.
  409 `conflict` on a stale or vanished baseline, 413 `file_too_large` over 512 KB,
  400 `invalid_file_path`, 504 `filesystem_timeout`.
- **`POST /api/sessions/[id]/file`** — `{ path, content? }` written with the `wx` flag, so the
  existence check is atomic and `EEXIST` becomes 409 `already_exists`.
- **`src/lib/workspace-files/workspace-file-write.ts`** holds the write logic
  (`saveWorkspaceFile`, `createWorkspaceFile`, `resolveWorkspaceWriteTargetOnDisk`). The route
  is a thin adapter: auth, root resolution, error→HTTP mapping. This split is what makes the
  route's real behaviour testable against a temp dir without standing up auth and the DB.
- **`src/lib/workspace-files/workspace-file-write-target.ts`** — the write-side path resolver.
  `parseWorkspaceWritePath` is lexical (empty / NUL / absolute / directory-shaped / `../`
  escape); `resolveWorkspaceWriteTarget` checks containment on the **realpathed parent** and,
  when the file already exists, defers to `resolveWorkspaceReadTarget` so read and write agree
  on the symlink rule.
- **`src/lib/workspace-files/workspace-file-io.ts`** — `WorkspaceFileError`, `withFsDeadline`
  and the size ceilings moved here so both sides share one deadline and one limit. No new
  constant was introduced; `MAX_TEXT_FILE_BYTES` is reused.

### Client

- `WorkspaceFileTab` holds the draft (`useState<string | null>`), the `saving` flag and the
  conflict state. Editable only when `binary === false` **and** `truncated === false`; diff
  tabs never compute an editable buffer at all.
- Every silent-refresh path (watcher event, WS `replay_events`, window focus / visibility)
  refuses to replace a dirty buffer, and an external change while dirty raises the banner
  instead of reloading.
- Conflict banner: **Reload and discard / Overwrite / Cancel**. Overwrite re-issues the save
  with `baseMtimeMs` omitted; Cancel only hides the banner and keeps the draft.
- Save shortcut is bound to the code view's root element, not `window`.
- A dirty tab is pinned so a preview tab cannot be replaced out from under it.
- Self-write echo: the PUT response's `mtimeMs` becomes the new baseline (primary), backed by
  `workspace-self-write-registry.ts` — a single 3000 ms per-path stamp, marked before the
  request and cleared when the write fails.
- `WorkspaceNewFileDialog` takes a workspace-relative path, POSTs, and opens the created file
  via `openWorkspaceFileTab`. Wired into both file-listing surfaces (see Deviations).

## TSC / lint

```
$ npx tsc --noEmit
(no output, exit 0)

$ npm run lint
/…/src/hooks/use-virtual-message-list.ts
  365:23  warning  Compilation Skipped: Use of incompatible library
/…/src/lib/cli/spawn-cli-runtime.ts
  19:1  warning  Unused eslint-disable directive (no problems were reported from 'no-control-regex')

✖ 3 problems (0 errors, 3 warnings)
```

0 errors. All 3 warnings are in files this branch does not touch. The
`no-restricted-syntax` agent-environment gate passes: no `os.homedir()` and no
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_DATA_HOME` in any new file — the workspace root
comes from `resolveSessionWorkspaceFilesystemRoot(id)` throughout, and a contract test asserts
their absence.

## Targeted tests

Runner: `npx tsx --test <files>`. No full suite (per the repo's verification policy).

```
$ npx tsx --test tests/workspace-file-write-target.test.ts \
    tests/workspace-file-write.test.ts tests/workspace-self-write-registry.test.ts \
    tests/workspace-file-editing-contract.test.mjs tests/file-read-timeout-contract.test.mjs \
    tests/workspace-file-read-target.test.ts tests/memory-contract.test.mjs
# pass 74
# fail 2
```

New test files:

| File | Tests | Covers |
|---|---|---|
| `tests/workspace-file-write-target.test.ts` | 7 | Path parsing table (absolute, NUL, `../` escape, directory-shaped, Windows separators) and the parent-containment / symlink rules. |
| `tests/workspace-file-write.test.ts` | 14 | Real temp-dir workspaces: save, the 409 lock (and that the refused save leaves bytes alone), overwrite without a baseline, 413, `wx` create + duplicate 409, missing-parent 404, traversal refusal for both verbs, a linked **directory** refused, a linked **file** saved through to its target, a binary file refused (415), an oversize file refused (413), an empty file still editable. |
| `tests/workspace-self-write-registry.test.ts` | 3 | Stamp scoping, TTL expiry, clear-on-failure. |
| `tests/workspace-file-editing-contract.test.mjs` | 17 | Client and route invariants that have no DOM test rig here: the dirty guards, the self-write calls, `readOnly={!editable}`, the shortcut not being on `window`, the banner's three actions, both create surfaces, the banner keying off the mtime baseline rather than the watcher event, and the server's text-only gate. |

**The 2 failures are pre-existing and unrelated.** They are
`tests/file-read-timeout-contract.test.mjs` #6 and #7, which assert against
`src/lib/git/git-panel.ts` — a file this branch does not touch (`git diff HEAD -- …` is
empty). Verified against `dev` directly: `git show dev:src/lib/git/git-panel.ts` contains
neither `runOptionalCommand` nor the timeout pattern the test asserts, so both fail on `dev`
too.

Two tests in that same file **did** break from this work and were updated rather than
worked around, because the invariant survived and only its expression moved:

- #3 — the silent-refresh guard now also covers a dirty draft, so the asserted line changed
  from `activeLoadsRef.current > 0` to `(dirtyRef.current || activeLoadsRef.current > 0)`.
- #5 — `withFsDeadline` moved to `workspace-file-io.ts`; the test now asserts it there and
  that the route imports it.

## Real dev-server QA

Topology: **WSL-native throughout** — Next dev server via `server.ts` on Linux, headless
Chromium on Linux, workspace on the Linux filesystem. `TESSERA_DEV_PORT` was **not** set. The
server ran with a fully isolated `TESSERA_DATA_DIR=/home/work/tmp/qa319/data`, so neither the
user's app DB nor the shared `tessera-dev.db` was touched; `agentEnvironment` was set to `wsl`.
Fixture: a throwaway git repo at `/home/work/tmp/qa319/repo`, registered as a project with one
session.

This means the **bridged** (Windows server + WSL agent) topology was *not* exercised. The new
code contains no platform branch of its own — it derives the root from
`resolveSessionWorkspaceFilesystemRoot` and the path style from
`getFilesystemPathModule(root)`, exactly as the existing read route does — but a
Windows-hosted run would be a stronger check than the one performed.

Screenshots: `/home/work/tmp/qa319/shots/` (UNC:
`\\wsl.localhost\Ubuntu-24.04\home\work\tmp\qa319\shots\`).

### HTTP-level checks (real routes, through auth)

| Check | Result |
|---|---|
| `GET …/file?path=notes.txt` returns `mtimeMs` | ✅ `1786335237675.27` |
| `PUT` with the correct `baseMtimeMs` | ✅ bytes on disk, new `mtimeMs` returned |
| `PUT` with a stale `baseMtimeMs` | ✅ HTTP 409 `conflict`, file unchanged |
| `POST` at root and inside `docs/` | ✅ both created |
| `POST` on an existing name | ✅ HTTP 409 `already_exists`, existing file intact |
| `PUT ../escape.txt`, `/etc/passwd`, `docs/../../escape2.txt` | ✅ all HTTP 400, nothing written outside |
| `PUT` body of 512 KB + 1 | ✅ HTTP 413 |

### Browser checks

Pass 1 (`shots/02`–`12`) — 24/24:

- editable Monaco for a text file; Save affordance present; no dirty dot before typing (`03`)
- typing marks dirty and enables Save (`04`)
- `Ctrl+S` writes the buffer to disk, dirty dot clears, "Saved …" toast (`05`)
- saving does **not** raise the conflict banner from its own watcher echo (`05`)
- a dirty buffer is not replaced when the file is rewritten on disk
- Save is then refused and the banner appears; disk content untouched (`06`)
- **Cancel** hides the banner, keeps the draft dirty and intact (`07`)
- **Overwrite** writes the draft over the newer disk content (`08`)
- **Reload** takes the disk version and drops the draft (`09`)
- New file dialog → file created → opens in a tab (`10`, `11`)
- duplicate name shows "A file with this name already exists" (`12`)

Pass 2 (`shots/13`–`16`) — 7/7:

- the folder action pre-fills that row's directory (`"docs/"`) and the file lands there
- a **binary** file shows the binary empty state and offers no Save (`13`)
- an **oversize** file is headed `TEXT · 512.5 KB · TRUNCATED` and offers no Save (`14`)
- a **diff** tab renders and offers no Save (`16`)

Three "failures" in earlier runs were all harness artefacts, each confirmed and fixed before
the numbers above were taken: Monaco renders spaces as ` ` (broke substring asserts), the
header's `TRUNCATED` is CSS-uppercased (broke a case-sensitive match), and hidden tabs stay
mounted (so `count()` had to be `visible=true`). Synthetic keystrokes also drop the occasional
character (`TYPED` → `TYED`); the assertions compare the editor's own buffer against disk
rather than against the intended string.

## AC items I could not verify

1. **"With two split panels open, `Cmd+S` saves only the focused panel."** Not verified in the
   UI. `panel-split-trigger` is rendered only by the chat panel header, so a split cannot be
   created from a file tab, and the fallback (two file tabs in one panel) was blocked by the
   dev annotation overlay, which intercepts clicks on the file rows at the document level —
   CSS `display:none` does not stop it. What *is* evidenced: `Ctrl+S` saved exactly the
   focused tab (`left.txt`) and the toast named it (`shots/20`); the handler is bound to each
   `WorkspaceCodeView` root, never to `window`, and a contract test asserts the absence of a
   window listener. That is a strong argument, not a demonstration.
2. **"A dirty preview tab is pinned, so previewing another file does not replace it."** Same
   overlay blocked the second file from opening, so this was not shown end-to-end. The pin
   call is present and contract-tested, and reading `tab-store.openWorkspaceFilePreview`
   confirms a pinned tab is no longer a preview slot, so the next preview opens a new tab
   rather than clobbering the draft.

Both are worth re-checking by hand in the packaged app.

## Deviations from the ticket

1. **The create actions also live in `workspace-file-panel.tsx`, which the ticket did not
   name.** The ticket points at `workspace-explorer-tab.tsx:54` as the File Explorer. That
   component has **no UI entry point** — nothing in the app builds its
   `__workspace-explorer__|…` session id, so the tab it renders is currently unreachable. The
   File Explorer users actually see is the Git panel's Files tab
   (`workspace-file-panel.tsx`). I implemented the actions in the ticket's file *and* in the
   reachable one, because the acceptance criteria state they are testable from the UI, and in
   the named file alone they are not. Since that panel renders a real tree, "New file in this
   folder" sits on folder rows there, which fits better than the flat list's per-file dirname.
   Worth confirming with the ticket author, and it likely affects wave 2 (#320), whose tree
   operations are described against the same unreachable component.
2. **Creating a file inside a folder that does not exist returns 404 rather than creating the
   folder.** `mkdir -p` on create would be folder creation, which is wave 2. The message is
   "The folder for this file does not exist".
3. **`PUT` on a path that does not exist creates it when `baseMtimeMs` is omitted.** This
   mirrors the memory route exactly (`memory/file/route.ts:289-303`) and is what "Overwrite"
   needs after a file is deleted mid-edit. With a baseline supplied, a vanished file is a 409.
4. **`workspace-file-io.ts` is a new module the ticket did not list.** `WorkspaceFileError`,
   `withFsDeadline` and the ceilings were private to the read route; the write side needs the
   same three. Extracting beat duplicating, and it keeps "one deadline, one limit" true.

## Not done (out of scope)

Wave 2 (#320): delete, rename, create folder. The File Explorer's tree operations were left
alone. Also untouched, per the spec's Out of Scope: autosave, hot-exit, a Compare option on
the banner, OS Trash routing, drag-and-drop, and a global draft store.

## Skills actually run

- `/tdd` — ran for the write-side resolver and the self-write registry (genuine red→green
  cycles, one slice at a time). The route-level temp-dir tests started red on the first
  behaviour and the remaining nine cases were written against the implementation; they are
  verification, not test-first, and are labelled honestly here.
- `/code-review` — both sub-agents were spawned in parallel. Both eventually returned (Standards
  at ~35 min, Spec at ~80 min) and **both sets of findings were acted on**; between them they
  caught one regression I introduced, one missing server-side gate, and a defect that made a
  source file unreviewable.
- Full suite: not run, and not necessary — the change is localized to the workspace file
  surface, and targeted tests plus contract tests cover it.

## Sub-agent review — Standards axis (returned)

Two hard violations and ten judgement calls. Everything hard, plus the accessibility defect,
was fixed in `a8962a6`:

1. **The self-write registry's key separator was a literal NUL byte in the source.** `file(1)`
   reported the module as `data` and git classified it as binary (`Bin 0 -> 1412 bytes`) — no
   diff, no blame, nothing for a reviewer to read. This was a real defect I introduced and did
   not notice; the review caught it. Now written as an escape sequence, so the runtime key is
   byte-for-byte the same and the file is text again (verified: `JavaScript source, UTF-8`).
2. **`PUT`/`POST` parsed the request body before authenticating**, unlike the `GET` in the same
   file and every neighbouring route. I had copied the memory route's ordering. Auth now runs
   first in both.
3. **Nested interactive control** — the folder row's "New file in this folder" was a
   `role="button"` span inside the disclosure `<button>`: invalid HTML, unreachable to a
   screen reader. Now a sibling button. Re-verified in the browser afterwards: the folder still
   expands, the action still pre-fills `docs/`, and creating from it still works
   (`shots/21`, `shots/22`).
4. `GET` now shares `authenticateAndResolveRoot` instead of repeating it.

Judgement calls left as they are, with reasons:

- **Duplicated create entry point across the two file-listing components.** Real, and it
  follows directly from deviation 1 below. The shared parts (dialog, POST, error handling) are
  already one component; what is duplicated is a state field and a button. Collapsing it
  properly means deciding whether `workspace-explorer-tab.tsx` should exist at all, which is a
  call for the ticket author, and touches wave 2's surface.
- **Path validation appears in both the read route and `parseWorkspaceWritePath`.** The read
  path resolves an existing file and the write path resolves a parent that may not exist;
  merging them was exactly what D4 says cannot be done. Messages differ because the failures
  differ.
- **`dirtyRef.current = dirty` during render.** Copied verbatim from `memory-file-tab.tsx:164`,
  which the ticket names as the pattern to follow. Changing it here alone would leave the two
  file surfaces inconsistent.
- **Ten editing props on `WorkspaceCodeView`.** Bundling them into one object is a fair
  refactor but would churn the component's whole signature for no behaviour change.
- **`invalid_base` covers both "names a directory" and "empty after normalising".** Fair; the
  user-facing message is accurate for both, and the code is not part of the API contract.
- **Windows reserved names / alternate data streams / trailing dots** are not rejected
  lexically. Real gap on a Windows workspace, but out of this ticket's scope — the existing
  read route has the same blind spot, and the fix belongs with it.

## Sub-agent review — Spec axis (returned late; findings acted on)

The Spec sub-agent reported after roughly 80 minutes, past the point where this report was
first written. It raised four findings, **all of them real**, fixed in `2eb26a7`:

1. **The conflict banner fired on `hasMoreChangedPaths` — a regression I introduced.** That
   flag is set purely when the watcher's changed-path list overflows
   (`workspace-file-watch-manager.ts:832-836`); it says nothing about *this* file. Any large
   agent edit would raise "This file changed on disk" on a dirty tab whose file nobody had
   touched. Before this ticket the same condition only caused a harmless silent re-read, so
   adding the banner is exactly what made it user-visible. I copied the condition from the
   existing refresh path without re-reading what the flag means.
2. **D5's stated primary mechanism never reached the banner.** The spec is explicit — the
   adopted `mtimeMs` baseline "is the primary mechanism" — but the banner was raised from the
   watcher event alone, leaving the 3000 ms TTL (a declared *backstop*) doing the whole job.
   The same fix closes both: a watcher event is now only a hint that triggers a real mtime
   comparison against the loaded baseline, and only a genuine difference raises the banner.
3. **The server never enforced constraint 5** ("Only allow writes when the current server GET
   returned text"). The binary and truncated gates were client-side only, so a crafted `PUT`
   could replace a PNG with UTF-8, or write a truncated buffer back over a large file and
   silently drop everything past 512 KB. `saveWorkspaceFile` now samples an existing file the
   same way the read route does: 415 `binary_file`, 413 past the ceiling. Verified over HTTP —
   `PUT` text at `logo.png` → 415 with the PNG bytes intact; `PUT` at a 512 KB+ file → 413
   with the file still full size. Three new tests in `workspace-file-write.test.ts` cover it.
4. **The create dialog promised nested paths the server refuses.** The placeholder said
   `notes/todo.md`, which 404s unless `notes/` exists. Placeholder and label now state that
   the folder must already exist.

Not adopted: both reviewers suggest deleting the now-dead copy of the create actions in
`workspace-explorer-tab.tsx`. That is the file the ticket explicitly listed under "Files to
touch", so removing what it asked for is the orchestrator's call, not mine. It is recorded as
deviation 1 below.

The Spec axis also confirmed D1, D2, D3, D4, D6/D8, D7, D9, D10 and D15 as correctly
implemented, found no substantive scope creep, and independently flagged the NUL byte that
Standards caught. Two contract-level deltas against D14 it noted and I have left: the
`parent_not_found` 404 (deviation 2) and an extra `sessionId` field on the `PUT`/`POST`
responses, which matches what the memory route returns.

### Re-verification after these fixes

- Save-path banner, unchanged behaviour: external change → Save refused → banner → **Cancel**
  keeps the draft dirty → **Overwrite** writes it → a subsequent plain save raises no banner.
  6/6 (`shots/26`, `shots/27`).
- **An unrelated bulk change (80 files written at once) no longer raises the banner** on a
  dirty tab, and the draft survives it (`shots/23`).

One thing I could **not** show: that a watcher event on *this* file raises the banner before a
save is attempted. No `workspace_files_changed` message reached the browser at all in this
environment during the probe (hooked via `addInitScript`, so the hook itself was live), so the
watcher-driven half of the banner is unproven here either way — the false-positive result
above is therefore also weaker evidence than it looks. What the AC actually requires — "modify
the file on disk outside Tessera, then press Save → the save is refused and a banner appears"
— is verified, because that path runs off the server's 409.
