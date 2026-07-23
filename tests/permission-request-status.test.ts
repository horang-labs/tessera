import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPermissionRequestEvent } from '@/lib/cli/permission-request-status';

test('Claude PermissionRequest maps to input_required with a command preview', () => {
  assert.deepEqual(
    classifyPermissionRequestEvent('PermissionRequest', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
    }),
    { status: 'input_required', preview: 'Bash: rm -rf build' },
  );
});

test('Codex PermissionRequest accepts its input payload variant', () => {
  assert.deepEqual(
    classifyPermissionRequestEvent('PermissionRequest', {
      tool_name: 'shell',
      input: { command: 'git push --force' },
    }),
    { status: 'input_required', preview: 'shell: git push --force' },
  );
});

test('PermissionRequest without tool details still marks input_required', () => {
  assert.deepEqual(
    classifyPermissionRequestEvent('PermissionRequest', {}),
    { status: 'input_required', preview: undefined },
  );
});

test('other hook events are ignored', () => {
  assert.equal(classifyPermissionRequestEvent('PreToolUse', { tool_name: 'Bash' }), null);
});
