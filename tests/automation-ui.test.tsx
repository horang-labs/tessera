import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnershipActions } from '../src/components/automation/ownership-actions';
import { ownershipFixture } from './fixtures/automation';

test('Pause and Delete remain exposed in every locked ownership state', () => {
  for (const mode of ['armed', 'draining', 'recovery-required', 'unavailable'] as const) {
    const html = renderToStaticMarkup(createElement(OwnershipActions, {
      ownership: { ...ownershipFixture(), mode, reason: 'APPROVAL_REQUIRED' },
      automationId: 'rule-1', onPause: () => {}, onDelete: () => {},
    }));
    assert.match(html, /Pause to type/);
    assert.match(html, /Delete automation/);
    assert.doesNotMatch(html, /disabled="|Human input available/);
    assert.match(html, /APPROVAL_REQUIRED/);
  }
});

test('wake form starts opt-in with bounded defaults and leaves the saved prompt empty', async () => {
  const { AutomationForm } = await import('../src/components/automation/automation-form');
  const html = renderToStaticMarkup(createElement(AutomationForm, { scope: { sessionId: 'session-1' }, onSave: async () => true, onCancel: () => {} }));
  assert.match(html, /value="120"/);
  assert.match(html, /value="10"/);
  assert.match(html, /Save disabled/);
  assert.match(html, /<textarea[^>]*><\/textarea>/);
  assert.doesNotMatch(html, /type="checkbox" checked/);
});

test('history distinguishes delivered prompts from task success and offers no-retry recovery', async () => {
  const { AutomationHistory } = await import('../src/components/automation/automation-history');
  const { runFixture } = await import('./fixtures/automation');
  const html = renderToStaticMarkup(createElement(AutomationHistory, {
    runs: [{ ...runFixture(), state: 'delivered' }, { ...runFixture(), id: 'uncertain', state: 'unknown', reason: 'WRITER_UNCERTAIN' }],
    onResolve: () => {}, onOpenSession: () => {},
  }));
  assert.match(html, /Prompt delivered/);
  assert.match(html, /do not mean the task succeeded/);
  assert.match(html, /Take manual control/);
  assert.match(html, /WRITER_UNCERTAIN/);
  assert.match(html, /Open Session/);
  assert.match(html, /Inherited from CLI/);
});
