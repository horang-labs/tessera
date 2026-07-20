import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProviderUsageRailModel } from '../src/lib/status-display/provider-usage-rail';
import type { ProviderRateLimitsSnapshot } from '../src/lib/status-display/types';

test('maps existing five-hour and weekly windows into the compact rail model', () => {
  const snapshot: ProviderRateLimitsSnapshot = {
    providerId: 'codex',
    updatedAt: '2026-07-14T03:00:00.000Z',
    windows: [
      {
        key: 'secondary',
        usedPercent: 18.2,
        resetsAt: '2026-07-20T00:00:00.000Z',
        windowDurationMins: 10080,
      },
      {
        key: 'primary',
        usedPercent: 31.6,
        resetsAt: '2026-07-14T06:00:00.000Z',
        windowDurationMins: 300,
      },
    ],
  };

  assert.deepEqual(buildProviderUsageRailModel('codex', snapshot), {
    providerId: 'codex',
    shortTerm: {
      label: '5-hour limit',
      shortLabel: '5h',
      usedPercent: 32,
      resetsAt: '2026-07-14T06:00:00.000Z',
      severity: 'normal',
    },
    weekly: {
      label: 'Weekly limit',
      shortLabel: 'W',
      usedPercent: 18,
      resetsAt: '2026-07-20T00:00:00.000Z',
      severity: 'normal',
    },
  });
});

test('maps a provider four-hour window as the dynamic short-term limit', () => {
  const snapshot: ProviderRateLimitsSnapshot = {
    providerId: 'codex',
    windows: [
      {
        key: 'primary',
        usedPercent: 27,
        resetsAt: '2026-07-14T08:00:00.000Z',
        windowDurationMins: 240,
      },
      {
        key: 'secondary',
        usedPercent: 52,
        resetsAt: '2026-07-20T00:00:00.000Z',
        windowDurationMins: 10080,
      },
    ],
  };

  assert.deepEqual(buildProviderUsageRailModel('codex', snapshot).shortTerm, {
    label: '4-hour limit',
    shortLabel: '4h',
    usedPercent: 27,
    resetsAt: '2026-07-14T08:00:00.000Z',
    severity: 'normal',
  });
});

test('supports Claude keys, clamps percentages, and leaves unavailable windows empty', () => {
  const snapshot: ProviderRateLimitsSnapshot = {
    providerId: 'claude-code',
    windows: [
      {
        key: 'session',
        usedPercent: 120,
        resetsAt: null,
        windowDurationMins: null,
      },
    ],
  };

  const model = buildProviderUsageRailModel('claude-code', snapshot);
  assert.deepEqual(model.shortTerm, {
    label: 'Short-term limit',
    shortLabel: 'Short',
    usedPercent: 100,
    resetsAt: null,
    severity: 'danger',
  });
  assert.equal(model.weekly, null);
});

test('returns an empty always-renderable model before usage data arrives', () => {
  assert.deepEqual(buildProviderUsageRailModel('claude-code', null), {
    providerId: 'claude-code',
    shortTerm: null,
    weekly: null,
  });
});
