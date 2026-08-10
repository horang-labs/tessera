import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  parseWorkspaceWritePath,
  resolveWorkspaceWriteTarget,
} from "../src/lib/workspace-files/workspace-file-write-target";

const ROOT = "/workspace/worktree";

test("a new file directly under the workspace root is writable", () => {
  const result = resolveWorkspaceWriteTarget({
    baseName: "notes.md",
    candidateIsSymlink: false,
    candidateRealPath: null,
    parentRealPath: ROOT,
    pathModule: path.posix,
    rootRealPath: ROOT,
  });

  assert.deepEqual(result, {
    allowed: true,
    absolutePath: `${ROOT}/notes.md`,
    relativePath: "notes.md",
  });
});

test("a parent directory that resolves outside the workspace is refused", () => {
  // linked-dir/ is a symlink to somewhere else: the read side refuses to index
  // through it, so the write side must not create files through it either.
  const result = resolveWorkspaceWriteTarget({
    baseName: "payload.sh",
    candidateIsSymlink: false,
    candidateRealPath: null,
    parentRealPath: "/etc/cron.d",
    pathModule: path.posix,
    rootRealPath: ROOT,
  });

  assert.deepEqual(result, { allowed: false });
});

test("saving through a link that points outside the workspace is allowed, as reading it is", () => {
  // Worktree bootstrap creates exactly this: ln -s "$PROJECT_DIR/CLAUDE.md".
  // The read route opens it, so refusing to save it would leave an editable
  // buffer that can never be written back.
  const result = resolveWorkspaceWriteTarget({
    baseName: "CLAUDE.md",
    candidateIsSymlink: true,
    candidateRealPath: "/workspace/source/CLAUDE.md",
    parentRealPath: ROOT,
    pathModule: path.posix,
    rootRealPath: ROOT,
  });

  assert.deepEqual(result, {
    allowed: true,
    absolutePath: `${ROOT}/CLAUDE.md`,
    relativePath: "CLAUDE.md",
  });
});

test("an existing target that resolves outside without being a link itself is refused", () => {
  // Same rule the read side applies: exactly one link is followed, and only
  // when the requested path is itself that link. Anything else reaching
  // outside (a bind mount under the root, say) stays blocked.
  const result = resolveWorkspaceWriteTarget({
    baseName: "app.ts",
    candidateIsSymlink: false,
    candidateRealPath: "/etc/app.ts",
    parentRealPath: `${ROOT}/src`,
    pathModule: path.posix,
    rootRealPath: ROOT,
  });

  assert.deepEqual(result, { allowed: false });
});

test("a relative path inside the workspace parses and keeps its segments", () => {
  assert.deepEqual(parseWorkspaceWritePath("src/lib/notes.md"), {
    ok: true,
    normalizedPath: "src/lib/notes.md",
  });
  // Windows-style separators are what a Windows client sends for the same file.
  assert.deepEqual(parseWorkspaceWritePath("src\\lib\\notes.md"), {
    ok: true,
    normalizedPath: "src/lib/notes.md",
  });
});

test("paths that cannot address a file inside the workspace are rejected", () => {
  assert.deepEqual(parseWorkspaceWritePath(""), { ok: false, reason: "empty" });
  assert.deepEqual(parseWorkspaceWritePath("   "), { ok: false, reason: "empty" });
  assert.deepEqual(parseWorkspaceWritePath("notes\0.md"), { ok: false, reason: "nul" });
  assert.deepEqual(parseWorkspaceWritePath("/etc/passwd"), { ok: false, reason: "absolute" });
  assert.deepEqual(parseWorkspaceWritePath("C:\\Windows\\hosts"), { ok: false, reason: "absolute" });
  // A trailing separator or a dot segment names a directory, never a file.
  assert.deepEqual(parseWorkspaceWritePath("src/"), { ok: false, reason: "invalid_base" });
  assert.deepEqual(parseWorkspaceWritePath("src/.."), { ok: false, reason: "invalid_base" });
  assert.deepEqual(parseWorkspaceWritePath("."), { ok: false, reason: "invalid_base" });
});

test("a path escaping the workspace lexically is rejected before any filesystem call", () => {
  assert.deepEqual(parseWorkspaceWritePath("../outside.txt"), { ok: false, reason: "escapes" });
  assert.deepEqual(parseWorkspaceWritePath("src/../../outside.txt"), { ok: false, reason: "escapes" });
  // Staying inside after normalising is fine.
  assert.deepEqual(parseWorkspaceWritePath("src/../notes.md"), {
    ok: true,
    normalizedPath: "notes.md",
  });
});
