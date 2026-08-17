import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requiresArchivedWorktreeRetentionConfirmation,
  shouldPruneArchivedWorktreesForSettingsUpdate,
} from '@/lib/settings/archived-worktree-retention';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';
import { useSettingsStore } from '@/stores/settings-store';

function retentionSettings(autoDelete: boolean, days: number) {
  return normalizeUserSettings({
    autoDeleteArchivedWorktrees: autoDelete,
    archivedWorktreeRetentionDays: days,
  });
}

test('archived Worktree retention keeps the legacy enabled seven-day default', () => {
  const settings = normalizeUserSettings({});

  assert.equal(settings.autoDeleteArchivedWorktrees, true);
  assert.equal(settings.archivedWorktreeRetentionDays, 7);
});

test('retention days stay within the supported one-to-365-day range', () => {
  assert.equal(normalizeUserSettings({ archivedWorktreeRetentionDays: 0 }).archivedWorktreeRetentionDays, 1);
  assert.equal(normalizeUserSettings({ archivedWorktreeRetentionDays: 999 }).archivedWorktreeRetentionDays, 365);
});

test('enabling auto-delete requires confirmation and triggers an immediate prune', () => {
  const previous = retentionSettings(false, 7);
  const next = retentionSettings(true, 7);

  assert.equal(requiresArchivedWorktreeRetentionConfirmation(previous, next), true);
  assert.equal(shouldPruneArchivedWorktreesForSettingsUpdate(previous, next), true);
});

test('shortening enabled retention requires confirmation and triggers an immediate prune', () => {
  const previous = retentionSettings(true, 30);
  const next = retentionSettings(true, 7);

  assert.equal(requiresArchivedWorktreeRetentionConfirmation(previous, next), true);
  assert.equal(shouldPruneArchivedWorktreesForSettingsUpdate(previous, next), true);
});

test('disabling auto-delete is immediate and never prunes', () => {
  const previous = retentionSettings(true, 7);
  const next = retentionSettings(false, 7);

  assert.equal(requiresArchivedWorktreeRetentionConfirmation(previous, next), false);
  assert.equal(shouldPruneArchivedWorktreesForSettingsUpdate(previous, next), false);
});

test('extending enabled retention needs no confirmation but refreshes retention state', () => {
  const previous = retentionSettings(true, 7);
  const next = retentionSettings(true, 30);

  assert.equal(requiresArchivedWorktreeRetentionConfirmation(previous, next), false);
  assert.equal(shouldPruneArchivedWorktreesForSettingsUpdate(previous, next), true);
});

test('changing retention while auto-delete is disabled never prunes', () => {
  const previous = retentionSettings(false, 7);
  const next = retentionSettings(false, 30);

  assert.equal(requiresArchivedWorktreeRetentionConfirmation(previous, next), false);
  assert.equal(shouldPruneArchivedWorktreesForSettingsUpdate(previous, next), false);
});

test('settings updates report save failure and restore the previous retention policy', async () => {
  const previousSettings = useSettingsStore.getState().settings;
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  const initial = retentionSettings(false, 30);
  useSettingsStore.setState({ settings: initial, pendingSaveCount: 0 });
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  console.error = () => {};

  try {
    const saved = await useSettingsStore.getState().updateSettings(
      { autoDeleteArchivedWorktrees: true },
      { confirmArchivedWorktreePrune: true },
    );

    assert.deepEqual(saved, { ok: false, status: 500, code: undefined });
    assert.equal(useSettingsStore.getState().settings.autoDeleteArchivedWorktrees, false);
    assert.equal(useSettingsStore.getState().settings.archivedWorktreeRetentionDays, 30);
  } finally {
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
    useSettingsStore.setState({ settings: previousSettings, pendingSaveCount: 0 });
  }
});

test('settings updates preserve the server confirmation code for stale-client recovery', async () => {
  const previousSettings = useSettingsStore.getState().settings;
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  const initial = retentionSettings(true, 30);
  useSettingsStore.setState({ settings: initial, pendingSaveCount: 0 });
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 'archived_worktree_retention_confirmation_required',
  }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  });
  console.error = () => {};

  try {
    const saved = await useSettingsStore.getState().updateSettings({
      managedWorktreePathTemplate: '/tmp/{project}/{branch}',
    });

    assert.deepEqual(saved, {
      ok: false,
      status: 409,
      code: 'archived_worktree_retention_confirmation_required',
    });
    assert.equal(useSettingsStore.getState().settings.managedWorktreePathTemplate,
      initial.managedWorktreePathTemplate);
  } finally {
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
    useSettingsStore.setState({ settings: previousSettings, pendingSaveCount: 0 });
  }
});

test('confirmed retention updates report success and send the confirmation control flag', async () => {
  const previousSettings = useSettingsStore.getState().settings;
  const previousFetch = globalThis.fetch;
  const initial = retentionSettings(false, 30);
  let requestBody: Record<string, unknown> | null = null;
  useSettingsStore.setState({ settings: initial, pendingSaveCount: 0 });
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response('{}', { status: 200 });
  };

  try {
    const saved = await useSettingsStore.getState().updateSettings(
      { autoDeleteArchivedWorktrees: true },
      { confirmArchivedWorktreePrune: true },
    );

    assert.deepEqual(saved, { ok: true });
    assert.equal(requestBody?.confirmArchivedWorktreePrune, true);
    assert.equal(useSettingsStore.getState().settings.autoDeleteArchivedWorktrees, true);
  } finally {
    globalThis.fetch = previousFetch;
    useSettingsStore.setState({ settings: previousSettings, pendingSaveCount: 0 });
  }
});
