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
  assert.equal(parsed.effortLevel, undefined, 'ultracode implies xhigh; effortLevel must stay unset');
});

test('ordinary effort levels ride --settings effortLevel, not the --effort flag', () => {
  // The --effort flag outranks apply_flag_settings for the process lifetime,
  // which would turn runtime effort changes into silent no-ops.
  const args = claudeCodeAdapter.getCliArgs({
    sessionId: '22222222-2222-2222-2222-222222222222',
    model: 'claude-opus-4-8',
    reasoningEffort: 'xhigh',
  });
  assert.equal(valuesOf(args, '--effort').length, 0, `plain effort must not use --effort; got: ${args.join(' ')}`);
  const settings = valuesOf(args, '--settings');
  assert.equal(settings.length, 1);
  const parsed = JSON.parse(settings[0]);
  assert.equal(parsed.effortLevel, 'xhigh');
  assert.equal(parsed.ultracode, undefined);
});

test('max is the exception: spawn-only --effort flag, no effortLevel setting', () => {
  // The CLI's effortLevel settings enum stops at xhigh; max only exists as
  // --effort. Such sessions cannot change effort at runtime.
  const args = claudeCodeAdapter.getCliArgs({
    sessionId: '44444444-4444-4444-4444-444444444444',
    model: 'claude-opus-4-8',
    reasoningEffort: 'max',
  });
  assert.deepEqual(valuesOf(args, '--effort'), ['max']);
  assert.equal(valuesOf(args, '--settings').length, 0, `max must not inject --settings; got: ${args.join(' ')}`);
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
