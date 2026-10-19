import assert from "node:assert/strict";
import test from "node:test";
import {
  findWorkspaceTypeAheadMatch,
  resolveWorkspaceTreeKey,
  type WorkspaceKeyRow,
} from "../src/lib/workspace-files/workspace-tree-keyboard";
import { resolveWorkspaceDrop } from "../src/lib/workspace-files/workspace-tree-drop";

const rows: WorkspaceKeyRow[] = [
  { path: "docs", type: "directory", name: "docs" },
  { path: "docs/a.md", type: "file", name: "a.md" },
  { path: "src", type: "directory", name: "src" },
  { path: "readme.md", type: "file", name: "readme.md" },
];
const base = { rows, shiftKey: false, searching: false };

test("arrows walk the visible rows and clamp at the ends", () => {
  assert.deepEqual(
    resolveWorkspaceTreeKey({ ...base, key: "ArrowDown", current: "docs", expanded: new Set() }),
    { type: "focus", path: "docs/a.md", extend: false },
  );
  assert.deepEqual(
    resolveWorkspaceTreeKey({ ...base, key: "ArrowDown", current: "readme.md", expanded: new Set() }),
    { type: "focus", path: "readme.md", extend: false },
  );
  assert.deepEqual(
    resolveWorkspaceTreeKey({ ...base, key: "ArrowUp", current: "docs", expanded: new Set() }),
    { type: "focus", path: "docs", extend: false },
  );
  assert.deepEqual(
    resolveWorkspaceTreeKey({ ...base, key: "End", current: "docs", expanded: new Set() }),
    { type: "focus", path: "readme.md", extend: false },
  );
});

test("right opens a folder, then steps into it; left closes, then steps out", () => {
  assert.deepEqual(
    resolveWorkspaceTreeKey({ ...base, key: "ArrowRight", current: "docs", expanded: new Set() }),
    { type: "expand", path: "docs" },
  );
  assert.deepEqual(
    resolveWorkspaceTreeKey({ ...base, key: "ArrowRight", current: "docs", expanded: new Set(["docs"]) }),
    { type: "focus", path: "docs/a.md", extend: false },
  );
  assert.deepEqual(
    resolveWorkspaceTreeKey({ ...base, key: "ArrowLeft", current: "docs", expanded: new Set(["docs"]) }),
    { type: "collapse", path: "docs" },
  );
  assert.deepEqual(
    resolveWorkspaceTreeKey({ ...base, key: "ArrowLeft", current: "docs/a.md", expanded: new Set(["docs"]) }),
    { type: "focus", path: "docs", extend: false },
  );
  assert.equal(resolveWorkspaceTreeKey({ ...base, key: "ArrowRight", current: "readme.md", expanded: new Set() }), null);
});

test("shift extends and unknown keys are left alone", () => {
  assert.deepEqual(
    resolveWorkspaceTreeKey({ ...base, shiftKey: true, key: "ArrowDown", current: "docs", expanded: new Set() }),
    { type: "focus", path: "docs/a.md", extend: true },
  );
  assert.equal(resolveWorkspaceTreeKey({ ...base, key: "q", current: "docs", expanded: new Set() }), null);
});

test("type-ahead finds the next matching name and wraps", () => {
  assert.equal(findWorkspaceTypeAheadMatch(rows, "docs", "r"), "readme.md");
  assert.equal(findWorkspaceTypeAheadMatch(rows, "readme.md", "d"), "docs");
  assert.equal(findWorkspaceTypeAheadMatch(rows, "docs", "re"), "readme.md");
  assert.equal(findWorkspaceTypeAheadMatch(rows, "docs", "zz"), null);
});

test("drop rules: no self or descendant drops, same folder is a no-op", () => {
  assert.deepEqual(resolveWorkspaceDrop(["docs"], "docs"), { allowed: false, movable: [] });
  assert.deepEqual(resolveWorkspaceDrop(["docs"], "docs/sub"), { allowed: false, movable: [] });
  assert.deepEqual(resolveWorkspaceDrop(["docs/a.md"], "docs"), { allowed: false, movable: [] });
  assert.deepEqual(resolveWorkspaceDrop(["docs/a.md"], ""), { allowed: true, movable: ["docs/a.md"] });
  assert.deepEqual(resolveWorkspaceDrop(["a.md", "docs/b.md"], "docs"), { allowed: true, movable: ["a.md"] });
});
