import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';

test('Agent status hooks default enabled and preserve an explicit opt-out', () => {
  assert.equal(normalizeUserSettings({}).codexLifecycleHooksEnabled, true);
  assert.equal(normalizeUserSettings({ codexLifecycleHooksEnabled: false }).codexLifecycleHooksEnabled, false);
});

test('both server runtimes reconcile hooks at startup', () => {
  for (const relativePath of ['server.ts', 'electron/server-child.ts']) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
    assert.match(source, /reconcileCodexLifecycleForUserSoon\(userId, settings\.codexLifecycleHooksEnabled\)/);
  }
});

test('Agent Environment and hook-toggle changes schedule reconciliation', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/app/api/settings/route.ts'),
    'utf8',
  );
  assert.match(source, /agentEnvironmentChanged\s*\|\|\s*previousSettings\.codexLifecycleHooksEnabled !== settings\.codexLifecycleHooksEnabled/);
  assert.match(source, /reconcileCodexLifecycleForUserSoon\(userId, settings\.codexLifecycleHooksEnabled\)/);
});
