import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';
import { resolveQuickCreateInitialMode } from '@/components/chat/collection-quick-create-sheet';

test('new installations start session creation on the worktree entry', () => {
  assert.equal(normalizeUserSettings({}).defaultNewSessionKind, 'task');
});

test('a persisted chat default survives normalization', () => {
  assert.equal(
    normalizeUserSettings({ defaultNewSessionKind: 'chat' }).defaultNewSessionKind,
    'chat',
  );
});

test('invalid persisted session kinds normalize to the worktree default', () => {
  assert.equal(
    normalizeUserSettings({ defaultNewSessionKind: 'worktree' as never }).defaultNewSessionKind,
    'task',
  );
});

test('the quick-create sheet follows the setting when the caller has no opinion', () => {
  const both: Array<'chat' | 'task'> = ['chat', 'task'];
  assert.equal(
    resolveQuickCreateInitialMode({
      initialMode: undefined,
      defaultNewSessionKind: 'task',
      availableModes: both,
      allowedModes: both,
    }),
    'task',
  );
  assert.equal(
    resolveQuickCreateInitialMode({
      initialMode: undefined,
      defaultNewSessionKind: 'chat',
      availableModes: both,
      allowedModes: both,
    }),
    'chat',
  );
});

test('an explicit caller mode outranks the setting', () => {
  const both: Array<'chat' | 'task'> = ['chat', 'task'];
  assert.equal(
    resolveQuickCreateInitialMode({
      initialMode: 'chat',
      defaultNewSessionKind: 'task',
      availableModes: both,
      allowedModes: both,
    }),
    'chat',
  );
});

test('a worktree default degrades to chat where tasks cannot be created', () => {
  assert.equal(
    resolveQuickCreateInitialMode({
      initialMode: undefined,
      defaultNewSessionKind: 'task',
      availableModes: ['chat'],
      allowedModes: ['chat', 'task'],
    }),
    'chat',
  );
  assert.equal(
    resolveQuickCreateInitialMode({
      initialMode: undefined,
      defaultNewSessionKind: 'task',
      availableModes: ['chat', 'task'],
      allowedModes: ['chat'],
    }),
    'chat',
  );
});
