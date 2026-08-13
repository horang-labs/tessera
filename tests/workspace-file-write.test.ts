import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWorkspaceFile,
  saveWorkspaceFile,
} from "../src/lib/workspace-files/workspace-file-write";

function makeWorkspace(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "tessera-write-")));
}

test("saving an existing file replaces its bytes and reports the new mtime", async () => {
  const root = makeWorkspace();
  try {
    writeFileSync(path.join(root, "notes.md"), "before");

    const result = await saveWorkspaceFile(root, {
      content: "after",
      path: "notes.md",
    });

    assert.equal(readFileSync(path.join(root, "notes.md"), "utf8"), "after");
    assert.equal(result.relativePath, "notes.md");
    assert.equal(result.size, 5);
    assert.equal(typeof result.mtimeMs, "number");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a stale baseMtimeMs is refused as a conflict and leaves the file untouched", async () => {
  const root = makeWorkspace();
  try {
    const filePath = path.join(root, "notes.md");
    writeFileSync(filePath, "agent wrote this");

    await assert.rejects(
      saveWorkspaceFile(root, {
        baseMtimeMs: 1,
        content: "my draft",
        path: "notes.md",
      }),
      (error: { code?: string; status?: number }) =>
        error.code === "conflict" && error.status === 409,
    );
    assert.equal(readFileSync(filePath, "utf8"), "agent wrote this");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("omitting baseMtimeMs overwrites whatever is on disk", async () => {
  const root = makeWorkspace();
  try {
    const filePath = path.join(root, "notes.md");
    writeFileSync(filePath, "agent wrote this");

    await saveWorkspaceFile(root, { content: "mine wins", path: "notes.md" });

    assert.equal(readFileSync(filePath, "utf8"), "mine wins");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a matching baseMtimeMs saves, and the returned mtime is a usable next baseline", async () => {
  const root = makeWorkspace();
  try {
    writeFileSync(path.join(root, "notes.md"), "one");

    const first = await saveWorkspaceFile(root, { content: "two", path: "notes.md" });
    const second = await saveWorkspaceFile(root, {
      baseMtimeMs: first.mtimeMs,
      content: "three",
      path: "notes.md",
    });

    assert.equal(readFileSync(path.join(root, "notes.md"), "utf8"), "three");
    assert.equal(typeof second.mtimeMs, "number");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a body over the text limit is refused before anything is written", async () => {
  const root = makeWorkspace();
  try {
    const filePath = path.join(root, "notes.md");
    writeFileSync(filePath, "small");

    await assert.rejects(
      saveWorkspaceFile(root, { content: "x".repeat(512 * 1024 + 1), path: "notes.md" }),
      (error: { code?: string; status?: number }) =>
        error.code === "file_too_large" && error.status === 413,
    );
    assert.equal(readFileSync(filePath, "utf8"), "small");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("creating a file writes it and refuses a second create on the same name", async () => {
  const root = makeWorkspace();
  try {
    const created = await createWorkspaceFile(root, { content: "hello", path: "docs/../new.md" });
    assert.equal(created.relativePath, "new.md");
    assert.equal(readFileSync(path.join(root, "new.md"), "utf8"), "hello");

    await assert.rejects(
      createWorkspaceFile(root, { content: "clobber", path: "new.md" }),
      (error: { code?: string; status?: number }) =>
        error.code === "already_exists" && error.status === 409,
    );
    assert.equal(readFileSync(path.join(root, "new.md"), "utf8"), "hello");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("creating a file with no content yields an empty file", async () => {
  const root = makeWorkspace();
  try {
    const created = await createWorkspaceFile(root, { path: "empty.txt" });

    assert.equal(created.size, 0);
    assert.equal(readFileSync(path.join(root, "empty.txt"), "utf8"), "");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("creating a file inside a missing folder is a 404, not a silent mkdir", async () => {
  const root = makeWorkspace();
  try {
    await assert.rejects(
      createWorkspaceFile(root, { path: "nope/deep/file.md" }),
      (error: { code?: string; status?: number }) =>
        error.code === "parent_not_found" && error.status === 404,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("paths escaping the workspace are refused for both save and create", async () => {
  const root = makeWorkspace();
  const outside = makeWorkspace();
  try {
    writeFileSync(path.join(outside, "secret.txt"), "secret");

    for (const requestedPath of ["../secret.txt", path.join(outside, "secret.txt"), "a/../../secret.txt"]) {
      await assert.rejects(
        saveWorkspaceFile(root, { content: "owned", path: requestedPath }),
        (error: { code?: string; status?: number }) =>
          error.code === "invalid_file_path" && error.status === 400,
        `save should refuse ${requestedPath}`,
      );
      await assert.rejects(
        createWorkspaceFile(root, { content: "owned", path: requestedPath }),
        (error: { code?: string; status?: number }) =>
          error.code === "invalid_file_path" && error.status === 400,
        `create should refuse ${requestedPath}`,
      );
    }
    assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret");
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("a linked directory inside the workspace cannot be written through", async () => {
  const root = makeWorkspace();
  const outside = makeWorkspace();
  try {
    // What an attacker (or a careless bootstrap script) would leave behind.
    symlinkSync(outside, path.join(root, "escape"), "dir");

    await assert.rejects(
      createWorkspaceFile(root, { content: "owned", path: "escape/payload.sh" }),
      (error: { code?: string; status?: number }) =>
        error.code === "invalid_file_path" && error.status === 400,
    );
    assert.equal(existsSync(path.join(outside, "payload.sh")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("a linked file inside the workspace saves through to its target, as reading it does", async () => {
  const root = makeWorkspace();
  const project = makeWorkspace();
  try {
    // ln -sfn "$TESSERA_PROJECT_DIR/CLAUDE.md" CLAUDE.md — what worktree
    // bootstrap creates, and what the read route already opens.
    const target = path.join(project, "CLAUDE.md");
    writeFileSync(target, "shared guidance");
    symlinkSync(target, path.join(root, "CLAUDE.md"));

    const saved = await saveWorkspaceFile(root, { content: "edited", path: "CLAUDE.md" });

    assert.equal(saved.relativePath, "CLAUDE.md");
    assert.equal(readFileSync(target, "utf8"), "edited");
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(project, { force: true, recursive: true });
  }
});

test("a binary file cannot be replaced with text, even if the client asks", async () => {
  const root = makeWorkspace();
  try {
    // The editor gates on `binary`, but that gate is in the browser. A crafted
    // PUT must not be able to overwrite a PNG with UTF-8.
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    writeFileSync(path.join(root, "logo.png"), original);

    await assert.rejects(
      saveWorkspaceFile(root, { content: "not a png", path: "logo.png" }),
      (error: { code?: string; status?: number }) =>
        error.code === "binary_file" && error.status === 415,
    );
    assert.deepEqual(readFileSync(path.join(root, "logo.png")), original);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a file past the text ceiling cannot be saved back from a truncated buffer", async () => {
  const root = makeWorkspace();
  try {
    // Saving what the reader truncated would silently delete the remainder.
    const original = "x".repeat(512 * 1024 + 10);
    writeFileSync(path.join(root, "huge.txt"), original);

    await assert.rejects(
      saveWorkspaceFile(root, { content: "just the first part", path: "huge.txt" }),
      (error: { code?: string; status?: number }) =>
        error.code === "file_too_large" && error.status === 413,
    );
    assert.equal(readFileSync(path.join(root, "huge.txt"), "utf8").length, original.length);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an empty existing file is still editable", async () => {
  const root = makeWorkspace();
  try {
    writeFileSync(path.join(root, "empty.md"), "");

    await saveWorkspaceFile(root, { content: "# now it has content", path: "empty.md" });

    assert.equal(readFileSync(path.join(root, "empty.md"), "utf8"), "# now it has content");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
