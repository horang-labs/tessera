import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyMaxFiles,
  isIgnoredWorkspacePath,
  MAX_WORKSPACE_FILES,
  normalizeWorkspaceRelativePath,
  scanWorkspaceDirectory,
  walkWorkspaceFiles,
  workspaceRelativeDirname,
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
    // Dotfiles are collected and filtered client-side by the show-hidden
    // toggle, so the walk keeps them; only the always-ignored build/VCS
    // directories are pruned here.
    assert.deepEqual(result.files, [
      ".config/settings.json",
      ".env",
      ".env.example",
      "src/a.ts",
      "src/b.ts",
    ]);
  });
});

test("workspace file scan lists linked files and marks them", async () => {
  await withTempWorkspace(async (root) => {
    // Mirrors what a worktree bootstrap script does: link the shared agent
    // instructions back to the source checkout instead of copying them.
    const source = path.join(root, "source");
    await mkdir(path.join(source, "prd-doc"), { recursive: true });
    await mkdir(path.join(root, "worktree"), { recursive: true });
    await writeFile(path.join(source, "CLAUDE.md"), "shared");
    await writeFile(path.join(source, "prd-doc/spec.md"), "spec");
    await writeFile(path.join(root, "worktree/own.ts"), "");

    await symlink(path.join(source, "CLAUDE.md"), path.join(root, "worktree/CLAUDE.md"));
    await symlink(path.join(source, "prd-doc"), path.join(root, "worktree/prd-doc"));
    await symlink(path.join(source, "gone.md"), path.join(root, "worktree/dangling.md"));

    const result = await walkWorkspaceFiles(path.join(root, "worktree"));

    // The linked file is listed; the linked directory and the dangling link are
    // not — a directory link would render as an unopenable leaf.
    assert.deepEqual(result.files, ["CLAUDE.md", "own.ts"]);
    assert.deepEqual(result.symlinks, ["CLAUDE.md"]);
    assert.equal(result.truncated, false);
  });
});

test("workspace file scan does not traverse into a linked directory", async () => {
  await withTempWorkspace(async (root) => {
    const outside = path.join(root, "outside");
    await mkdir(path.join(outside, "nested"), { recursive: true });
    await writeFile(path.join(outside, "nested/deep.ts"), "");
    await mkdir(path.join(root, "workspace"), { recursive: true });
    await symlink(outside, path.join(root, "workspace/linked"));

    const result = await walkWorkspaceFiles(path.join(root, "workspace"));

    assert.deepEqual(result.files, []);
    assert.deepEqual(result.symlinks, []);
  });
});

test("directory scan reads one level or the whole subtree", async () => {
  await withTempWorkspace(async (root) => {
    await mkdir(path.join(root, ".codex/skills/graphify"), { recursive: true });
    await writeFile(path.join(root, ".codex/hooks.json"), "{}");
    await writeFile(path.join(root, ".codex/skills/graphify/SKILL.md"), "skill");
    await writeFile(path.join(root, "top.ts"), "");

    const shallow = await scanWorkspaceDirectory(root, ".codex", { recursive: false });
    assert.deepEqual(shallow.files, [".codex/hooks.json"]);
    assert.equal(shallow.missing, false);

    const deep = await scanWorkspaceDirectory(root, ".codex", { recursive: true });
    assert.deepEqual(deep.files, [
      ".codex/hooks.json",
      ".codex/skills/graphify/SKILL.md",
    ]);

    // The root is addressed as the empty path, which is what an event on a
    // top-level entry invalidates.
    const rootShallow = await scanWorkspaceDirectory(root, "", { recursive: false });
    assert.deepEqual(rootShallow.files, ["top.ts"]);
  });
});

test("directory scan reports a vanished directory instead of an empty one", async () => {
  await withTempWorkspace(async (root) => {
    const present = await scanWorkspaceDirectory(root, "gone", { recursive: true });

    // An empty listing and a deleted directory have to be distinguishable: the
    // caller drops the subtree for one and merges nothing for the other.
    assert.equal(present.missing, true);
    assert.deepEqual(present.files, []);

    await mkdir(path.join(root, "empty"), { recursive: true });
    const empty = await scanWorkspaceDirectory(root, "empty", { recursive: true });
    assert.equal(empty.missing, false);
    assert.deepEqual(empty.files, []);
  });
});

test("workspace file scan reports directories, including empty ones", async () => {
  await withTempWorkspace(async (root) => {
    await mkdir(path.join(root, "src/nested"), { recursive: true });
    await mkdir(path.join(root, "empty"), { recursive: true });
    await mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(root, "src/nested/a.ts"), "");
    await writeFile(path.join(root, "top.ts"), "");

    const result = await walkWorkspaceFiles(root);

    // An empty folder has no file to infer it from, so the explorer can only
    // show it if the scan reports it in its own right.
    assert.deepEqual(result.directories, ["empty", "src", "src/nested"]);
    assert.deepEqual(result.files, ["src/nested/a.ts", "top.ts"]);
  });
});

test("workspace path helpers normalize and classify ignored paths", () => {
  assert.equal(workspaceRelativeDirname("top.ts"), "");
  assert.equal(workspaceRelativeDirname(".codex/hooks.json"), ".codex");
  assert.equal(workspaceRelativeDirname(".codex/skills/graphify/SKILL.md"), ".codex/skills/graphify");
  assert.equal(workspaceRelativeDirname("src\\nested\\file.ts"), "src/nested");

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
  assert.deepEqual(result.symlinks, []);
});

test("workspace file index keeps symlink markers inside the capped list", () => {
  const files = new Set<string>();
  for (let index = MAX_WORKSPACE_FILES + 1; index >= 0; index -= 1) {
    files.add(`file-${String(index).padStart(5, "0")}.ts`);
  }
  const droppedByCap = `file-${String(MAX_WORKSPACE_FILES).padStart(5, "0")}.ts`;
  const symlinks = new Set(["file-00000.ts", droppedByCap]);

  const result = applyMaxFiles(files, symlinks);

  // A marker for a path the cap dropped must not survive: the client joins
  // this list against `files` and would otherwise carry a dangling entry.
  assert.deepEqual(result.symlinks, ["file-00000.ts"]);
});

test("the scan cap covers files and directories together", async () => {
  await withTempWorkspace(async (root) => {
    // Directories first in readdir order, then the files beside them: with a
    // separate budget per kind, hitting the directory cap would abandon the
    // walk mid-directory and drop the files it had not reached yet.
    for (let index = 0; index < 4; index += 1) {
      await mkdir(path.join(root, `dir-${index}`), { recursive: true });
      await writeFile(path.join(root, `file-${index}.ts`), "");
    }

    const result = await scanWorkspaceDirectory(root, "", { limit: 6, recursive: true });

    assert.equal(result.truncated, true);
    // One shared budget: the two lists together stay within it, rather than
    // each list being allowed the whole of it.
    assert.ok(
      result.files.length + result.directories.length <= 6,
      `expected the cap to be shared, got ${result.files.length} files and ${result.directories.length} directories`,
    );
    assert.ok(result.files.length > 0, "files must not be starved by the directory count");
  });
});
