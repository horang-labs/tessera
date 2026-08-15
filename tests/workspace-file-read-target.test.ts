import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  isInsideWorkspacePath,
  resolveWorkspaceReadTarget,
} from "../src/lib/workspace-files/workspace-file-read-target";

const ROOT = "/workspace/worktree";

test("a file inside the workspace is reported by its workspace-relative path", () => {
  const result = resolveWorkspaceReadTarget({
    candidatePath: `${ROOT}/src/app.ts`,
    candidateIsSymlink: false,
    pathModule: path.posix,
    rootRealPath: ROOT,
    targetRealPath: `${ROOT}/src/app.ts`,
  });

  assert.deepEqual(result, { allowed: true, relativePath: "src/app.ts" });
});

test("a link inside the workspace may point outside it and reports the clicked path", () => {
  // What a worktree bootstrap script produces:
  //   ln -sfn "$TESSERA_PROJECT_DIR/CLAUDE.md" CLAUDE.md
  const result = resolveWorkspaceReadTarget({
    candidatePath: `${ROOT}/CLAUDE.md`,
    candidateIsSymlink: true,
    pathModule: path.posix,
    rootRealPath: ROOT,
    targetRealPath: "/workspace/source/CLAUDE.md",
  });

  // Not "../source/CLAUDE.md": the UI addresses files by workspace path.
  assert.deepEqual(result, { allowed: true, relativePath: "CLAUDE.md" });
});

test("a path reaching outside without being a link itself stays blocked", () => {
  // e.g. linked-dir/secret.txt — the scan never indexes such a path either.
  const result = resolveWorkspaceReadTarget({
    candidatePath: `${ROOT}/linked-dir/secret.txt`,
    candidateIsSymlink: false,
    pathModule: path.posix,
    rootRealPath: ROOT,
    targetRealPath: "/etc/secret.txt",
  });

  assert.deepEqual(result, { allowed: false });
});

test("a link that resolves back inside the workspace keeps its real path", () => {
  const result = resolveWorkspaceReadTarget({
    candidatePath: `${ROOT}/alias.ts`,
    candidateIsSymlink: true,
    pathModule: path.posix,
    rootRealPath: ROOT,
    targetRealPath: `${ROOT}/src/app.ts`,
  });

  assert.deepEqual(result, { allowed: true, relativePath: "src/app.ts" });
});

test("workspace containment check rejects traversal and accepts the root itself", () => {
  assert.equal(isInsideWorkspacePath(ROOT, `${ROOT}/src/app.ts`, path.posix), true);
  assert.equal(isInsideWorkspacePath(ROOT, ROOT, path.posix), true);
  assert.equal(isInsideWorkspacePath(ROOT, "/workspace/other/app.ts", path.posix), false);
  assert.equal(isInsideWorkspacePath(ROOT, "/etc/passwd", path.posix), false);
  assert.equal(
    isInsideWorkspacePath("C:\\workspace\\worktree", "C:\\workspace\\worktree\\src\\a.ts", path.win32),
    true,
  );
  assert.equal(
    isInsideWorkspacePath("C:\\workspace\\worktree", "C:\\other\\a.ts", path.win32),
    false,
  );
});
