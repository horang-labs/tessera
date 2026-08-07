import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBranchedWorktreeSlug,
  buildManagedWorktreeCollisionSlug,
} from '../src/lib/worktrees/naming';

test('buildBranchedWorktreeSlug derives the new slug from the source branch', () => {
  assert.equal(buildBranchedWorktreeSlug('feature/0803-kq', 'k3'), '0803-kq-bk3');
});

test('buildBranchedWorktreeSlug drops the branch prefix, however deep it is', () => {
  assert.equal(buildBranchedWorktreeSlug('team/feature/0803-kq', 'x1'), '0803-kq-bx1');
  assert.equal(buildBranchedWorktreeSlug('0803-kq', 'x1'), '0803-kq-bx1');
});

test('buildBranchedWorktreeSlug keeps stacking markers when branching a branch', () => {
  const first = buildBranchedWorktreeSlug('feature/0803-kq', 'k3');
  assert.equal(buildBranchedWorktreeSlug(`feature/${first}`, '7z'), '0803-kq-bk3-b7z');
});

test('buildBranchedWorktreeSlug normalizes characters git would not take', () => {
  assert.equal(buildBranchedWorktreeSlug('feature/Fix Login!', 'a2'), 'fix-login-ba2');
});

test('buildBranchedWorktreeSlug falls back to a dated slug when the branch yields nothing', () => {
  assert.match(buildBranchedWorktreeSlug('///', 'a2'), /^\d{4}-[a-z0-9]{2}$/);
});

test('the branch marker stays distinguishable from a plain name collision', () => {
  // A collision appends -2; branching appends -b<random>. Reading a branch name
  // has to tell the two apart, so the marker must never collapse into a digit.
  const collided = buildManagedWorktreeCollisionSlug('0803-kq', 1);
  const branched = buildBranchedWorktreeSlug('feature/0803-kq', 'k3');
  assert.equal(collided, '0803-kq-2');
  assert.notEqual(collided, branched);
  assert.match(branched, /-b[a-z0-9]{1,2}$/);
});
