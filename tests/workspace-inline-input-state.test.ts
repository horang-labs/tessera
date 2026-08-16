import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveInlineSubmitIntent,
  shouldOpenOnRowClick,
  shouldToggleDirectoryOnClick,
  selectBaseNameRange,
} from "../src/components/workspace/workspace-inline-input-state";

test("a name typed into a new-file placeholder creates that file under its parent", () => {
  const intent = resolveInlineSubmitIntent(
    { kind: "new-file", parentPath: "docs" },
    "todo.md",
  );
  assert.deepEqual(intent, { kind: "create-file", path: "docs/todo.md" });
});

test("a placeholder at the root creates without a leading separator", () => {
  const intent = resolveInlineSubmitIntent({ kind: "new-folder", parentPath: "" }, "drafts");
  assert.deepEqual(intent, { kind: "create-folder", path: "drafts" });
});

test("a rename submits the bare name, never a path — the server refuses a move", () => {
  const intent = resolveInlineSubmitIntent(
    { kind: "rename", path: "docs/notes.md", name: "notes.md", isDirectory: false },
    "journal.md",
  );
  assert.deepEqual(intent, { kind: "rename", path: "docs/notes.md", newName: "journal.md" });
});

test("a value that is empty or only whitespace asks for nothing at all", () => {
  // Esc and a blur on an untouched placeholder both land here: no request is
  // worth issuing, so the placeholder simply goes away.
  for (const value of ["", "   ", "\t"]) {
    assert.deepEqual(
      resolveInlineSubmitIntent({ kind: "new-file", parentPath: "" }, value),
      { kind: "cancel" },
    );
  }
});

test("surrounding whitespace is trimmed off a name that survives", () => {
  assert.deepEqual(
    resolveInlineSubmitIntent({ kind: "new-folder", parentPath: "docs" }, "  drafts  "),
    { kind: "create-folder", path: "docs/drafts" },
  );
});

test("a rename back to the name it already has issues no request", () => {
  assert.deepEqual(
    resolveInlineSubmitIntent(
      { kind: "rename", path: "docs/notes.md", name: "notes.md", isDirectory: false },
      "notes.md",
    ),
    { kind: "cancel" },
  );
});

test("a folder toggles on the first click and drops a double-click's second click", () => {
  assert.equal(shouldToggleDirectoryOnClick(1), true);
  assert.equal(shouldToggleDirectoryOnClick(2), false);
});

test("a rename preselects the name without its extension", () => {
  // Retyping a name should not mean retyping ".md" every time.
  assert.deepEqual(selectBaseNameRange("notes.md"), [0, 5]);
  // A folder, or a file with no extension, selects whole.
  assert.deepEqual(selectBaseNameRange("drafts"), [0, 6]);
  // A dotfile is all name: ".gitignore" has no base to keep.
  assert.deepEqual(selectBaseNameRange(".gitignore"), [0, 10]);
  // The last dot wins, so "archive.tar.gz" keeps only ".gz" out of the way.
  assert.deepEqual(selectBaseNameRange("archive.tar.gz"), [0, 11]);
});

test("a double-click gesture creates exactly one file tab", () => {
  assert.equal(shouldOpenOnRowClick(1), true);
  assert.equal(shouldOpenOnRowClick(2), false);
});
