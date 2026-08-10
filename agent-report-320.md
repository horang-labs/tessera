# agent-report-320 — File explorer: delete + rename + create folder (wave 2)

Branch: `feature/320-file-explorer`. Not pushed, not merged, no PR.

- `9f8111f` feat(workspace): delete, rename and create folders on the server
- `9fd3d90` feat(workspace): rename, delete and create folders from the Files panel
- `2e6c44d` fix(workspace): write the dirty-registry separator as an escape
- `f03f0e7` docs: add agent-report-320
- `e46dc16` fix(workspace): address the two-axis review

## The `workspace-explorer-tab.tsx` question — deleted

**Deleted, and everything went onto `workspace-file-panel.tsx`.**

The ticket names `workspace-explorer-tab.tsx:54` as the File Explorer to touch. It is not
one. `buildWorkspaceExplorerSessionId` — the only thing that can produce the
`__workspace-explorer__|…` session id that component renders under — has had **no caller
since the initial public release** (`git log -S "buildWorkspaceExplorerSessionId(" --all`
returns exactly the commit that defined it). So the tab could not be opened, and every
acceptance criterion here is phrased as "testable from the UI in a dev server".

Keeping it would have meant duplicating a confirmation dialog, a rename dialog, a
folder-create dialog and four row actions into a surface nobody can reach, and keeping the
two in step forever. Wave 1 already paid a smaller version of that tax and both its
reviewers asked for the deletion; wave 1 declined only because the call belonged to the
ticket author. Making it is what this wave was asked to do.

Removed with it, because they were dead the moment the component was:

- `panel-container.tsx` — the import and the explorer render branch.
- `special-session.ts` — `WORKSPACE_EXPLORER_SESSION_PREFIX`,
  `WorkspaceExplorerSessionRef`, `buildWorkspaceExplorerSessionId`,
  `parseWorkspaceExplorerSessionId`, and the explorer arms of
  `parseWorkspaceSpecialSessionId` / `getWorkspaceSpecialSessionTitle`.

A contract test asserts the file stays gone and that `panel-container.tsx` names neither
symbol, so it cannot quietly come back.

## What was built

### Server

- **`scanWorkspaceDirectory` / `walkWorkspaceFiles` now return `directories: string[]`.**
  Directories are collected in their own right, not inferred from file paths — an empty
  folder appears in no file path, so without this "create folder" has nothing to show.
  Collected even when the walk does not descend, so a non-recursive rescan still sees the
  folders at its level. `applyMaxFiles` takes an optional directory set and caps it the
  same way.
- **`workspaceFileWatchManager` keeps a `directories` set per entry** and diffs it in
  `bootstrapEntry`, `rescanDirectory` and `refreshPollIndex`. Creating or removing an empty
  folder moves no file path, so without the directory diff it would raise no change at all
  and the explorer would never hear about it. Directory names deliberately stay **out** of
  `addedPaths` / `deletedPaths`: the file tab reads a lone delete+add pair there as a rename
  of *its* file, so a folder in those lists would be misread. A directory change is a tree
  change and nothing more.
- **`GET /api/sessions/[id]/files` returns `directories`**, on every early return too, so
  the client reads one shape whatever the reason.
- **`src/lib/workspace-files/workspace-file-mutations.ts`** — the tree operations:
  - `deleteWorkspaceEntry` — `lstat` (so a symlink is deleted as the link it is, never
    followed), optimistic lock, then `fs.rm(recursive)` for a folder the caller confirmed,
    `fs.rmdir` otherwise → `409 directory_not_empty`, `fs.unlink` for a file.
  - `renameWorkspaceEntry` — takes a bare name via `parseWorkspaceEntryName`, which rejects
    both separators, both dot segments, NUL and empty. Explicit exists-check before
    `fs.rename`, because `fs.rename` is *defined* to replace its target silently. The check
    compares entries by inode, not by resolved path, so a case-only rename on a
    case-insensitive filesystem (macOS, Windows) is not refused as a collision with itself
    while two links to one target stay two entries (see the Spec review below).
  - `createWorkspaceDirectory` — plain `mkdir`, not `mkdir -p`: `EEXIST` is the 409 the
    duplicate refusal is built on, atomically, and a typo mid-path is a 404 rather than a
    surprise tree of empty folders.
  - All three resolve through wave 1's `resolveWorkspaceWriteTargetOnDisk`, so the
    client-supplied path is never trusted and the symlink rule is the one reads and saves
    already agree on. Every fs call is inside `withFsDeadline`.
