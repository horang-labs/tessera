import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GitConflictResolveWithAiButton } from '@/components/git/git-conflict-ai-button';

test('Resolve with AI is a separately named draft action with a visible review boundary', () => {
  const html = renderToStaticMarkup(
    <GitConflictResolveWithAiButton
      label="Resolve with AI"
      description="Prepare an editable request for this session. You review it before sending."
      pending={false}
      pendingLabel="Preparing request…"
      onPrepare={() => {}}
    />,
  );

  assert.match(html, /data-testid="git-conflict-resolve-with-ai"/);
  assert.match(html, />Resolve with AI</);
  assert.match(html, /You review it before sending/);
  assert.doesNotMatch(html, / disabled=""/);
});

test('only the AI draft action disables while its handoff is being prepared', () => {
  const html = renderToStaticMarkup(
    <GitConflictResolveWithAiButton
      label="Resolve with AI"
      description="Prepare a request"
      pending
      pendingLabel="Preparing request…"
      onPrepare={() => {}}
    />,
  );

  assert.match(html, / disabled=""/);
  assert.match(html, />Preparing request…</);
});
