# agent-report-322 — File Explorer inline UX: new file / new folder / rename without modals

Branch: `feature/322-inline-explorer`. Not pushed, not merged, no PR.

- `365f65d` feat(workspace): name files and folders inline, not in a modal
- `c287341` fix(workspace): commit an inline blur before the row can be unmounted
- `67e890a` fix(workspace): move the row actions onto the right-click menu

## What was built

The three name-entry dialogs are gone. Naming now happens in the tree, where the entry
will live.

### `workspace-inline-input-state.ts` (new) — the rules, with no React and no DOM in them

Everything that is a *decision* rather than a *side effect* lives here, so it is testable
directly rather than through a component:

- `resolveInlineSubmitIntent(input, value)` → `create-file` / `create-folder` / `rename` /
  `cancel`. Empty-or-whitespace cancels; a rename back to the name the row already has
  cancels (the server would refuse it as a collision with itself). Names are trimmed. A
  rename always yields a **bare name**, never a path, so the route's same-directory rule
  is never even tested by the client.
- `resolveDirToggleTiming({ clickCount, fromRenameHotspot })` → `immediate` / `deferred` /
  `skip`, ported from Orca's `file-explorer-dir-toggle-timing.ts`. A double-click on a
  folder's name means rename, but each of its two clicks also reaches the row and toggles
  the disclosure, so without this the folder collapses and re-expands under the input.
- `isRenameHotspotTarget(target)` — duck-typed on `closest`, so the rule is the same with
  or without a DOM and can be exercised in a node test.
- `selectBaseNameRange(name)` — the opening selection of a rename: the name without its
  extension, whole for a folder or a dotfile.
- `RENAME_HOTSPOT_ATTR`, `DIR_TOGGLE_DOUBLE_CLICK_MS`.

### `use-workspace-inline-input.ts` (new) — the state machine

idle → entering-new / editing-existing → submitting → error-or-idle, ported from Orca's
`useFileExplorerInlineInput` minus the undo/redo stack (out of scope).

- A failed submit **keeps the input open** and holds the server's own message, so a
  duplicate name is corrected where it was typed. There is no toast and no modal on this
  path.
- `handleExternalRefresh` is the gate the panel hands to `useWorkspaceFilesLiveSync`:
  while an input is open the watch-driven reload is recorded as pending and **not** run;
  it is applied once, when the input closes. Without it a reconcile takes the row and the
  half-typed name with it.
- Handlers live in a ref updated every render, so the panel re-rendering does not
  re-create the callbacks and remount the input under the user's cursor.

### `workspace-inline-input-row.tsx` (new) — the row and its focus lifecycle

Focus lands a frame after mount (the click that opened the row is still settling its own
focus). Enter commits, Esc abandons with no request at all, and a blur commits — what
Finder, VS Code and Orca all do. A stray blur cannot create anything, because an empty
value and an unchanged rename both resolve to `cancel`. (The blur commit was initially
deferred 150 ms; the Standards review showed why it cannot be — see below.)

The row carries the error under the field (`workspace-inline-input-error`, `role="alert"`)
and, for a rename of a file with unsaved edits, the warning wave 2's spec review asked for
(`workspace-inline-input-hint`) — the dialog used to carry it and the loss is real, so it
moved rather than disappearing.

### `workspace-file-panel.tsx`

- **New file** / **New folder** open a placeholder at the right depth and expand the folder
  first. (These began as header and per-row buttons; the user's mid-wave feedback moved them
  onto the right-click menu — see "UX rework" below, which is the shipped shape.)
- **Rename** on a row and a **double-click on the name text** are the same call. The
  hotspot is the name alone, so the icon, the chevron and the empty part of the row keep
  doing what they always did (open the file, toggle the folder).
- A renaming row is **replaced** by the input row rather than having an input put inside
  its button — a control nested in a control is invalid HTML and unreachable to a screen
  reader, which wave 1's standards review already corrected once here.
- A folder being renamed keeps its subtree visible.

### `workspace-file-mutation-client.ts`

One addition: `createWorkspaceFileRequest`, which issues the same `POST …/file` the
deleted dialog issued, through the existing `requestMutation` helper. No route, resolver
or error shape was touched.

### Deleted

`workspace-new-file-dialog.tsx`, `workspace-entry-name-dialog.tsx`. `workspace-delete-dialog.tsx`
stays: destructive, permanent, no Trash behind it.

## TSC / lint

