import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';

test('existing users keep the split Kanban session layout by default', () => {
  assert.equal(normalizeUserSettings({}).kanbanSessionOpenMode, 'split');
});

test('Peek is preserved as a valid Kanban session open mode', () => {
  assert.equal(
    normalizeUserSettings({ kanbanSessionOpenMode: 'peek' }).kanbanSessionOpenMode,
    'peek',
  );
});

test('unknown Kanban session open modes fall back to split view', () => {
  assert.equal(
    normalizeUserSettings({ kanbanSessionOpenMode: 'drawer' as never }).kanbanSessionOpenMode,
    'split',
  );
});
