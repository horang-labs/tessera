import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function read(relativePath) {
  return fs.readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

test('Worktree settings and Archive expose the shared retention controls', () => {
  const settings = read('src/components/settings/worktree-settings.tsx');
  const archive = read('src/components/archive/archive-dashboard.tsx');
  const hook = read('src/hooks/use-worktree-retention-settings-update.tsx');

  assert.match(settings, /useWorktreeRetentionSettingsUpdate/);
  assert.match(settings, /id="autoDeleteArchivedWorktrees"/);
  assert.match(settings, /id="archivedWorktreeRetentionDays"/);
  assert.match(archive, /useWorktreeRetentionSettingsUpdate/);
  assert.match(archive, /archive\.autoLabel/);
  assert.match(hook, /confirmArchivedWorktreePrune/);
  assert.match(hook, /worktree-retention-confirm-dialog/);
});

test('settings API enforces confirmation and hands cleanup to the paced runner', () => {
  const route = read('src/app/api/settings/route.ts');

  assert.match(route, /requiresArchivedWorktreeRetentionConfirmation/);
  assert.match(route, /archived_worktree_retention_confirmation_required/);
  assert.match(route, /shouldPruneArchivedWorktreesForSettingsUpdate/);
  assert.match(route, /configureArchivedWorktreeRetention/);
  assert.match(route, /runImmediately: shouldPruneArchivedWorktreesForSettingsUpdate/);
  assert.doesNotMatch(route, /await pruneExpiredArchivedWorktrees/);
});

test('startup retention waits until the server is ready and runs one worktree per pass', () => {
  const server = read('server.ts');
  const runner = read('src/lib/archive/archive-retention-runner.ts');

  assert.doesNotMatch(server, /await pruneExpiredArchivedWorktrees/);
  assert.ok(
    server.indexOf('configureArchivedWorktreeRetention(startupRetentionPolicy)')
      > server.indexOf('wsServer.start(server)'),
  );
  assert.match(runner, /maxWorktreeAttempts: 1/);
  assert.match(runner, /options\.runImmediately \? 0 : IDLE_PASS_DELAY_MS/);
});

test('retention controls are registered for privacy-safe click telemetry', () => {
  const telemetry = read('src/lib/telemetry/ui-click.ts');
  const settings = read('src/components/settings/worktree-settings.tsx');
  const archive = read('src/components/archive/archive-dashboard.tsx');
  const hook = read('src/hooks/use-worktree-retention-settings-update.tsx');

  for (const control of [
    'settings.development.worktree_auto_delete',
    'settings.development.worktree_retention_days',
    'settings.development.worktree_retention_cancel',
    'settings.development.worktree_retention_confirm',
    'archive.auto_delete',
    'archive.retention_days',
  ]) {
    assert.match(telemetry, new RegExp(`'${control}'`));
  }

  assert.match(settings, /settingsTelemetryClickAttributes\('settings\.development\.worktree_auto_delete'\)/);
  assert.match(settings, /settingsTelemetryClickAttributes\('settings\.development\.worktree_retention_days'\)/);
  assert.match(archive, /telemetryClickAttributes\('archive\.auto_delete', 'archive'\)/);
  assert.match(archive, /telemetryClickAttributes\('archive\.retention_days', 'archive'\)/);
  assert.match(hook, /settings\.development\.worktree_retention_cancel/);
  assert.match(hook, /settings\.development\.worktree_retention_confirm/);
  assert.match(hook, /cancelTelemetry=\{dialogTelemetry\.cancel\}/);
  assert.match(hook, /confirmTelemetry=\{dialogTelemetry\.confirm\}/);
  assert.match(hook, /cancel: \{ control: 'archive\.dialog\.cancel', surface: 'archive' \}/);
  assert.match(hook, /confirm: \{ control: 'archive\.dialog\.confirm', surface: 'archive' \}/);
});

test('retention days are committed only after editing finishes', () => {
  const settings = read('src/components/settings/worktree-settings.tsx');
  const archive = read('src/components/archive/archive-dashboard.tsx');

  for (const source of [settings, archive]) {
    assert.match(source, /onChange=\{\(event\) => setRetentionDaysDraft\(event\.target\.value\)\}/);
    assert.match(source, /onBlur=\{\(\) => void commitRetentionDays\(\)\}/);
  }
});
