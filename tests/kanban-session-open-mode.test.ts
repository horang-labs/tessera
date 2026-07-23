import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';

test('new installations open Kanban sessions in Peek by default', () => {
  assert.equal(normalizeUserSettings({}).kanbanSessionOpenMode, 'peek');
});

test('split is preserved as a valid Kanban session open mode', () => {
  assert.equal(
    normalizeUserSettings({ kanbanSessionOpenMode: 'split' }).kanbanSessionOpenMode,
    'split',
  );
});

test('unknown Kanban session open modes fall back to Peek', () => {
  assert.equal(
    normalizeUserSettings({ kanbanSessionOpenMode: 'drawer' as never }).kanbanSessionOpenMode,
    'peek',
  );
});
