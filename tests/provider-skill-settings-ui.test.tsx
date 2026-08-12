import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  consumeTesseraCliCompletion,
  TesseraCliSkillStatusBadge,
} from '@/components/settings/provider-skill-settings';

for (const [state, label] of [
  ['not-installed', 'Not installed'],
  ['installed', 'Installed'],
  ['update-available', 'Update available'],
  ['setup-failed', 'Setup failed'],
  ['conflict', 'Conflict'],
] as const) {
  test(`Orca-style tessera-cli setup presents the ${state} state`, () => {
    const html = renderToStaticMarkup(createElement(TesseraCliSkillStatusBadge, { state }));
    assert.match(html, new RegExp(`data-state="${state}"`));
    assert.match(html, new RegExp(label));
  });
}

test('Orca-style tessera-cli setup presents its checking state', () => {
  const html = renderToStaticMarkup(createElement(TesseraCliSkillStatusBadge, {
    state: 'not-installed',
    pending: true,
  }));
  assert.match(html, /Checking/);
});

test('inline setup rescans from a command completion split across PTY chunks', () => {
  const first = consumeTesseraCliCompletion('', '\u001b]9;tessera-skill-');
  assert.equal(first.exitCode, undefined);
  assert.equal(consumeTesseraCliCompletion(first.buffered, 'done:0\u0007').exitCode, 0);
});

test('a failed setup offers Retry before opening another terminal', async () => {
  const source = await readFile('src/components/settings/provider-skill-settings.tsx', 'utf8');
  assert.match(source, /state === 'setup-failed' \? 'Retry'/);
});

test('Settings and onboarding reuse the Press Enter setup panel with up-to-date state', async () => {
  const [panel, onboarding, container] = await Promise.all([
    readFile('src/components/settings/provider-skill-settings.tsx', 'utf8'),
    readFile('src/lib/cli/provider-skill-onboarding.ts', 'utf8'),
    readFile('src/components/notifications/toast-container.tsx', 'utf8'),
  ]);
  assert.match(panel, /Press Enter to run this command/);
  assert.match(panel, /installed skill is up to date/);
  assert.match(panel, /<TesseraCliSkillSetupPanel \/>/);
  assert.match(onboarding, /useProviderSkillOnboardingStore\.getState\(\)\.open/);
  assert.match(container, /<TesseraCliSkillOnboardingDialog \/>/);
});

test('skill setup supports insecure remote browser contexts', async () => {
  const source = await readFile('src/components/settings/provider-skill-settings.tsx', 'utf8');
  assert.match(source, /typeof crypto !== 'undefined' && typeof crypto\.randomUUID === 'function'/);
  assert.match(source, /!navigator\.clipboard\?\.writeText/);
});
