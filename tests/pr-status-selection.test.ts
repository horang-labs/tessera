import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePullRequestCandidates,
  selectRepresentativePullRequest,
  type HeadContainment,
  type PullRequestCandidate,
} from '@/lib/github/pr-status-selection';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);

function candidate(
  number: number,
  state: PullRequestCandidate['state'],
  options: Partial<PullRequestCandidate> = {},
): PullRequestCandidate {
  return {
    number,
    state,
    url: `https://github.com/horang-labs/tessera/pull/${number}`,
    updatedAt: `2026-08-${String(number).padStart(2, '0')}T00:00:00Z`,
    headRefOid: OLD_HEAD,
    ...options,
  };
}

function topology(result: HeadContainment) {
  return async () => result;
}

test('an open PR wins regardless of SHA or newer terminal PRs', async () => {
  const selected = await selectRepresentativePullRequest(
    [
      candidate(1, 'open', { headRefOid: undefined }),
      candidate(2, 'merged', { updatedAt: '2026-09-01T00:00:00Z' }),
    ],
    HEAD,
    topology('not_contains'),
  );

  assert.equal(selected.kind, 'selected');
  if (selected.kind !== 'selected') return;
  assert.equal(selected.candidate.number, 1);
  assert.equal(selected.relation, 'current');
});

test('a merged PR is current when it contains the current HEAD', async () => {
  const selected = await selectRepresentativePullRequest(
    [candidate(2, 'merged')],
    HEAD,
    topology('contains'),
  );

  assert.equal(selected.kind, 'selected');
  if (selected.kind !== 'selected') return;
  assert.equal(selected.relation, 'current');
});

test('a merged PR becomes historical after new or diverged work', async () => {
  const selected = await selectRepresentativePullRequest(
    [candidate(2, 'merged')],
    HEAD,
    topology('not_contains'),
  );

  assert.equal(selected.kind, 'selected');
  if (selected.kind !== 'selected') return;
  assert.equal(selected.relation, 'historical');
});

test('closed PRs are historical even at the same SHA', async () => {
  let topologyCalls = 0;
  const selected = await selectRepresentativePullRequest(
    [candidate(3, 'closed', { headRefOid: HEAD })],
    HEAD,
    async () => {
      topologyCalls += 1;
      return 'contains';
    },
  );

  assert.equal(selected.kind, 'selected');
  if (selected.kind !== 'selected') return;
  assert.equal(selected.relation, 'historical');
  assert.equal(topologyCalls, 0);
});

test('a current merged PR outranks newer historical records', async () => {
  const selected = await selectRepresentativePullRequest(
    [
      candidate(4, 'merged', { updatedAt: '2026-08-01T00:00:00Z' }),
      candidate(5, 'closed', { updatedAt: '2026-09-01T00:00:00Z' }),
    ],
    HEAD,
    topology('contains'),
  );

  assert.equal(selected.kind, 'selected');
  if (selected.kind !== 'selected') return;
  assert.equal(selected.candidate.number, 4);
  assert.equal(selected.relation, 'current');
});

test('missing or failed merged topology is unknown instead of fail-open', async () => {
  const missingOid = await selectRepresentativePullRequest(
    [candidate(6, 'merged', { headRefOid: undefined })],
    HEAD,
    topology('not_contains'),
  );
  assert.equal(missingOid.kind, 'unknown');

  const failed = await selectRepresentativePullRequest(
    [candidate(6, 'merged')],
    HEAD,
    topology('unknown'),
  );
  assert.equal(failed.kind, 'unknown');
});

test('strict parsing rejects malformed success payloads', () => {
  assert.equal(parsePullRequestCandidates('{oops').ok, false);
  assert.equal(parsePullRequestCandidates('{}').ok, false);
  assert.equal(parsePullRequestCandidates('[{"number":1}]').ok, false);

  const parsed = parsePullRequestCandidates(JSON.stringify([{
    number: 7,
    state: 'MERGED',
    url: 'https://github.com/horang-labs/tessera/pull/7',
    mergedAt: '2026-08-07T00:00:00Z',
    updatedAt: '2026-08-07T00:00:00Z',
    headRefOid: HEAD,
  }]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.candidates[0]?.state, 'merged');
});
