import type { CommandInfo } from '@/stores/command-store';

const DEFAULT_RETRY_DELAYS_MS = [200, 400, 800, 1_600, 3_200] as const;

interface LoadCodexSkillsOptions {
  fetcher?: typeof fetch;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
  shouldContinue?: () => boolean;
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function parseSkills(payload: unknown): CommandInfo[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const skills = (payload as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return null;

  return skills
    .filter((skill): skill is Record<string, unknown> =>
      Boolean(skill) && typeof skill === 'object' && typeof skill.name === 'string')
    .map((skill) => ({
      name: skill.name as string,
      description: typeof skill.description === 'string' ? skill.description : '',
    }));
}

/**
 * Fetch Codex skills without turning a retryable provider failure into a valid
 * empty list. Returns null when loading was cancelled or retries were exhausted.
 */
export async function loadCodexSkills(
  sessionId: string,
  options: LoadCodexSkillsOptions = {},
): Promise<CommandInfo[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const wait = options.wait ?? waitForRetry;
  const shouldContinue = options.shouldContinue ?? (() => true);

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (!shouldContinue()) return null;

    try {
      const response = await fetcher(
        `/api/sessions/${encodeURIComponent(sessionId)}/skills`,
      );
      if (response.ok) {
        const payload = await response.json();
        if (!shouldContinue()) return null;
        const skills = parseSkills(payload);
        if (skills !== null) return skills;
      } else {
        const isRetryable = response.status === 429 || response.status >= 500;
        if (!isRetryable) return null;
      }
    } catch {
      // Network failures are retryable. Do not cache them as an empty result.
    }

    const delayMs = retryDelaysMs[attempt];
    if (delayMs === undefined || !shouldContinue()) return null;
    await wait(delayMs);
  }

  return null;
}
