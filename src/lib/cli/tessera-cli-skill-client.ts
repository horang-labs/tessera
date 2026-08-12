import type { TesseraCliSkillStatus } from './tessera-cli-skill';

const ENDPOINT = '/api/provider-integrations/tessera-cli';

async function readStatus(response: Response): Promise<TesseraCliSkillStatus> {
  const body = await response.json() as TesseraCliSkillStatus | { error?: unknown };
  if (!response.ok || !('state' in body)) {
    const error = 'error' in body ? body.error : undefined;
    throw new Error(typeof error === 'string' ? error : `Skill setup failed (${response.status}).`);
  }
  return body;
}

export function inspectTesseraCliSkill(): Promise<TesseraCliSkillStatus> {
  return fetch(ENDPOINT, { cache: 'no-store' }).then(readStatus);
}

export function removeTesseraCliSkill(
  expectedAgentEnvironment: TesseraCliSkillStatus['agentEnvironment'],
): Promise<TesseraCliSkillStatus> {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'remove', expectedAgentEnvironment }),
  }).then(readStatus);
}
