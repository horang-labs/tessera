import fs from 'node:fs/promises';
import path from 'node:path';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import { evidenceHash } from './autorun-context';
export type HumanSubmission = { nativeId: string; sourceIdentityHash: string; fileGeneration: string; text: string;
  textHash: string; origin: 'human' | 'automation'; observerSubmissionId: string };
function directory(userId: string, sessionId: string) { return getTesseraDataPath('autorun-human', evidenceHash(JSON.stringify([userId, sessionId]))); }
/** Authenticated lead hooks only. Retransmission cannot relabel an automation prompt as human. */
export async function recordHumanSubmission(userId: string, sessionId: string, value: HumanSubmission) {
  if (Buffer.byteLength(value.text) > 16_384) return;
  const dir = directory(userId, sessionId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await fs.readdir(dir)).length >= 100) return;
  const file = path.join(dir, evidenceHash(value.sourceIdentityHash + value.nativeId) + '.json');
  try { await fs.writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
export async function readHumanSubmissions(userId: string, sessionId: string): Promise<HumanSubmission[]> {
  try {
    const dir = directory(userId, sessionId);
    const names = (await fs.readdir(dir)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    if (names.length > 100) return [];
    return await Promise.all(names.map(async name => {
      const file = path.join(dir, name);
      if ((await fs.stat(file)).size > 20_000) throw new Error('evidence bound');
      return JSON.parse(await fs.readFile(file, 'utf8')) as HumanSubmission;
    }));
  } catch { return []; }
}
