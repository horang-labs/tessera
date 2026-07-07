import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyMaxFiles,
  isIgnoredWorkspacePath,
  MAX_WORKSPACE_FILES,
  normalizeWorkspaceRelativePath,
  walkWorkspaceFiles,
} from "../src/lib/workspace-files/workspace-file-scan";

async function withTempWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "tessera-workspace-files-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("workspace file scan ignores heavy and hidden paths consistently", async () => {
  await withTempWorkspace(async (root) => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await mkdir(path.join(root, ".config"), { recursive: true });
    await mkdir(path.join(root, "dist"), { recursive: true });

    await writeFile(path.join(root, "src/b.ts"), "");
    await writeFile(path.join(root, "src/a.ts"), "");
    await writeFile(path.join(root, ".env.example"), "");
    await writeFile(path.join(root, ".env"), "");
    await writeFile(path.join(root, "node_modules/pkg/index.js"), "");
    await writeFile(path.join(root, ".git/config"), "");
    await writeFile(path.join(root, ".config/settings.json"), "");
    await writeFile(path.join(root, "dist/bundle.js"), "");

    const result = await walkWorkspaceFiles(root);

    assert.equal(result.truncated, false);
    assert.deepEqual(result.files, [
      ".env.example",
      "src/a.ts",
      "src/b.ts",
    ]);
  });
});

test("workspace path helpers normalize and classify ignored paths", () => {
  assert.equal(normalizeWorkspaceRelativePath("."), "");
  assert.equal(normalizeWorkspaceRelativePath("src\\nested//file.ts"), "src/nested/file.ts");
  assert.equal(isIgnoredWorkspacePath(".", { isDirectory: () => true }), false);
  assert.equal(isIgnoredWorkspacePath(".env.example"), false);
  assert.equal(isIgnoredWorkspacePath(".env"), true);
  assert.equal(isIgnoredWorkspacePath("src/.generated/file.ts"), true);
  assert.equal(isIgnoredWorkspacePath("node_modules/pkg/index.js"), true);
  assert.equal(isIgnoredWorkspacePath("src/file.ts"), false);
});

test("workspace file index caps sorted snapshots", () => {
  const files = new Set<string>();
  for (let index = MAX_WORKSPACE_FILES + 1; index >= 0; index -= 1) {
    files.add(`file-${String(index).padStart(5, "0")}.ts`);
  }

  const result = applyMaxFiles(files);

  assert.equal(result.truncated, true);
  assert.equal(result.files.length, MAX_WORKSPACE_FILES);
  assert.equal(result.files[0], "file-00000.ts");
  assert.equal(result.files.at(-1), `file-${String(MAX_WORKSPACE_FILES - 1).padStart(5, "0")}.ts`);
});