- **`DELETE` and `PATCH` on `/api/sessions/[id]/file`**, and **`POST /api/sessions/[id]/directory`**.
  All authenticate before parsing a body — the ordering wave 1's standards review corrected —
  and map `WorkspaceFileError` to HTTP the same way `GET`/`PUT`/`POST` do.

### Client

- `use-workspace-file-list` surfaces `directories`; `workspace-file-panel` seeds its tree
  from that list before walking the files, so an empty folder gets a row.
- Row actions: a file row carries Rename and Delete beside Copy-path; a folder row carries
  New file, New folder, Rename and Delete. The header carries New file and New folder.
- `WorkspaceEntryNameDialog` is the shared shell behind New folder and Rename — one name
  field, one inline error, submit disabled while the request is out. Only the request
  differs, so only that is passed in.
- `WorkspaceDeleteDialog` always confirms and names what is lost: the folder's contents,
  that it is permanent and does not go to the Trash, and — for a dirty file — that the
  unsaved edits are discarded with it.
- `workspace-dirty-registry.ts` makes that last line possible: the draft lives in the file
  tab's own state, where the explorer cannot see it, and the explorer is where the delete is
  confirmed.
- `workspace-tab-sync.ts` closes tabs a delete removed and re-points tabs a rename moved,
  matching on the path **and its subtree** so a folder operation reaches the tabs inside it.

## TSC / lint

```
$ npx tsc --noEmit
(no output, exit 0)

$ npx eslint .
/…/src/hooks/use-virtual-message-list.ts
  365:23  warning  Compilation Skipped: Use of incompatible library
/…/src/lib/cli/spawn-cli-runtime.ts
  19:1  warning  Unused eslint-disable directive (no problems were reported from 'no-control-regex')

✖ 3 problems (0 errors, 3 warnings)
```

0 errors. All 3 warnings are in files this branch does not touch. The agent-environment
gate passes: no new file reads `os.homedir()`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or
`XDG_DATA_HOME`, and a contract test asserts their absence across the four new server-side
modules.

## Targeted tests

Runner: `npx tsx --test <files>`. No full suite, per the repo's verification policy.

```
$ npx tsx --test tests/workspace-file-mutations.test.ts \
    tests/workspace-tree-operations-contract.test.mjs tests/workspace-file-scan.test.ts \
    tests/workspace-file-watch-manager.test.ts tests/workspace-file-write.test.ts \
    tests/workspace-file-write-target.test.ts tests/workspace-file-editing-contract.test.mjs \
    tests/file-read-timeout-contract.test.mjs tests/workspace-self-write-registry.test.ts
# tests 102
# pass 100
# fail 2
```

| File | Tests | Covers |
|---|---|---|
| `tests/workspace-file-mutations.test.ts` (new) | 21 | Real temp-dir workspaces: file delete, recursive folder delete, the non-empty refusal, 404, the stale-baseline 409, traversal refusal; the rename name table, same-directory rename, the duplicate 409 for files *and* folders (with both entries verified intact), the separator refusal, rename-onto-itself; folder create, the duplicate 409 against a folder and against a file, `parent_not_found`, traversal refusal; two links to one target and two hard links each
staying two entries; and the subtree-prefix rule behind the tab sync. |
| `tests/workspace-tree-operations-contract.test.mjs` (new) | 13 | Client and route invariants with no DOM rig here: both row kinds carry Rename and Delete, folders can be created at the root and per row, the confirmation copy, the dirty registry reaching both the delete and the rename confirmation, `recursive` sent only for a folder, tabs following a rename and closing on a delete, auth-before-body on both routes, every fs call under `withFsDeadline`, the absence of agent-environment escape hatches, the uniform `directories` shape, and that the deleted explorer stays deleted. |
| `tests/workspace-file-scan.test.ts` | +2 | Directories reported including an empty one, with ignored dirs still pruned; and files and directories sharing one cap. |
| `tests/workspace-file-watch-manager.test.ts` | +1 | An empty folder reaches the index, and creating **and** removing one notifies subscribers. |

**The 2 failures are pre-existing and unrelated** — `file-read-timeout-contract.test.mjs`
#6 and #7, asserting against `src/lib/git/git-panel.ts`, which this branch does not touch.
`agent-report-319.md` records them failing on `dev` too.

