import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveSessionTabOpenMode,
  shouldReleasePreviewRuntime,
} from '@/lib/terminal/terminal-preview-policy';

test('only an already-running PTY session bypasses preview mode', () => {
  assert.equal(resolveSessionTabOpenMode({ kind: 'terminal', isRunning: true }), 'pinned');
  assert.equal(resolveSessionTabOpenMode({ kind: 'terminal', isRunning: false }), 'preview');
  assert.equal(resolveSessionTabOpenMode({ kind: 'chat', isRunning: true }), 'preview');
  assert.equal(resolveSessionTabOpenMode({ kind: 'chat', isRunning: false }), 'preview');
});

test('a preview release matches only the PTY runtime it started', () => {
  assert.equal(shouldReleasePreviewRuntime({
    runtimeOwnerToken: 'preview-a',
    previewOwnerToken: 'preview-a',
  }), true);
  assert.equal(shouldReleasePreviewRuntime({
    runtimeOwnerToken: 'preview-a',
    previewOwnerToken: 'preview-b',
  }), false);
  assert.equal(shouldReleasePreviewRuntime({
    runtimeOwnerToken: undefined,
    previewOwnerToken: 'preview-a',
  }), false);
});
