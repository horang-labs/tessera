import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAUDE_MODELS,
  buildClaudeSessionOptions,
} from '../src/lib/cli/provider-session-option-definitions';
import {
  normalizeClaudeModel,
  resolveProviderModelOption,
} from '../src/lib/settings/provider-defaults';

const byValue = (value: string) => CLAUDE_MODELS.find((m) => m.value === value);
const effortValues = (value: string) =>
  (byValue(value)?.supportedReasoningEfforts ?? []).map((e) => e.value);

test('Opus 4.8 models are present and 4.8[1m] is the sole default', () => {
  assert.ok(byValue('claude-opus-4-8'), 'claude-opus-4-8 missing');
  assert.ok(byValue('claude-opus-4-8[1m]'), 'claude-opus-4-8[1m] missing');

  const defaults = CLAUDE_MODELS.filter((m) => m.isDefault).map((m) => m.value);
  assert.deepEqual(defaults, ['claude-opus-4-8[1m]'], `expected only 4.8[1m] default; got ${defaults}`);
});

test('Opus 4.8 exposes ultracode at the TOP of the effort ladder, with the full ladder', () => {
  for (const m of ['claude-opus-4-8', 'claude-opus-4-8[1m]']) {
    const efforts = effortValues(m);
    assert.equal(efforts[0], 'ultracode', `ultracode must be the first effort option for ${m}; got ${efforts}`);
    for (const required of ['auto', 'low', 'medium', 'high', 'xhigh', 'max']) {
      assert.ok(efforts.includes(required), `${m} effort ladder missing ${required}; got ${efforts}`);
    }
  }
});

test('Opus 4.7 also offers ultracode (it supports xhigh)', () => {
  assert.ok(effortValues('claude-opus-4-7').includes('ultracode'));
  assert.ok(effortValues('claude-opus-4-7[1m]').includes('ultracode'));
});

test('models without xhigh support do NOT offer ultracode', () => {
  for (const m of ['claude-opus-4-6', 'claude-opus-4-6[1m]', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) {
    assert.ok(!effortValues(m).includes('ultracode'), `${m} must not offer ultracode`);
  }
});

test('the `opus` alias resolves to Opus 4.8 (1m)', () => {
  assert.equal(normalizeClaudeModel('opus'), 'claude-opus-4-8[1m]');
});

test('an unlisted Claude model is preserved as a custom option (escape hatch)', () => {
  const sessionOptions = buildClaudeSessionOptions();
  const option = resolveProviderModelOption('claude-code', sessionOptions, 'claude-future-9-9');
  assert.ok(option, 'expected a resolved option');
  assert.equal(option.value, 'claude-future-9-9', 'custom model must be preserved, not snapped to default');
});
