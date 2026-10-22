import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionTabLabel } from '../src/components/chat/session-tab-label';
import { i18n } from '../src/lib/i18n';

for (const language of ['en', 'ko', 'ja', 'zh']) {
  test(`tab labels resolve in ${language}, including accessible descriptions`, async () => {
    await i18n.changeLanguage(language);
    assert.equal(renderToStaticMarkup(createElement(SessionTabLabel, { state: 'closed' })), '');
    for (const state of ['open', 'current'] as const) {
      const markup = renderToStaticMarkup(createElement(SessionTabLabel, { state }));
      assert.ok(markup.includes(i18n.t(`sessionTabs.${state}`)));
      assert.ok(markup.includes(`aria-label="${i18n.t(`sessionTabs.${state}Description`)}"`));
      assert.ok(!markup.includes('sessionTabs.'));
    }
    const group = renderToStaticMarkup(createElement(SessionTabLabel, { state: 'open', grouped: true }));
    assert.ok(group.includes(i18n.t('sessionTabs.containsOpen')));
    const hiddenCurrent = renderToStaticMarkup(createElement(SessionTabLabel, { state: 'current', grouped: true }));
    assert.ok(hiddenCurrent.includes(i18n.t('sessionTabs.containsCurrent')));
  });
}
