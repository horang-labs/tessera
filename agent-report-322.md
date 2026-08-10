# agent-report-322 — File Explorer inline UX: new file / new folder / rename without modals

Branch: `feature/322-inline-explorer`. Not pushed, not merged, no PR.

- `365f65d` feat(workspace): name files and folders inline, not in a modal

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
focus). Enter commits, Esc abandons with no request at all, and a blur commits after
150 ms — what Finder, VS Code and Orca all do. A stray blur cannot create anything,
because an empty value and an unchanged rename both resolve to `cancel`.

The row carries the error under the field (`workspace-inline-input-error`, `role="alert"`)
and, for a rename of a file with unsaved edits, the warning wave 2's spec review asked for
(`workspace-inline-input-hint`) — the dialog used to carry it and the loss is real, so it
moved rather than disappearing.

### `workspace-file-panel.tsx`

- Header **New file** / **New folder** open a placeholder at the root; the per-folder
  buttons open one inside that folder and expand it first.
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

_(pending — filled in below once both axes return)_