```
$ npx tsc --noEmit
(no output, exit 0)

$ npm run lint
/…/src/components/chat/preview-markdown.tsx
  323:9  warning  Using `<img>` could result in slower LCP …
/…/src/hooks/use-virtual-message-list.ts
  365:23  warning  Compilation Skipped: Use of incompatible library
/…/src/lib/cli/spawn-cli-runtime.ts
  19:1  warning  Unused eslint-disable directive …

✖ 3 problems (0 errors, 3 warnings)
```

0 errors. All 3 warnings are in files this branch does not touch. One lint error *was*
introduced and fixed before committing: React Compiler's "Cannot create components during
render" on an icon component picked into a variable — it is now written out as
`InlineInputIcon`.

The agent-environment gate passes: none of the three new files reads `os.homedir()`,
`CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `XDG_DATA_HOME`, and the contract test that asserts
their absence now covers all three.

## Targeted tests

Runner: `npx tsx --test <files>`. No full suite, per the repo's verification policy.

```
$ npx tsx --test tests/workspace-inline-input-state.test.ts \
    tests/workspace-tree-operations-contract.test.mjs \
    tests/workspace-file-editing-contract.test.mjs tests/workspace-file-mutations.test.ts \
    tests/workspace-file-write.test.ts tests/workspace-file-scan.test.ts \
    tests/workspace-file-watch-manager.test.ts tests/workspace-self-write-registry.test.ts
