import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderSkillStatusCard } from '@/components/settings/provider-skill-settings';

test('GUI presents provider skill health as optional and scoped to its owning environment', () => {
  const html = renderToStaticMarkup(createElement(ProviderSkillStatusCard, {
    status: {
      providerId: 'codex',
      detected: true,
      state: 'absent',
      consent: 'not-granted',
      ownership: 'none',
    },
    agentEnvironment: 'wsl',
    consented: false,
    pending: null,
    onConsentChange: () => {},
    onMutate: () => {},
  }));

  assert.match(html, /data-testid="provider-skill-codex"/);
  assert.match(html, /data-state="absent"/);
  assert.match(html, /Optional/);
  assert.match(html, /WSL Agent Environment/);
  assert.match(html, /New · consent needed/);
  assert.match(html, /Consent &amp; install/);
  assert.doesNotMatch(html, /OpenCode/);
});

test('GUI conflict recovery names only the owning provider and Agent Environment', () => {
  const html = renderToStaticMarkup(createElement(ProviderSkillStatusCard, {
    status: {
      providerId: 'claude-code',
      detected: true,
      state: 'conflict',
      consent: 'not-granted',
      ownership: 'user',
    },
    agentEnvironment: 'native',
    consented: false,
    pending: null,
    onConsentChange: () => {},
    onMutate: () => {},
  }));

  assert.match(html, /Claude Code has a user-owned or externally modified skill in the Native Agent Environment/);
  assert.doesNotMatch(html, /Codex has/);
  assert.doesNotMatch(html, /OpenCode/);
  assert.doesNotMatch(html, /Consent &amp; install/);
});

test('GUI reports an undetected provider independently without offering installation', () => {
  const html = renderToStaticMarkup(createElement(ProviderSkillStatusCard, {
    status: {
      providerId: 'opencode',
      detected: false,
      state: 'absent',
      consent: 'not-granted',
      ownership: 'none',
    },
    agentEnvironment: 'wsl',
    consented: false,
    pending: null,
    onConsentChange: () => {},
    onMutate: () => {},
  }));

  assert.match(html, /OpenCode/);
  assert.match(html, /Provider not detected/);
  assert.doesNotMatch(html, /New · consent needed/);
  assert.doesNotMatch(html, /Consent &amp; install/);
});
