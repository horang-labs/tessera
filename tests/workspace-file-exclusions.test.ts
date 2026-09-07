import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isIgnoredWorkspacePath,
  walkWorkspaceFiles,
} from "../src/lib/workspace-files/workspace-file-scan";

test("workspace scans and watch filters prune nested environments, Python caches, and Rust output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tessera-workspace-exclusions-"));
  try {
    for (const directory of [".venv", "__pycache__", "target"]) {
      const relativePath = `tools/seed-vc/${directory}`;
      const output = path.join(root, relativePath, "nested");
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, "artifact"), "");

      for (const candidate of [relativePath, relativePath.replaceAll("/", "\\")]) {
        assert.equal(isIgnoredWorkspacePath(candidate, { isDirectory: () => true }, { includeHidden: true }), true);
        assert.equal(isIgnoredWorkspacePath(`${candidate}/nested/artifact`, undefined, { includeHidden: true }), true);
      }
    }
    await writeFile(path.join(root, "tools/seed-vc/app.py"), "");

    const result = await walkWorkspaceFiles(root);

    assert.equal(result.truncated, false);
    assert.deepEqual(result.directories, ["tools", "tools/seed-vc"]);
    assert.deepEqual(result.files, ["tools/seed-vc/app.py"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
