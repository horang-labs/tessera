import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeCodeAdapter } from '@/lib/cli/providers/claude-code/adapter';
import { codexAdapter } from '@/lib/cli/providers/codex/adapter';
import { opencodeAdapter } from '@/lib/cli/providers/opencode/adapter';

test('only Codex requests resize-scoped ED3 scrollback protection', () => {
  assert.equal(claudeCodeAdapter.getTerminalResizeScrollbackPolicy(), 'native');
  assert.equal(codexAdapter.getTerminalResizeScrollbackPolicy(), 'preserve-on-ed3');
  assert.equal(opencodeAdapter.getTerminalResizeScrollbackPolicy(), 'native');
});
