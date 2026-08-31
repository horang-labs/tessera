import assert from "node:assert/strict";
import test from "node:test";
import { shouldReloadReselectedWorktree } from "../src/components/workspace/workspace-file-panel-refresh";

test("the initial Worktree panel mount relies on the file-list hook's own load", () => {
  assert.equal(shouldReloadReselectedWorktree({
    currentTargetKey: "worktree:wt-1",
    isWorktreeTarget: true,
    peekChanged: false,
    peekWorktreeId: "wt-1",
    previousTargetKey: "worktree:wt-1",
    targetId: "wt-1",
  }), false);
});

test("switching Worktrees does not duplicate the file-list hook's target load", () => {
  assert.equal(shouldReloadReselectedWorktree({
    currentTargetKey: "worktree:wt-2",
    isWorktreeTarget: true,
    peekChanged: true,
    peekWorktreeId: "wt-2",
    previousTargetKey: "worktree:wt-1",
    targetId: "wt-2",
  }), false);
});

test("reselecting the current Worktree refreshes its otherwise unwatched file list", () => {
  assert.equal(shouldReloadReselectedWorktree({
    currentTargetKey: "worktree:wt-1",
    isWorktreeTarget: true,
    peekChanged: true,
    peekWorktreeId: "wt-1",
    previousTargetKey: "worktree:wt-1",
    targetId: "wt-1",
  }), true);
});

test("a peek change for another Worktree does not refresh this panel", () => {
  assert.equal(shouldReloadReselectedWorktree({
    currentTargetKey: "worktree:wt-1",
    isWorktreeTarget: true,
    peekChanged: true,
    peekWorktreeId: "wt-2",
    previousTargetKey: "worktree:wt-1",
    targetId: "wt-1",
  }), false);
});
