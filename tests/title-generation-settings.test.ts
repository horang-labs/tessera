import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';

test('new installations refine the immediate local title with AI', () => {
  assert.equal(normalizeUserSettings({}).notifications.aiTitleRefinement, true);
});

test('an explicit opt-out survives normalization', () => {
  assert.equal(
    normalizeUserSettings({
      notifications: { soundEnabled: true, showToast: true, aiTitleRefinement: false },
    }).notifications.aiTitleRefinement,
    false,
  );
});

test('AI refinement stays on when the option is explicitly enabled', () => {
  const settings = normalizeUserSettings({
    notifications: { soundEnabled: true, showToast: true, aiTitleRefinement: true },
  });

  assert.equal(settings.notifications.aiTitleRefinement, true);
});
