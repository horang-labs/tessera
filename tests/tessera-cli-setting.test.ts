import assert from 'node:assert/strict';
import test from 'node:test';
import { prependPendingTesseraCliSkill } from '@/lib/control/pending-tessera-cli-skill';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';
import { useCommandStore } from '@/stores/command-store';
import { useSettingsStore } from '@/stores/settings-store';

test('Tessera CLI injection defaults off and only accepts an explicit boolean true', () => {
  assert.equal(normalizeUserSettings({}).tesseraCliEnabled, false);
  assert.equal(normalizeUserSettings({ tesseraCliEnabled: true }).tesseraCliEnabled, true);
  assert.equal(normalizeUserSettings({ tesseraCliEnabled: false }).tesseraCliEnabled, false);
  assert.equal(
    normalizeUserSettings({ tesseraCliEnabled: 'true' as unknown as boolean }).tesseraCliEnabled,
    false,
  );
});

test('fresh GUI sessions advertise the provider-specific Tessera CLI command when enabled', () => {
  const existingSkills = [{ name: 'repo-skill', description: 'Repository skill' }];

  for (const [providerId, expectedName] of [
    ['codex', 'tessera-cli'],
    ['claude-code', 'tessera:tessera-cli'],
    ['opencode', 'tessera-cli'],
  ] as const) {
    const skills = prependPendingTesseraCliSkill(existingSkills, {
      providerId,
      enabled: true,
      hasProcess: false,
    });

    assert.equal(skills[0]?.name, expectedName, providerId);
    assert.match(skills[0]?.description ?? '', /Tessera-managed Projects/, providerId);
    assert.equal(skills.some((skill) => skill.name === 'repo-skill'), true, providerId);
  }
});

test('pending discovery follows the setting without rewriting a running catalog', () => {
  const providerSkills = [{ name: 'repo-skill', description: 'Repository skill' }];

  assert.strictEqual(
    prependPendingTesseraCliSkill(providerSkills, {
      providerId: 'codex',
      enabled: false,
      hasProcess: false,
    }),
    providerSkills,
  );
  assert.strictEqual(
    prependPendingTesseraCliSkill(providerSkills, {
      providerId: 'claude-code',
      enabled: true,
      hasProcess: true,
    }),
    providerSkills,
  );
});

test('pending discovery de-duplicates an identically named provider skill', () => {
  const skills = prependPendingTesseraCliSkill([
    { name: 'tessera-cli', description: 'Stale provider copy' },
    { name: 'repo-skill', description: 'Repository skill' },
  ], {
    providerId: 'codex',
    enabled: true,
    hasProcess: false,
  });

  assert.equal(skills.filter((skill) => skill.name === 'tessera-cli').length, 1);
  assert.match(skills[0]?.description ?? '', /Tessera-managed Projects/);
});

test('saving the Tessera CLI toggle invalidates already-cached GUI skill catalogs', async () => {
  const previousSettings = useSettingsStore.getState().settings;
  const previousFetch = globalThis.fetch;
  useCommandStore.getState().setCommands('pending-session', [{
    name: 'cached-before-toggle',
    description: 'Stale catalog',
  }]);
  globalThis.fetch = async () => new Response('{}', { status: 200 });

  try {
    useSettingsStore.setState({
      settings: normalizeUserSettings({
        ...previousSettings,
        tesseraCliEnabled: false,
      }),
    });
    const previousRevision = useCommandStore.getState().catalogRevision;

    await useSettingsStore.getState().updateSettings({ tesseraCliEnabled: true });

    assert.deepEqual(useCommandStore.getState().commands, {});
    assert.equal(useCommandStore.getState().catalogRevision, previousRevision + 1);
  } finally {
    globalThis.fetch = previousFetch;
    useSettingsStore.setState({ settings: previousSettings, pendingSaveCount: 0 });
    useCommandStore.getState().clearSession('pending-session');
  }
});
