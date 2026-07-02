import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeCodeAdapter } from '../src/lib/cli/providers/claude-code/adapter';

// Fast mode is enabled via the `fastMode` settings boolean. In print mode it is
// passed at spawn with `--settings '{"fastMode":true}'`, merged into a SINGLE
// --settings object alongside ultracode (never two --settings flags). It is
// orthogonal to --effort.

function valuesOf(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
  }
  return out;
}

test('fastMode alone emits a single --settings {"fastMode":true}', () => {
  const args = claudeCodeAdapter.getCliArgs({
    sessionId: '11111111-1111-1111-1111-111111111111',
    model: 'claude-opus-4-8',
    fastMode: true,
  });
  const settings = valuesOf(args, '--settings');
  assert.equal(settings.length, 1, `expected one --settings; got: ${args.join(' ')}`);
  assert.equal(JSON.parse(settings[0]).fastMode, true);
});

test('fastMode + ultracode merge into ONE --settings object', () => {
  const args = claudeCodeAdapter.getCliArgs({
    sessionId: '22222222-2222-2222-2222-222222222222',
    model: 'claude-opus-4-8',
    reasoningEffort: 'ultracode',
    fastMode: true,
  });
  const settings = valuesOf(args, '--settings');
  assert.equal(settings.length, 1, `expected one merged --settings; got: ${args.join(' ')}`);
  const parsed = JSON.parse(settings[0]);
  assert.equal(parsed.ultracode, true);
  assert.equal(parsed.fastMode, true);
  assert.ok(!valuesOf(args, '--effort').includes('ultracode'));
});

test('fastMode + plain effort merge into ONE --settings object, no --effort flag', () => {
  const args = claudeCodeAdapter.getCliArgs({
    sessionId: '33333333-3333-3333-3333-333333333333',
    model: 'claude-opus-4-8',
    reasoningEffort: 'high',
    fastMode: true,
  });
  assert.equal(valuesOf(args, '--effort').length, 0, `plain effort must ride --settings; got: ${args.join(' ')}`);
  const settings = valuesOf(args, '--settings');
  assert.equal(settings.length, 1);
  assert.equal(JSON.parse(settings[0]).fastMode, true);
  assert.equal(JSON.parse(settings[0]).effortLevel, 'high');
  assert.equal(JSON.parse(settings[0]).ultracode, undefined);
});

test('no fastMode and no ultracode: no --settings injected', () => {
  const args = claudeCodeAdapter.getCliArgs({
    sessionId: '44444444-4444-4444-4444-444444444444',
    model: 'claude-opus-4-8',
    reasoningEffort: 'auto',
  });
  assert.equal(valuesOf(args, '--settings').length, 0);
});
