import assert from 'node:assert/strict';
import test from 'node:test';
import type { GhRunner } from '@/lib/github/gh-cli';
import {
  getTesseraRepositoryStarStatus,
  starTesseraRepository,
} from '@/lib/github/repository-star';

function fakeGhResult(
  result: Awaited<ReturnType<GhRunner>>,
  calls: string[][],
): GhRunner {
  return async (args) => {
    calls.push(args);
    return result;
  };
}

test('repository star status distinguishes starred, unstarred, and unavailable', async () => {
  const fixtures: Array<{
    result: Awaited<ReturnType<GhRunner>>;
    expected: 'starred' | 'unstarred' | 'unavailable';
  }> = [
    {
      result: { exitCode: 0, stdout: 'HTTP/2.0 204 No Content', stderr: '' },
      expected: 'starred',
    },
    {
      result: { exitCode: 0, stdout: 'HTTP/1.1 200 OK', stderr: '' },
      expected: 'starred',
    },
    {
      result: { exitCode: 0, stdout: '', stderr: '' },
      expected: 'unavailable',
    },
    {
      result: { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' },
      expected: 'unstarred',
    },
    {
      result: { exitCode: 1, stdout: '', stderr: 'gh auth login required' },
      expected: 'unavailable',
    },
    {
      result: { exitCode: null, stdout: '', stderr: 'spawn gh ENOENT', timedOut: false },
      expected: 'unavailable',
    },
    {
      result: { exitCode: null, stdout: '', stderr: 'timed out', timedOut: true },
      expected: 'unavailable',
    },
  ];

  for (const fixture of fixtures) {
    const calls: string[][] = [];
    const actual = await getTesseraRepositoryStarStatus(fakeGhResult(fixture.result, calls));
    assert.equal(actual, fixture.expected);
    assert.deepEqual(calls, [[
      'api',
      '--hostname',
      'github.com',
      '--include',
      'user/starred/horang-labs/tessera',
    ]]);
  }
});

test('repository star uses the fixed idempotent GitHub endpoint', async () => {
  const successfulCalls: string[][] = [];
  const failedCalls: string[][] = [];

  assert.equal(await starTesseraRepository(fakeGhResult(
    { exitCode: 0, stdout: '', stderr: '' },
    successfulCalls,
  )), true);
  assert.equal(await starTesseraRepository(fakeGhResult(
    { exitCode: 1, stdout: '', stderr: 'Forbidden (HTTP 403)' },
    failedCalls,
  )), false);

  const expected = [[
    'api',
    '--hostname',
    'github.com',
    '--method',
    'PUT',
    'user/starred/horang-labs/tessera',
  ]];
  assert.deepEqual(successfulCalls, expected);
  assert.deepEqual(failedCalls, expected);
});
