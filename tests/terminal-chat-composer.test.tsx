import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TerminalChatCancelButton } from '@/components/chat/terminal-chat-composer';
import { i18n } from '@/lib/i18n';

test('working terminal chat view visibly advertises Escape cancellation', async () => {
  const previousLanguage = i18n.language;
  await i18n.changeLanguage('en');

  try {
    const html = renderToStaticMarkup(createElement(TerminalChatCancelButton, {
      onCancel: () => undefined,
    }));

    assert.match(html, /data-testid="terminal-chat-cancel"/);
    assert.match(html, /Cancel \(ESC\)/);
    assert.match(html, />ESC<\/span>/);
  } finally {
    await i18n.changeLanguage(previousLanguage);
  }
});
