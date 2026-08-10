import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWorkspaceDirectory,
  deleteWorkspaceEntry,
  parseWorkspaceEntryName,
  renameWorkspaceEntry,
} from "../src/lib/workspace-files/workspace-file-mutations";

function makeWorkspace(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "tessera-mutate-")));
}

test("deleting a file removes it from disk", async () => {
  const root = makeWorkspace();
  try {
    writeFileSync(path.join(root, "notes.md"), "bye");

    const result = await deleteWorkspaceEntry(root, { path: "notes.md" });

    assert.equal(existsSync(path.join(root, "notes.md")), false);
    assert.equal(result.relativePath, "notes.md");
    assert.equal(result.kind, "file");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("deleting a directory takes its contents with it when recursive", async () => {
  const root = makeWorkspace();
  try {
    mkdirSync(path.join(root, "docs/nested"), { recursive: true });
    writeFileSync(path.join(root, "docs/nested/deep.md"), "deep");
    writeFileSync(path.join(root, "keep.md"), "keep");

    const result = await deleteWorkspaceEntry(root, { path: "docs", recursive: true });

    assert.equal(existsSync(path.join(root, "docs")), false);
    assert.equal(result.kind, "directory");
    assert.equal(readFileSync(path.join(root, "keep.md"), "utf8"), "keep");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a non-empty directory is refused unless the caller asked for recursive", async () => {
  const root = makeWorkspace();
  try {
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "docs/inside.md"), "inside");

    await assert.rejects(
      deleteWorkspaceEntry(root, { path: "docs" }),
      (error: { code?: string; status?: number }) =>
        error.code === "directory_not_empty" && error.status === 409,
    );
    assert.equal(existsSync(path.join(root, "docs/inside.md")), true);

    // An empty one needs no such confirmation.
    mkdirSync(path.join(root, "hollow"), { recursive: true });
    await deleteWorkspaceEntry(root, { path: "hollow" });
    assert.equal(existsSync(path.join(root, "hollow")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a stale baseMtimeMs refuses the delete and leaves the file alone", async () => {
  const root = makeWorkspace();
  try {
    const filePath = path.join(root, "notes.md");
    writeFileSync(filePath, "the agent rewrote this after the list was loaded");

    await assert.rejects(
      deleteWorkspaceEntry(root, { baseMtimeMs: 1, path: "notes.md" }),
      (error: { code?: string; status?: number }) =>
        error.code === "conflict" && error.status === 409,
    );
    assert.equal(
      readFileSync(filePath, "utf8"),
      "the agent rewrote this after the list was loaded",
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("delete refuses a path that leaves the workspace", async () => {
  const outer = makeWorkspace();
  try {
    const root = path.join(outer, "workspace");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(outer, "secret.txt"), "secret");

    for (const escapePath of ["../secret.txt", "/etc/hosts", "nested/../../secret.txt"]) {
      await assert.rejects(
        deleteWorkspaceEntry(root, { path: escapePath }),
        (error: { code?: string; status?: number }) =>
          error.code === "invalid_file_path" && error.status === 400,
        `expected ${escapePath} to be refused`,
      );
    }
    assert.equal(readFileSync(path.join(outer, "secret.txt"), "utf8"), "secret");
  } finally {
    rmSync(outer, { force: true, recursive: true });
  }
});

test("deleting something that is not there is a 404", async () => {
  const root = makeWorkspace();
  try {
    await assert.rejects(
      deleteWorkspaceEntry(root, { path: "ghost.md" }),
      (error: { code?: string; status?: number }) =>
        error.code === "file_not_found" && error.status === 404,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a rename target is a bare name, never a path", () => {
  assert.deepEqual(parseWorkspaceEntryName("renamed.md"), { ok: true, name: "renamed.md" });
  assert.deepEqual(parseWorkspaceEntryName("  spaced.md  "), { ok: true, name: "spaced.md" });
  assert.deepEqual(parseWorkspaceEntryName(".hidden"), { ok: true, name: ".hidden" });

  // Rename is same-directory only: a separator would turn it into a move, and
  // the dot segments would turn it into a traversal.
  assert.deepEqual(parseWorkspaceEntryName("docs/renamed.md"), { ok: false, reason: "separator" });
  assert.deepEqual(parseWorkspaceEntryName("docs\\renamed.md"), { ok: false, reason: "separator" });
  assert.deepEqual(parseWorkspaceEntryName("../escape.md"), { ok: false, reason: "separator" });
  assert.deepEqual(parseWorkspaceEntryName(".."), { ok: false, reason: "dot_segment" });
  assert.deepEqual(parseWorkspaceEntryName("."), { ok: false, reason: "dot_segment" });
  assert.deepEqual(parseWorkspaceEntryName(""), { ok: false, reason: "empty" });
  assert.deepEqual(parseWorkspaceEntryName("   "), { ok: false, reason: "empty" });
  assert.deepEqual(parseWorkspaceEntryName("na\0me"), { ok: false, reason: "nul" });
});

test("renaming a file moves it within its own directory", async () => {
  const root = makeWorkspace();
  try {
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "docs/old.md"), "content");

    const result = await renameWorkspaceEntry(root, {
      newName: "new.md",
      path: "docs/old.md",
    });

    assert.equal(existsSync(path.join(root, "docs/old.md")), false);
    assert.equal(readFileSync(path.join(root, "docs/new.md"), "utf8"), "content");
    assert.equal(result.relativePath, "docs/new.md");
    assert.equal(result.previousPath, "docs/old.md");
    assert.equal(result.kind, "file");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("renaming onto an existing name is refused and modifies neither entry", async () => {
  const root = makeWorkspace();
  try {
    writeFileSync(path.join(root, "keep.md"), "the one already there");
    writeFileSync(path.join(root, "move.md"), "the one being renamed");

    await assert.rejects(
      renameWorkspaceEntry(root, { newName: "keep.md", path: "move.md" }),
      (error: { code?: string; status?: number }) =>
        error.code === "already_exists" && error.status === 409,
    );

    // fs.rename would have overwritten keep.md without a word.
    assert.equal(readFileSync(path.join(root, "keep.md"), "utf8"), "the one already there");
    assert.equal(readFileSync(path.join(root, "move.md"), "utf8"), "the one being renamed");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("renaming a folder carries its contents and refuses a duplicate name", async () => {
  const root = makeWorkspace();
  try {
    mkdirSync(path.join(root, "old/nested"), { recursive: true });
    writeFileSync(path.join(root, "old/nested/deep.md"), "deep");
    mkdirSync(path.join(root, "taken"), { recursive: true });

    const result = await renameWorkspaceEntry(root, { newName: "fresh", path: "old" });
    assert.equal(readFileSync(path.join(root, "fresh/nested/deep.md"), "utf8"), "deep");
    assert.equal(result.kind, "directory");

    await assert.rejects(
      renameWorkspaceEntry(root, { newName: "taken", path: "fresh" }),
      (error: { code?: string }) => error.code === "already_exists",
    );
    assert.equal(existsSync(path.join(root, "fresh/nested/deep.md")), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a rename to a path rather than a name is refused", async () => {
  const root = makeWorkspace();
  try {
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "docs/note.md"), "content");

    for (const newName of ["../escaped.md", "sub/note.md", ".."]) {
      await assert.rejects(
        renameWorkspaceEntry(root, { newName, path: "docs/note.md" }),
        (error: { code?: string; status?: number }) =>
          error.code === "invalid_file_name" && error.status === 400,
        `expected ${newName} to be refused`,
      );
    }
    assert.equal(readFileSync(path.join(root, "docs/note.md"), "utf8"), "content");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("renaming something that is gone is a 404, and a stale baseline is a 409", async () => {
  const root = makeWorkspace();
  try {
    await assert.rejects(
      renameWorkspaceEntry(root, { newName: "b.md", path: "ghost.md" }),
      (error: { code?: string; status?: number }) =>
        error.code === "file_not_found" && error.status === 404,
    );

    writeFileSync(path.join(root, "live.md"), "changed since the list loaded");
    await assert.rejects(
      renameWorkspaceEntry(root, { baseMtimeMs: 1, newName: "renamed.md", path: "live.md" }),
      (error: { code?: string; status?: number }) =>
        error.code === "conflict" && error.status === 409,
    );
    assert.equal(existsSync(path.join(root, "live.md")), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("renaming an entry onto itself is not a duplicate", async () => {
  const root = makeWorkspace();
  try {
    writeFileSync(path.join(root, "README.md"), "unchanged");

    // The duplicate check compares entries, not path strings. On a
    // case-insensitive filesystem — macOS and Windows both — "README.md" and
    // "readme.md" are the same entry, so a case-only rename would otherwise be
    // refused as a collision with the file being renamed.
    const result = await renameWorkspaceEntry(root, {
      newName: "README.md",
      path: "README.md",
    });

    assert.equal(result.relativePath, "README.md");
    assert.equal(readFileSync(path.join(root, "README.md"), "utf8"), "unchanged");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("creating a folder makes an empty directory", async () => {
  const root = makeWorkspace();
  try {
    mkdirSync(path.join(root, "docs"), { recursive: true });

    const atRoot = await createWorkspaceDirectory(root, { path: "notes" });
    assert.equal(atRoot.relativePath, "notes");
    assert.equal(statSync(path.join(root, "notes")).isDirectory(), true);

    const nested = await createWorkspaceDirectory(root, { path: "docs/drafts" });
    assert.equal(nested.relativePath, "docs/drafts");
    assert.equal(statSync(path.join(root, "docs/drafts")).isDirectory(), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("creating a folder that already exists is refused", async () => {
  const root = makeWorkspace();
  try {
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "notes.md"), "a file, not a folder");

    for (const taken of ["docs", "notes.md"]) {
      await assert.rejects(
        createWorkspaceDirectory(root, { path: taken }),
        (error: { code?: string; status?: number }) =>
          error.code === "already_exists" && error.status === 409,
        `expected ${taken} to be refused`,
      );
    }
    assert.equal(readFileSync(path.join(root, "notes.md"), "utf8"), "a file, not a folder");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("creating a folder inside one that does not exist is a 404, and escaping is a 400", async () => {
  const outer = makeWorkspace();
  try {
    const root = path.join(outer, "workspace");
    mkdirSync(root, { recursive: true });

    await assert.rejects(
      createWorkspaceDirectory(root, { path: "missing/child" }),
      (error: { code?: string; status?: number }) =>
        error.code === "parent_not_found" && error.status === 404,
    );

    for (const escapePath of ["../outside", "/tmp/outside"]) {
      await assert.rejects(
        createWorkspaceDirectory(root, { path: escapePath }),
        (error: { code?: string; status?: number }) =>
          error.code === "invalid_file_path" && error.status === 400,
        `expected ${escapePath} to be refused`,
      );
    }
    assert.equal(existsSync(path.join(outer, "outside")), false);
  } finally {
    rmSync(outer, { force: true, recursive: true });
  }
});
