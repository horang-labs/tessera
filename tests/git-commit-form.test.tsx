import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GitCommitForm } from '../src/components/git/git-commit-form';
import type { GitPrimaryAction } from '../src/lib/git/primary-git-action';

const commitAction: GitPrimaryAction = {
  kind: 'commit',
  action: 'commit',
  enabled: true,
  labelKey: 'gitPanel.commit.button',
  pendingLabelKey: 'gitPanel.commit.buttonPending',
  disabledReasonKey: null,
};

test('commit message generation is attached to the message input rather than the footer', () => {
  const markup = renderToStaticMarkup(createElement(GitCommitForm, {
    pendingVerb: null,
    generateError: null,
    generating: false,
    message: '',
    onCommit: () => {},
    onGenerate: () => {},
    onMessageChange: () => {},
    primaryAction: commitAction,
    totals: { files: 3, added: 20, removed: 14 },
  }));

  assert.match(
    markup,
    /data-testid="git-commit-message-shell"[^>]*>[\s\S]*data-testid="git-commit-message"[\s\S]*data-testid="git-commit-generate-button"[\s\S]*<\/div>/,
  );

  const footer = markup.match(/data-testid="git-commit-footer"[^>]*>([\s\S]*)<\/div><\/div>$/)?.[1] ?? '';
  assert.doesNotMatch(footer, /data-testid="git-commit-generate-button"/);
});
