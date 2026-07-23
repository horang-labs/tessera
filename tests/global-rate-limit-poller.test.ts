import assert from 'node:assert/strict';
import test from 'node:test';
import { RateLimitPoller } from '../src/lib/rate-limit/poller';

test('polls and caches Claude and Codex limits globally without a session', async () => {
  const observedEnvironments: string[] = [];
  const poller = new RateLimitPoller({
    listProviders: () => [
      {
        getProviderId: () => 'claude-code',
        fetchRateLimits: async ({ environment }) => {
          observedEnvironments.push(environment);
          return {
            providerId: 'claude-code',
            windows: [],
            updatedAt: '2026-07-14T08:00:00.000Z',
          };
        },
      },
      {
        getProviderId: () => 'codex',
        fetchRateLimits: async ({ environment }) => {
          observedEnvironments.push(environment);
          return {
            providerId: 'codex',
            windows: [],
            updatedAt: '2026-07-14T08:00:00.000Z',
          };
        },
      },
    ],
  });
  const broadcasts: string[] = [];
  poller.setBroadcast((message) => broadcasts.push(message.providerId));
  poller.setEnvironmentResolver(() => 'wsl');

  await poller.start();
  poller.stop();

  assert.deepEqual(broadcasts.sort(), ['claude-code', 'codex']);
  assert.deepEqual(observedEnvironments, ['wsl', 'wsl']);
  assert.deepEqual(
    poller.getCachedSnapshots().map((snapshot) => snapshot.providerId).sort(),
    ['claude-code', 'codex'],
  );
});

test('schedules global provider refreshes every minute', async () => {
  let scheduledDelay = 0;
  const poller = new RateLimitPoller({
    listProviders: () => [],
    schedule: (_callback, delay) => {
      scheduledDelay = delay;
      return {} as NodeJS.Timeout;
    },
    clearSchedule: () => {},
  });

  await poller.start();
  poller.stop();

  assert.equal(scheduledDelay, 60_000);
});
