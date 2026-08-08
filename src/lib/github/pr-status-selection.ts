import type {
  TaskPrRelation,
  TaskPrState,
} from '@/types/task-pr-status';

export interface PullRequestCandidate {
  number: number;
  state: TaskPrState;
  url: string;
  mergedAt?: string;
  updatedAt: string;
  headRefOid?: string;
}

export type HeadContainment = 'contains' | 'not_contains' | 'unknown';

export type RepresentativePullRequest =
  | {
      kind: 'selected';
      candidate: PullRequestCandidate;
      relation: TaskPrRelation;
    }
  | { kind: 'none' }
  | { kind: 'unknown'; reason: string };

type ContainsCurrentHead = (
  currentHead: string,
  prHead: string,
) => Promise<HeadContainment>;

/**
 * Validate the GitHub CLI payload before it is allowed to replace cached PR
 * state. A successful process with unreadable JSON is an unknown probe, never
 * evidence that no PR exists.
 */
export function parsePullRequestCandidates(
  raw: string,
): { ok: true; candidates: PullRequestCandidate[] } | { ok: false; error: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'gh returned malformed pull request JSON' };
  }

  if (!Array.isArray(payload)) {
    return { ok: false, error: 'gh returned a non-array pull request payload' };
  }

  const candidates: PullRequestCandidate[] = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'gh returned an invalid pull request entry' };
    }

    const row = item as Record<string, unknown>;
    const number = row.number;
    const rawState = typeof row.state === 'string' ? row.state.toUpperCase() : '';
    const url = row.url;
    const updatedAt = row.updatedAt;
    const mergedAt = row.mergedAt;
    const headRefOid = row.headRefOid;

    if (!Number.isInteger(number) || (number as number) <= 0) {
      return { ok: false, error: 'gh returned a pull request without a valid number' };
    }
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(rawState)) {
      return { ok: false, error: 'gh returned an unknown pull request state' };
    }
    if (typeof url !== 'string' || url.length === 0) {
      return { ok: false, error: 'gh returned a pull request without a URL' };
    }
    if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) {
      return { ok: false, error: 'gh returned a pull request without a valid update time' };
    }
    if (mergedAt !== null && mergedAt !== undefined && typeof mergedAt !== 'string') {
      return { ok: false, error: 'gh returned an invalid merge time' };
    }
    if (
      headRefOid !== null
      && headRefOid !== undefined
      && (typeof headRefOid !== 'string' || !/^[0-9a-f]{40}$/i.test(headRefOid))
    ) {
      return { ok: false, error: 'gh returned an invalid pull request head SHA' };
    }

    const state: TaskPrState =
      rawState === 'MERGED' || typeof mergedAt === 'string'
        ? 'merged'
        : rawState === 'CLOSED'
          ? 'closed'
          : 'open';
    candidates.push({
      number: number as number,
      state,
      url,
      updatedAt,
      ...(typeof mergedAt === 'string' ? { mergedAt } : {}),
      ...(typeof headRefOid === 'string' && headRefOid
        ? { headRefOid }
        : {}),
    });
  }

  return { ok: true, candidates };
}

/**
 * Choose the one PR Tessera carries through its existing task/session pipeline.
 * Display history and creation readiness are separated by `relation`.
 */
export async function selectRepresentativePullRequest(
  candidates: readonly PullRequestCandidate[],
  currentHead: string | null,
  containsCurrentHead: ContainsCurrentHead,
): Promise<RepresentativePullRequest> {
  const sorted = [...candidates].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );

  const open = sorted.find((candidate) => candidate.state === 'open');
  if (open) return { kind: 'selected', candidate: open, relation: 'current' };
  if (sorted.length === 0) return { kind: 'none' };

  let topologyUnknown = false;
  const historical: PullRequestCandidate[] = sorted.filter(
    (candidate) => candidate.state === 'closed',
  );

  for (const candidate of sorted) {
    if (candidate.state !== 'merged') continue;
    if (!currentHead || !candidate.headRefOid) {
      topologyUnknown = true;
      continue;
    }

    const containment = currentHead === candidate.headRefOid
      ? 'contains'
      : await containsCurrentHead(currentHead, candidate.headRefOid);
    if (containment === 'contains') {
      return { kind: 'selected', candidate, relation: 'current' };
    }
    if (containment === 'unknown') {
      topologyUnknown = true;
      continue;
    }
    historical.push(candidate);
  }

  // An unclassified merged PR may still represent the current revision and
  // therefore outrank every historical record. Do not unlock Create PR by
  // guessing around it.
  if (topologyUnknown) {
    return { kind: 'unknown', reason: 'Could not compare the current HEAD with a merged PR' };
  }

  historical.sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  const latest = historical[0];
  return latest
    ? { kind: 'selected', candidate: latest, relation: 'historical' }
    : { kind: 'none' };
}