Two assertions in that same file and in `workspace-file-editing-contract.test.mjs` read
`workspace-explorer-tab.tsx`, which no longer exists. The invariants they carried survive
on the reachable panel, so they were re-pointed there rather than deleted.

## Real dev-server QA

Topology: **WSL-native throughout** — `server.ts` on Linux (port 3187), headless Chromium
on Linux under `Xvfb :99`, workspace on the Linux filesystem. `TESSERA_DEV_PORT` was **not**
set. Fully isolated `TESSERA_DATA_DIR=/home/work/tmp/qa320/data`, so neither the user's app
DB nor the shared `tessera-dev.db` was touched; `agentEnvironment` set to `wsl`. Fixture: a
throwaway git repo at `/home/work/tmp/qa320/repo` with a file, a folder with a file in it,
and an **empty** folder.

Screenshots: `/home/work/tmp/qa320/shots/` (UNC:
`\\wsl.localhost\Ubuntu-24.04\home\work\tmp\qa320\shots\`).

### HTTP-level checks (real routes, through auth)

| Check | Result |
|---|---|
| `GET …/files` reports the empty folder | ✅ `directories: ["docs","docs/nested","keepme"]` |
| `POST …/directory` at the root | ✅ created |
| `POST …/directory` on an existing name | ✅ 409 `already_exists` |
| `POST …/directory` with `../…`, `/tmp/…`, `docs/../../…` | ✅ all 400, nothing created outside |
| `POST …/directory` into a folder that does not exist | ✅ 404 `parent_not_found` |
| `PATCH` renames a file, and a folder with contents | ✅ contents intact under the new name |
| `PATCH` onto a taken name (file and folder) | ✅ 409, **both** entries byte-intact |
| `PATCH` with a separator in the name | ✅ 400 `invalid_file_name` |
| `DELETE` a file | ✅ gone |
| `DELETE` a non-empty folder without `recursive` | ✅ 409 `directory_not_empty` |
| `DELETE` a non-empty folder with `recursive=1` | ✅ folder and contents gone |
| `DELETE` a path that escapes the root | ✅ 400, the target file survived |
| `DELETE` with a stale `baseMtimeMs` | ✅ 409, file survived |

### Browser checks

| AC | Evidence |
|---|---|
| Folders listed alongside files, including an empty one, visually distinct | `shots/01` — `keepme` (no files in it) renders as a folder row with a disclosure and folder icon |
| A file row offers **Delete**; confirmation names the file | `shots/12` — "Delete taken.md?" |
| Confirming removes it from disk and from the list, no manual refresh | `shots/14` — gone from disk and from the tree |
| Cancelling leaves the file untouched | file still on disk, row still present |
| Folder **Delete** states the contents go too, and they do | `shots/15` — "Everything inside this folder is deleted too", `documents/` and its file gone |
| Deleting a file open in a tab closes that tab | `shots/14` — the `journal.txt` tab closed |
| A file row offers **Rename**; the tree reflects it without a refresh | `shots/05`, `shots/07` |
| Renaming a file open in a tab re-points the tab | `shots/07` — the tab title went `notes.txt` → `journal.txt` and kept its content |
| Renaming onto an existing name is refused, neither file modified | `shots/10` — "Something with this name already exists here"; both files byte-intact |
| A rename containing a path separator is rejected | `shots/06` — "A name cannot contain a folder separator" |
| A folder renames the same way, same duplicate refusal | `shots/11`; the HTTP table above covers the folder duplicate |
| **New folder** at the root; the empty folder appears | `shots/02` → `reports` |
| Per-row **New folder here** creates it inside that row | `docs/drafts`, with the parent auto-expanded |
| Creating a folder whose name exists is refused visibly | `shots/03` |
| Escaping paths rejected for delete, rename, folder-create | HTTP table above |
| A folder created/renamed/deleted outside Tessera shows up without a refresh | `shots/16` — `mkdir` → row appeared; `mv` → row renamed; `rmdir` → row vanished, each within one poll |

Also shown, beyond the AC list: renaming a **folder** re-points a tab open on a file
**inside** it (`shots/17` — header reads `nest-renamed/inner.md`, content intact), and the
dirty warning appears in the confirmation for a file with unsaved edits (`shots/13`).

One harness note, so the log is not misread: an early run of the duplicate-rename check
reported a timeout rather than a 409. The dev server had been started with a plain `&` and
was killed when its parent shell exited (`Forced shutdown after timeout` in
`server.log`). Restarted detached, the same request returns 409 over both HTTP and the UI —
that is what `shots/10` shows.

## Bridged topology

Not exercised. The new code contains **no platform or path-style branch of its own**: the
root comes from `resolveSessionWorkspaceFilesystemRoot(sessionId)`, the path style from
`getFilesystemPathModule(root)`, and containment from wave 1's resolver — exactly as the
existing read and write routes do. Nothing here reads `process.platform`, `os.homedir()`, or
any CLI-home environment variable, and a contract test asserts the last part. Left to the
integration QA, as wave 1 left it.

## Deviations from the ticket

1. **`workspace-explorer-tab.tsx` was deleted rather than extended.** Reasoned above; it was
   the open question this wave was handed.
2. **The surviving surface is a tree, not a flat list.** The ticket says "the explorer stays
   a flat list with directory rows added" — that describes `workspace-explorer-tab.tsx`,
   which was a flat list. `workspace-file-panel.tsx` has rendered a nested tree since before
   either wave. The instruction's intent — *do not build a tree view* — is respected: no
   tree was built, and the ticket's non-goals (drag-move, multi-select, undo) stay out. What
   changed is that directories now come from the server rather than being inferred, so empty
   ones have a row. Flattening the existing panel would have been a regression nobody asked
   for.
3. **Wave 1 code was modified in three places**, each recorded here as required:
   - `workspace-file-tab.tsx` gains one effect that registers the dirty path, because the
     ticket requires the delete confirmation to warn about unsaved edits and the draft is
     otherwise invisible outside the tab.
   - `workspace-file-editing-contract.test.mjs` and `file-read-timeout-contract.test.mjs`
     no longer read the deleted component; their invariants were re-pointed at the panel.
   - `use-workspace-file-list.ts` gained the `directories` field, which the ticket asks for.
4. **`recursive` is a policy, not a user choice.** The client always sends it for a folder,
   because the confirmation has already said the contents go. The server still refuses a
   non-empty folder without it, so a caller that skips the dialog cannot delete a tree by
   accident.
5. **`parent_not_found` still reads "The folder for this file does not exist"** on the
   folder-create route — wave 1's message, reused. The UI cannot produce that case (the
   dialog only ever takes a name relative to an existing folder), so the wording was left
   rather than fork wave 1's resolver for a string.

## AC items I could not verify

None from this ticket's list — every acceptance criterion above has UI or HTTP evidence.

Two carried over from wave 1 (split-panel `Cmd+S`, dirty-preview pin) were **not**
re-verified. This wave does not touch that code path, per the brief.

One behaviour is argued rather than demonstrated: **a case-only rename** (`README.md` →
`readme.md`) on a case-insensitive filesystem. The resolved-entry comparison that permits it
is unit-tested through its same-name case, which runs the identical branch, but Linux cannot
reproduce the case-insensitive collision itself. Worth a look on macOS or Windows.

## Skills actually run

- `/tdd` — ran for the scan's directory collection, the watch-manager's directory diff, and
  every function in `workspace-file-mutations.ts` (genuine red→green cycles, one slice at a
  time; the RED run is recorded for each). The HTTP route adapters and the React components
  were **not** test-driven — there is no auth/DB harness for the former and no DOM rig for
  the latter, so both are covered by contract tests written after the fact, which is
  verification rather than test-first and is labelled as such.
- `/run` — the dev-server QA above.
- `/code-review` — both sub-agents spawned in parallel; findings below.
- Full suite: not run, and not necessary — the change is localized to the workspace file
  surface, and the targeted plus contract tests cover it.

## Sub-agent review

Both axes were spawned in parallel and both returned. Neither sent its report as a plain
final message — each surfaced only as an idle notification — so both had to be asked again
for the text; worth knowing for the next wave.

Everything acted on is in `e46dc16`.

### Spec axis — four findings, two of them real defects

1. **`namesTheSameEntry` treated two distinct symlinks as one entry.** Real, and the worst
   thing found. Identity was decided by comparing `fs.realpath` results, and two links
   pointing at the same file resolve alike — so renaming link `a` onto link `b` skipped the
   duplicate refusal and `fs.rename` destroyed `b`. Against the AC directly: *"Renaming onto
   a name that already exists is refused with a visible error, and neither file is
   modified."* Identity is now decided by **inode** (`lstat` `dev`+`ino`), with a
   case-insensitive name check so two hard links stay two entries. Two new tests cover the
   symlink pair and the hard-link pair; the case-only rename this comparison exists for
   still passes.
2. **The directory cap truncated file enumeration.** Real. `if (dirs.length >= limit)`
   aborted `recurse` mid-directory, dropping the files in that directory the walk had not
   reached yet, and files and directories each carried their own `MAX_WORKSPACE_FILES`
   budget, so the index could reach twice the intended size. They now spend one shared
   budget, and `applyMaxFiles` judges `truncated` on the two together. New test.
3. **Rename discarded an unsaved draft silently.** Real, and I had missed the asymmetry:
   delete warns, rename did not — but `repointWorkspaceFileTabs` swaps the panel's session
   id and `panel-container.tsx` keys the tab on it, so the tab remounts and the draft goes
   with the old path. The rename dialog now carries the same warning, off the same registry.
4. **`findRenameTarget` was not confirmed, as the ticket asked** (*"confirm it covers the
   rename this ticket issues, and extend it only if it does not"*). Fair — I read it and
   judged it insufficient without writing that down. It is: it fires only when the watcher
   batches exactly one delete and one add in the same directory, which a debounce boundary
   or any concurrent write breaks, and it only runs for a tab that is mounted and
   subscribed. Hence the explicit re-point. The two do not fight: whichever lands first
   moves the tab, and the other then finds nothing matching its old path. Left as is, now
   recorded.

Not adopted, with reasons:

- **`baseMtimeMs` on DELETE/PATCH called scope creep.** The reviewer read `ticket-b.md`
  alone, where the contract lines omit it; the wave brief states *"Optimistic-lock policy
  for rename/delete: same `baseMtimeMs` convention as wave 1's write route"*, so it was
  asked for. The reviewer is right that **nothing in the UI sends it** — the file list
  carries no mtime, only an open tab has a baseline. Kept, and the comment now says plainly
  that the explorer never reaches it rather than claiming a protection that is not running.
- **The non-recursive delete branch called unreachable.** True from the app, deliberately:
  it is the guard for any other caller, so a request without an explicit `recursive` cannot
  take a tree with it. Now says so in the code.
- The reviewer independently agreed the `workspace-explorer-tab.tsx` deletion was
  defensible and that keeping the pre-existing tree does not violate *"Do NOT build a tree
  view"* — *"nothing new was built; directory rows were fed into the list that was already
  there."*

### Standards axis — zero hard violations, eight judgement calls

No documented standard is breached: the agent-environment rules, the `src/lib` →
`git-panel-shared` import (precedented at `src/lib/git/git-panel-read.ts:12`), and the
registry-module shape all check out.

Fixed:

- **A JSDoc had drifted onto the wrong symbol** — the "Remove a file or directory…" block
  sat above `assertUnchangedSince`, leaving `deleteWorkspaceEntry` undocumented. A real
  mistake, now on the function it describes.
- **A dead re-export** (`export { WorkspaceFileError }`) that no importer used. Gone.
- **The Rename/Delete pair was written out twice**, once per row kind. Now one
  `RowMutationActions`; only what the click means differs.
- **Not a smell, but flagged**: `visibleDirectories` tested every folder against every
  visible file — the product of the two, on every keystroke, over a tree that can hold
  twenty thousand entries. The ancestors are now collected once into a set.

Left, with reasons:

- **`applyMaxFiles(fileSet, symlinkSet?, directorySet?)` as a data clump**, and
  `WorkspaceWatchEntry` holding the three sets side by side. Bundling them into a type is a
  fair refactor of wave 1's signature and of the watch entry, which this ticket has no
  reason to churn.
- **`workspace-file-panel.tsx` doing tree rendering, search, dialog state and mutation
  orchestration** (divergent change). Real, and the honest fix is a hook for the mutation
  half. It would touch every call site in the component for no behaviour change, in the
  file the QA above exercises; better as its own change.
- **`WorkspaceEntryNameDialog`'s nine props.** Five are presentation strings that travel
  together and could be one object. The component is used twice, and the flat props are
  what make each call site readable.

### Re-verification after these fixes

`npx tsc --noEmit` clean; `npx eslint src tests` 0 errors. Targeted tests **102 tests, 100
pass, 2 fail** — the same two pre-existing `git-panel.ts` failures.

Browser, on a fresh server and a reset fixture: folder create, file rename, folder delete
with its contents warning, and an external `mkdir` appearing on its own all still pass after
the row-action refactor (`shots/19`), and the new rename warning shows for a dirty buffer
(`shots/18`).
