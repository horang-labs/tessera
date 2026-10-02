import fs from 'node:fs/promises';
import path from 'node:path';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import { evidenceHash } from './autorun-context';
export type HumanSubmission = { nativeId: string; sourceIdentityHash: string; fileGeneration: string; text: string;
  textHash: string; origin: 'human' | 'automation'; observerSubmissionId: string };
function directory(userId: string, sessionId: string) { return getTesseraDataPath('autorun-human', evidenceHash(JSON.stringify([userId, sessionId]))); }
/** Authenticated lead hooks only. Retransmission cannot relabel an automation prompt as human. */
export async function recordHumanSubmission(userId: string, sessionId: string, value: HumanSubmission) {
  const dir = directory(userId, sessionId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, evidenceHash(value.sourceIdentityHash + value.nativeId) + '.json');
  // Existing receipts retain their original provenance even at the quota.
  try { await fs.access(file); return; } catch { /* New native submission. */ }
  if (Buffer.byteLength(value.text) > 16_384 || (await fs.readdir(dir)).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).length >= 100) {
    await fs.writeFile(path.join(dir, '.incomplete'), 'human evidence omitted', { mode: 0o600 });
    return;
  }
  try { await fs.writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
/** Null is durable incomplete evidence, never a verified older objective. */
export async function readHumanSubmissions(userId: string, sessionId: string): Promise<HumanSubmission[] | null> {
  try {
    const dir = directory(userId, sessionId);
    const entries = await fs.readdir(dir);
    const names = entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    if (entries.includes('.incomplete') || names.length > 100) return null;
    return await Promise.all(names.map(async name => {
      const file = path.join(dir, name);
      if ((await fs.stat(file)).size > 20_000) throw new Error('evidence bound');
      return JSON.parse(await fs.readFile(file, 'utf8')) as HumanSubmission;
    }));
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null; }
}
