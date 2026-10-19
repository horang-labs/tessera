import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  transferWorkspaceEntries,
  uploadWorkspaceFiles,
} from "../src/lib/workspace-files/workspace-file-transfer";

function makeWorkspace(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "tessera-transfer-")));
}

test("moving a file into a folder relocates it", async () => {
  const root = makeWorkspace();
  try {
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "a.md"), "a");
    const result = await transferWorkspaceEntries(root, { operation: "move", sources: ["a.md"], destination: "docs" });
    assert.deepEqual(result.entries, [{ from: "a.md", to: "docs/a.md", kind: "file" }]);
    assert.equal(existsSync(path.join(root, "a.md")), false);
    assert.equal(readFileSync(path.join(root, "docs/a.md"), "utf8"), "a");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("moving to the workspace root and refusing to overwrite", async () => {
  const root = makeWorkspace();
  try {
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs/a.md"), "inner");
    writeFileSync(path.join(root, "a.md"), "outer");
    await assert.rejects(
      transferWorkspaceEntries(root, { operation: "move", sources: ["docs/a.md"], destination: "" }),
      { code: "already_exists" },
    );
    assert.equal(readFileSync(path.join(root, "a.md"), "utf8"), "outer");
    assert.equal(readFileSync(path.join(root, "docs/a.md"), "utf8"), "inner");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a folder cannot be moved into itself or a descendant", async () => {
  const root = makeWorkspace();
  try {
    mkdirSync(path.join(root, "a/b"), { recursive: true });
    await assert.rejects(
      transferWorkspaceEntries(root, { operation: "move", sources: ["a"], destination: "a/b" }),
      { code: "invalid_destination" },
    );
    await assert.rejects(
      transferWorkspaceEntries(root, { operation: "move", sources: ["a"], destination: "a" }),
      { code: "invalid_destination" },
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("destination must exist and stay inside the workspace", async () => {
  const root = makeWorkspace();
  try {
    writeFileSync(path.join(root, "a.md"), "a");
    await assert.rejects(
      transferWorkspaceEntries(root, { operation: "move", sources: ["a.md"], destination: "missing" }),
      { code: "parent_not_found" },
    );
    await assert.rejects(
      transferWorkspaceEntries(root, { operation: "move", sources: ["a.md"], destination: "../outside" }),
      { code: "invalid_file_path" },
    );
    await assert.rejects(
      transferWorkspaceEntries(root, { operation: "move", sources: ["../x"], destination: "" }),
      { code: "invalid_file_path" },
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("copying in place picks a free 'copy' name and keeps the extension", async () => {
  const root = makeWorkspace();
  try {
    writeFileSync(path.join(root, "a.md"), "a");
    const first = await transferWorkspaceEntries(root, { operation: "copy", sources: ["a.md"], destination: "" });
    const second = await transferWorkspaceEntries(root, { operation: "copy", sources: ["a.md"], destination: "" });
    assert.equal(first.entries[0].to, "a copy.md");
    assert.equal(second.entries[0].to, "a copy 2.md");
    assert.equal(readFileSync(path.join(root, "a.md"), "utf8"), "a");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("copying a folder copies its contents, and a clash gets a copy name", async () => {
  const root = makeWorkspace();
  try {
    mkdirSync(path.join(root, "src/deep"), { recursive: true });
    mkdirSync(path.join(root, "dest/src"), { recursive: true });
    writeFileSync(path.join(root, "src/deep/x.txt"), "x");
    const result = await transferWorkspaceEntries(root, { operation: "copy", sources: ["src"], destination: "dest" });
    assert.equal(result.entries[0].to, "dest/src copy");
    assert.equal(readFileSync(path.join(root, "dest/src copy/deep/x.txt"), "utf8"), "x");
    assert.equal(existsSync(path.join(root, "src/deep/x.txt")), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("moving onto the folder an entry already sits in is a no-op", async () => {
  const root = makeWorkspace();
  try {
    writeFileSync(path.join(root, "a.md"), "a");
    const result = await transferWorkspaceEntries(root, { operation: "move", sources: ["a.md"], destination: "" });
    assert.deepEqual(result.entries, [{ from: "a.md", to: "a.md", kind: "file" }]);
    assert.equal(readFileSync(path.join(root, "a.md"), "utf8"), "a");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("upload writes files and dropped folder trees, and never overwrites", async () => {
  const root = makeWorkspace();
  try {
    mkdirSync(path.join(root, "assets"));
    const result = await uploadWorkspaceFiles(root, {
      destination: "assets",
      items: [
        { relativePath: "logo.png", data: Buffer.from([1, 2, 3]) },
        { relativePath: "set/icons/a.svg", data: Buffer.from("<svg/>") },
      ],
    });
    assert.deepEqual(result.paths, ["assets/logo.png", "assets/set/icons/a.svg"]);
    assert.deepEqual([...readFileSync(path.join(root, "assets/logo.png"))], [1, 2, 3]);
    await assert.rejects(
      uploadWorkspaceFiles(root, { destination: "assets", items: [{ relativePath: "logo.png", data: Buffer.from("x") }] }),
      { code: "already_exists" },
    );
    await assert.rejects(
      uploadWorkspaceFiles(root, { destination: "assets", items: [{ relativePath: "../evil", data: Buffer.from("x") }] }),
      { code: "invalid_file_path" },
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
