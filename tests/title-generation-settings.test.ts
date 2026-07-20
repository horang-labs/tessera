import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';

test('new installations use the immediate local title without AI refinement', () => {
  assert.equal(normalizeUserSettings({}).notifications.aiTitleRefinement, false);
});

test('the old automatic-title default does not opt existing users into AI refinement', () => {
  assert.equal(
    normalizeUserSettings({
      notifications: { soundEnabled: true, showToast: true, autoGenerateTitle: true },
    } as never).notifications.aiTitleRefinement,
    false,
  );
});

test('AI refinement runs only after the new option is explicitly enabled', () => {
  const settings = normalizeUserSettings({
    notifications: { soundEnabled: true, showToast: true, aiTitleRefinement: true },
  });

  assert.equal(settings.notifications.aiTitleRefinement, true);
});