# tests 102
# pass 102
# fail 0
```

After the review fixes and the UX rework this is **106 / 106** (three new state rules and
three new contract tests); the final run is recorded at the end of this report.

| File | Tests | Covers |
|---|---|---|
| `tests/workspace-inline-input-state.test.ts` (new) | 11 | Every rule above, driven test-first: the four submit intents, both cancel conditions, trimming, the three toggle timings, hotspot detection through a nested element, and the extension-excluding selection (including `.gitignore` and `archive.tar.gz`). |
| `tests/workspace-tree-operations-contract.test.mjs` (rewritten) | 18 | The assertions that named the dialogs now name the inline surface: the placeholder and rename entry points, that both dialog files are **gone** and unreferenced, Enter/Esc, the cancel rule, the error rendered beside the input with no toast, the watch gate, the hotspot and deferred toggle, and that the delete confirmation survived. |
| `tests/workspace-file-editing-contract.test.mjs` (updated) | 17 | The create-file assertions moved from the dialog to the mutation client and the panel's `openWorkspaceFileTab`. |

One test outside this surface fails and is **pre-existing**:
`tests/workspace-file-drag-contract.test.ts` #1, `absolutePath: undefined` against
`src/lib/dnd/panel-session-drag.ts` — neither that source nor that test is in this
branch's diff (`git status` shows the whole change set). Not investigated further; it is
not this ticket's.

## Real dev-server QA

Topology: **WSL-native throughout** — `server.ts` on Linux (port 3222), Chromium on Linux,
workspace on the Linux filesystem. `TESSERA_DEV_PORT` was **not** set. Fully isolated
`TESSERA_DATA_DIR=/home/work/tmp/qa322/data`, so neither the user's app DB nor the shared
`tessera-dev.db` was touched; the setup screen was switched to **WSL tools**. Fixture: a
throwaway git repo at `/home/work/tmp/qa322/repo` with two files, `docs/` (with a nested
folder), and an **empty** folder.

Screenshots: `/home/work/tmp/qa322/shots/`
(UNC: `\\wsl.localhost\Ubuntu-24.04\home\work\tmp\qa322\shots\`).

The dev annotation overlay was suppressed before driving — it is a class-less `div` under
`<body>` that intercepts clicks and pollutes the accessibility snapshot. A `MutationObserver`
removes it and any `nextjs-portal` on every mutation.

| AC / behaviour | Evidence |
|---|---|
| **New file** at the root inserts a focused placeholder row | `02` — row present, `data-inline-input-kind="new-file"`, `document.activeElement` is the input |
| Enter creates it and opens it in a tab | `inline-root.md` on disk, placeholder replaced by a real row, tab `inline-root.md` opened |
| **New file** on a folder row inserts *inside* that folder, expanding it | `03` — indent 20px (depth 1), `docs/` auto-expanded |
| A refused name renders **inline** under the input, not in a toast/modal | `04` — "A file with this name already exists", input still open with the typed value |
| Correcting the name then creates it | `docs/inline-in-folder.md` on disk |
| **New folder** at the root; Esc removes the placeholder | `05` — typed then Esc: nothing on disk, row gone |
| Esc issues **no network call** | `fetch` hooked before the attempt: zero non-GET requests to `…/file` or `…/directory` |
| **New folder** creates it | `06` — `reports/` appears; the hook recorded exactly one `POST …/directory` |
| **New folder** inside a folder row | `14` — `reports/weekly` on disk and in the tree |
| **Double-click a file name** opens an inline rename in place | `07` — kind `rename`, value `notes.txt`, selection `[0,5]` (extension excluded), old row replaced |
| Enter renames; the open tab follows | `journal.txt` on disk, tab title followed, exactly one `PATCH …/file` |
| **Double-click a folder name** renames without collapsing it | `08` — input open, `docs/guide.md` still visible under it |
| A folder rename moves its contents and re-points a tab inside it | `09`, `10` — `documents/` with all three entries, tab header reads `documents/inline-in-folder.md` |
| The **Rename** button behaves identically to the double-click | kind `rename`, same prefilled value and focus |
| A rename with a separator is refused inline | "A name cannot contain a folder separator", input stays open |
| A rename onto a taken name is refused inline, both files intact | `15` — "Something with this name already exists here"; `README.md` 8 B and `journal.txt` 6 B unchanged |
| **A watch reconcile cannot take the row being edited** | `11` — with a half-typed rename open, an external `touch` **and** `mkdir` produced no visible change and the input kept its value and focus |
| …and the held-back reload is applied when the input closes | `12` — on Esc both the external file and the external folder appeared, and the row came back |
| A blur commits (Finder behaviour) | renamed to `blurred-name.md` on disk without pressing Enter |
| The **Delete** confirmation is unchanged | `13` — same dialog, same copy ("does not go to the Trash and cannot be undone") |
| Folder toggle still works from outside the hotspot | chevron click: expanded within 200 ms |
| A name click defers the toggle past the double-click window | name click: unchanged at 200 ms, toggled at 800 ms |

**The dialog components are gone from the built bundle.** `npm run build` (exit 0), then
grepping `.next/static` and `.next/server`: no `workspace-new-file-dialog`,
`workspace-rename-dialog` or `workspace-new-folder-dialog` testid anywhere;
`workspace-inline-input` and `workspace-delete-confirm` both present in
`.next/static/chunks/79560.*.js`.

### Harness notes, so the log is not misread

- Clicking a file row's **Rename** button through Playwright needs an explicit `hover`
  first: the row's name `span` is `flex-1` and reaches under the action strip, and the
  strip is `sm:pointer-events-none` until `group-hover`. A real pointer hovers on the way
  to the button, so this is a driver artefact, not a defect — and the geometry is wave
  1/2's, unchanged here. After `hover` the click lands and the inline rename opens.
- Toggle timing cannot be measured across two `playwright-cli` invocations (each is a
  separate process, easily >500 ms apart). The numbers above come from a single `eval`
  that clicks and samples at 200 ms and 800 ms.

## Deviations from the ticket

1. **A file name's double-click no longer opens the file in a pinned tab** — it starts a
   rename, which is exactly what the AC asks for ("Double-clicking a file or folder name
   replaces the name label with an `<input>`"). The trade-off is Orca's: the hotspot is
   the name text only, so double-clicking the icon or the empty part of the row still
   opens the file. Worth knowing because the single click still opens a preview tab, so
   double-clicking a name both previews and renames.
2. **Renaming a folder collapses it in the tree afterwards.** The expansion set is keyed
   by path and the path changed. This is wave 2's behaviour, unchanged — the dialog did
   the same thing — so it was left rather than fixed under this ticket.
3. **`baseMtimeMs` on rename is where waves 1/2 left it.** The client still sends no
   baseline for a rename (the file list carries no mtime; only an open tab has one). The
   route still accepts and enforces it. #320's report records the same, and this ticket
   changes only the UI that issues the call.
4. **`createWorkspaceFileRequest` is a new client function the ticket did not name.**
   The create-file request lived inside the deleted dialog; moving it into the existing
   mutation client beat re-implementing `fetch` + error extraction in the panel. No error
   shape changed — it reuses `requestMutation` and the dialog's own messages.

## AC items I could not verify

- **Bridged topology (Windows host + WSL agent).** Not exercised. The change is entirely
  in the browser: no platform branch, no path-style decision, no filesystem call of its
  own — every request goes to the same routes waves 1/2 shipped and verified. Left to
  integration QA, as both earlier waves left it.
- **Symlink-escape and folder-not-found errors rendering inline.** Only two of the four
  named error classes were driven through the UI (duplicate, invalid name). The other two
  cannot be produced from the inline surface: the input submits a bare name relative to a
  folder the tree is showing, so there is no way to type a path that escapes the root or
  names a missing parent. They share the one code path the two verified cases exercise —
  the hook stores whatever message the mutation client raises — so the rendering is the
  same; what is unverified is only that those particular server messages appear.

## Skills actually run

- `/tdd` — ran for `workspace-inline-input-state.ts`: 8 genuine red→green cycles, one
  slice at a time, each RED confirmed before the implementation. The hook, the row
  component and the panel were **not** test-driven — this repo has no DOM test rig for
  React components — so they are covered by contract tests written after the fact (which
  is verification, not test-first) plus the browser QA above.
- `/run` — the dev-server QA above.
- `/code-review` — both sub-agents spawned in parallel; findings below.
- Full suite: not run, and not necessary — the change is localized to the workspace file
  panel, and the targeted plus contract tests cover it.

## Sub-agent review

Both axes were spawned in parallel. Neither sent its report as a final message — each
surfaced only as an idle notification and had to be asked again for the text, exactly as
`agent-report-320.md` warned. Worth building into the next wave's expectations.

### Standards axis — one hard violation, no documented-standard breach

**Fixed (`c287341`) — the blur commit was lost on unmount.** Real, and the worst thing
found. The blur sat behind a 150 ms timer (copied from Orca, where it survives a context
menu's focus shuffle); opening another row's input unmounts this one, and the cleanup took
the pending timer — and the typed name — with it. Typing a new name and then double-clicking
another row lost the first rename **silently**. The blur now commits synchronously, which
puts the request out while the input it belongs to is still the open one; the hook stamps
each submit with a generation so a late reply neither closes the input that replaced it nor
hangs the old input's error there. Verified in the browser: `journal.txt` edited to
`switched-away.txt`, then a double-click on another row — the rename landed on disk and the
new input opened clean.

Also fixed: `beginRename` no longer shares a name with the hook's `startRename` while doing
more than it, and the duplicated expand-the-parent walk is one `expandParentOf`.

Left, with reasons:

- **`src/hooks/use-inline-rename.ts` re-implementation.** The overlap is real but partial:
  that hook is synchronous, has no submitting state and no server error, and is used for
  labels that cannot be refused. What genuinely coincides — trim, unchanged-name no-op — is
  the rule in `workspace-inline-input-state.ts`, not the hook. Reusing the shell would mean
  rebuilding submitting/error/placeholder-kind around it. Recorded here rather than left
  silent, which was the reviewer's actual complaint.
- **Hook placement under `components/workspace/` rather than `src/hooks/`.** The ticket
  names the path (`src/components/workspace/use-workspace-inline-input.ts`) under "Files to
  touch / create". Following it.
- **`isRenameHotspotTarget` duck-typed on `closest`** rather than `instanceof Element`. That
  is the point: the rule then holds with or without a DOM and is exercised directly. The DOM
  contract it stands on is one method.
- **`hasUnsavedWorkspaceFileEdits` read during render.** Pre-existing — the deleted dialog
  read the same registry the same way. Not introduced here, and fixing it properly means
  giving the registry a subscription, which is its own change.
- **The `input.kind` cascade appearing in five places.** A kind→descriptor map would collapse
  three of them (icon, placeholder, aria-label). Three short branches in one component
  against an indirection every reader has to follow; left.

### Spec axis — every AC satisfied, two real defects beyond them

The reviewer walked all eight AC items with file:line evidence and found each one met,
including the two it was asked to be adversarial about: the watch gate has no bypass
(WS and fallback polling both route through `handleExternalRefresh`, and
`use-workspace-file-list.ts:126` only reloads on a session change), and the inline error is
genuinely reachable and re-submittable (`setError(null)` precedes the request, and the
`[error]` effect unlatches `submittedRef`, so a second Enter is heard).

**Fixed — the rename gesture opened the file twice.** Both clicks of a double-click on a
file's name reached the row, so `previewWorkspaceFileTab` ran a second time under the input
that had just opened. Folders were guarded by `resolveDirToggleTiming`; files had no
equivalent. `shouldOpenOnRowClick` is now that equivalent — driven test-first — and drops
only the second click of a hotspot double-click, so a first click still previews
immediately and a double-click away from the name still pins the tab.

**Fixed — an inline input outlived a session switch.** The panel outlives a session change
and the hook did not know about sessions, so a left-over input would create at the *new*
workspace's root and, worse, hold that panel's watch refresh back permanently — the live
sync would simply stop. The open input now carries the session it was opened against and is
**derived** against the current one rather than reset in an effect (React Compiler rejects
`setState` in an effect body here, and deriving makes the stale state impossible rather than
merely handled). `handleExternalRefresh` gates only on an input for the current session.

**Added — F2 renames a focused row.** The ticket's Entry points section asks for a keyboard
path ("Enter on a focused row … Enter is the paved path"). Enter already activates a row —
opening a file, toggling a folder — and taking it would mean the keyboard could no longer
open a file at all, which is a regression the ticket did not ask for. F2 is the alternative
the same sentence permits, and it collides with nothing.

**Not adopted — Orca's focus-settle grace period.** The reviewer read the pre-`c287341`
code; the timer it concerns is gone. The residual worry (a placeholder losing focus before
anyone types, committing empty) resolves to `cancel` and no request, and nothing in this
panel takes focus programmatically — no menu opens over the input. Not reproduced in QA.

## UX rework after user feedback (`67e890a`)

Mid-wave, on seeing the panel, the user rejected the row-hover action strip: *"the
row-hover action strip (New File / New Folder / Rename / Delete icons crammed on the right
when a row is hovered) is bad UX and clutters the tree. A file explorer does not put four
icons on every row."*

They are right, and it was inherited rather than chosen — waves 1/2 put the actions on the
rows, and this ticket kept them while changing only what they opened.

- **Every hover control is gone from the rows** — rename, delete, new file, new folder and
  copy-path. A row is its name again: chevron, icon, name, count.
- **The header's New file / New folder buttons are gone too.** The header keeps the hidden-
  files toggle and the search box.
- **A right-click menu on every row** carries New file, New folder, Copy absolute path,
  Rename and Delete (Delete in the error colour). This is Orca's shape
  (`FileExplorerRow.tsx:681-688`).
- **A right-click menu on the empty space below the tree** — and on the empty state, where
  it matters most — carries New file and New folder against the root, matching Orca's
  `FileExplorerBackgroundMenu.tsx:58-71`. It has no row, so it offers no Rename and no
  Delete.
- **Where a new entry lands**: inside a folder row, beside a file row (its parent), at the
  root from the background.
- **All three rename entry points survive**: the name's double-click hotspot, F2 on a
  focused row, and the menu item.
- **The delete confirmation is untouched.** Only the trash *icon* went; the destructive
  path still asks.

Nothing else moved: the server surfaces, the optimistic lock, the reconcile pause and every
review fix above are as they were.

### Passes after the rework

```
$ npx tsc --noEmit          → exit 0, no output
$ npm run lint              → ✖ 3 problems (0 errors, 3 warnings)   [the same 3 untouched files]
$ npx tsx --test <8 files>  → # tests 106  # pass 106  # fail 0
```

### QA through the context menu

Same isolated dev server, re-driven after the rework. The dev annotation overlay was
suppressed as before; right-clicks go through `playwright-cli click <target> right`, and the
background menu through a synthesized `contextmenu` event at the bottom of the tree
container (there is no row there to click).

| Behaviour | Evidence |
|---|---|
| No hover controls remain anywhere | `19` — hovering a row shows only the name; a query for all five old testids returns **0** elements |
| Right-click on a file row | `20` — New file · New folder · Copy absolute path · Rename · Delete |
| Menu **Rename** matches the double-click | kind `rename`, value `README.md`, focused, selection `[0,6]` (extension excluded) |
| Menu **New file** on a file row creates beside it | `from-file-menu.md` at the root, placeholder indent 8px (depth 0) |
| Menu **New folder** on a folder row creates inside it | `reports/from-menu` on disk |
| Right-click on the empty space below the tree | `21` — New file · New folder · Copy absolute path, and **no** Rename/Delete |
| Background **New folder** creates at the root | `from-background/` on disk |
| Menu **Delete** still confirms, then deletes | dialog named the file; after confirming it is gone from disk and from the tree (`22`) |
| Double-click rename still works | kind `rename` |
| F2 on a focused row still works | kind `rename` |

### One harness note

Between the two QA passes the panel twice showed "No files" while the API returned 7 — both
times immediately after `npm run build` had written a production bundle into the same
`.next` directory the dev server was serving from. Deleting `.next` and restarting the dev
server ended it, and it never recurred across the rework's passes. Not a product defect;
recorded so the screenshots taken in that window are not misread.
