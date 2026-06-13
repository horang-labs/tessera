import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeCodeAdapter } from '../src/lib/cli/providers/claude-code/adapter';

// Ultracode is NOT a valid --effort value (the CLI rejects `--effort ultracode`
// with "Unknown --effort value"). It is enabled via the `ultracode` settings
// boolean, which in print mode is passed with `--settings '{"ultracode":true}'`.

function valuesOf(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
  }
  return out;
}

test('ultracode effort emits --settings ultracode, never --effort ultracode', () => {
  const args = claudeCodeAdapter.getCliArgs({
    sessionId: '11111111-1111-1111-1111-111111111111',
    model: 'claude-opus-4-8',
    reasoningEffort: 'ultracode',
  });

  assert.ok(
    !valuesOf(args, '--effort').includes('ultracode'),
    `must not pass --effort ultracode; got: ${args.join(' ')}`,
  );

  const settings = valuesOf(args, '--settings');
  assert.equal(settings.length, 1, `expected exactly one --settings; got: ${args.join(' ')}`);
  const parsed = JSON.parse(settings[0]);
  assert.equal(parsed.ultracode, true, `--settings JSON must set ultracode:true; got: ${settings[0]}`);
});

test('ordinary effort levels still use the --effort flag', () => {
  const args = claudeCodeAdapter.getCliArgs({
    sessionId: '22222222-2222-2222-2222-222222222222',
    model: 'claude-opus-4-8',
    reasoningEffort: 'xhigh',
  });
  assert.deepEqual(valuesOf(args, '--effort'), ['xhigh']);
  assert.equal(valuesOf(args, '--settings').length, 0, 'plain effort must not inject --settings');
});

test('auto effort passes neither --effort nor an ultracode --settings', () => {
  const args = claudeCodeAdapter.getCliArgs({
    sessionId: '33333333-3333-3333-3333-333333333333',
    model: 'claude-opus-4-8',
    reasoningEffort: 'auto',
  });
  assert.equal(valuesOf(args, '--effort').length, 0);
  assert.equal(valuesOf(args, '--settings').length, 0);
});
