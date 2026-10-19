import assert from "node:assert/strict";
import test from "node:test";
import { buildTrashCommand, resolveTrashSupport } from "../src/lib/workspace-files/workspace-file-trash";
import { buildWorkspaceFileTree } from "../src/lib/workspace-files/workspace-file-tree";

const env = (platform: NodeJS.Platform, release = "6.1.0", hasGio = false) => ({ platform, release, hasGio });

test("a Windows drive has a Recycle Bin, a UNC path does not (including every WSL distro)", () => {
  assert.deepEqual(resolveTrashSupport("C:\\work\\repo", env("win32")), { label: "Recycle Bin" });
  assert.deepEqual(resolveTrashSupport("D:/work/repo", env("win32")), { label: "Recycle Bin" });
  assert.deepEqual(resolveTrashSupport("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\repo", env("win32")), { label: null });
  assert.deepEqual(resolveTrashSupport("\\\\wsl$\\Ubuntu\\home\\me\\repo", env("win32")), { label: null });
  assert.deepEqual(resolveTrashSupport("\\\\fileserver\\share\\repo", env("win32")), { label: null });
});

test("macOS always has a Trash", () => {
  assert.deepEqual(resolveTrashSupport("/Users/me/repo", env("darwin")), { label: "Trash" });
});

test("Linux has a Trash only off WSL and with gio installed", () => {
  assert.deepEqual(resolveTrashSupport("/home/me/repo", env("linux", "6.8.0-generic", true)), { label: "Trash" });
  assert.deepEqual(resolveTrashSupport("/home/me/repo", env("linux", "6.8.0-generic", false)), { label: null });
  // A server running inside WSL: the WSL kernel names Microsoft.
  assert.deepEqual(resolveTrashSupport("/home/me/repo", env("linux", "6.6.87.2-microsoft-standard-WSL2", true)), { label: null });
});

test("trash commands carry the path as an argument, never spliced into a script", () => {
  const nasty = "/tmp/a b/$(touch pwned)'\"; rm -rf x.md";
  const mac = buildTrashCommand("darwin", nasty);
  assert.equal(mac?.command, "osascript");
  assert.equal(mac?.args.at(-1), nasty);
  assert.ok(!mac?.args.slice(0, -1).join("\n").includes("pwned"));

  const linux = buildTrashCommand("linux", nasty);
  assert.deepEqual(linux, { command: "gio", args: ["trash", "--", nasty] });

  const windows = buildTrashCommand("win32", "C:\\repo\\a'b.md");
  assert.equal(windows?.command, "powershell.exe");
  assert.equal(windows?.env?.TESSERA_TRASH_PATH, "C:\\repo\\a'b.md");
  assert.ok(!windows?.args.join(" ").includes("a'b.md"));
  assert.equal(buildTrashCommand("freebsd", "/x"), null);
});

test("the Windows script has no `; else`, which PowerShell rejects as a syntax error", () => {
  const script = buildTrashCommand("win32", "C:\\repo\\a.md")?.args.at(-1) ?? "";
  assert.ok(script.includes("SendToRecycleBin"));
  assert.doesNotMatch(script, /;\s*else\b/);
});

test("modified sort lists the newest files first within each folder, folders stay A-Z", () => {
  const tree = buildWorkspaceFileTree(
    ["old.md", "new.md", "dir/a.md", "dir/b.md"],
    new Set(),
    ["dir", "alpha"],
    "modified",
    { "old.md": 100, "new.md": 300, "dir/a.md": 10, "dir/b.md": 20 },
  );
  assert.deepEqual(tree.map((node) => node.name), ["alpha", "dir", "new.md", "old.md"]);
  const dir = tree.find((node) => node.name === "dir");
  assert.equal(dir?.type === "directory" && dir.children.map((c) => c.name).join(), "b.md,a.md");
});
