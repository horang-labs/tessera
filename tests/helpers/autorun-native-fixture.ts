import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { boundary, contextSnapshot } from '../fixtures/autorun-contracts';
import type { AnalysisSnapshotRequest } from '../../src/lib/cli/providers/session-types';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export async function fixture(provider: 'claude-code' | 'codex') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorun-context-'));
  const file = path.join(dir, 'native.jsonl');
  const bytes = await fs.readFile(`tests/fixtures/autorun-proof/${provider === 'codex' ? 'codex' : 'claude'}.jsonl`);
  await fs.writeFile(file, bytes);
  const conversation = provider === 'codex' ? '01a0fd47-096d-7641-94f0-0013775e02e4' : 'c9303786-fff6-4b22-810e-07a5ba5b06a6';
  const correlation = provider === 'codex' ? { ...contextSnapshot().correlation, provider: 'codex' as const, nativeTurnId: '01a0fd47-098b-74c2-ab46-5a4d33836280' }
    : { ...contextSnapshot().correlation, provider: 'claude-code' as const, nativePromptId: '7ab43974-3790-40ac-bf63-6fb3b2eed4fa', stopTextHash: hash('PROOF_OK') };
  delete (correlation as Record<string, unknown>).nativeTurnId;
  if (provider === 'codex') Object.assign(correlation, { nativeTurnId: '01a0fd47-098b-74c2-ab46-5a4d33836280' });
  const request: AnalysisSnapshotRequest = { userId: boundary.userId, agentEnvironment: 'wsl', sessionId: boundary.sessionId,
    providerConversationId: conversation, expectedBoundary: boundary, inputEpoch: 'epoch', workerSelection: { ...contextSnapshot().workerSelection, provider },
    correlation: { ...correlation, providerConversationId: conversation, startByte: 0 }, signal: new AbortController().signal };
  const source = { path: file, canonicalPath: '/canonical/native.jsonl', identityHash: request.correlation.sourceIdentityHash,
    fileGeneration: request.correlation.fileGeneration, cliVersion: provider === 'codex' ? '0.159.2' : '2.1.284' };
  return { dir, file, bytes, request, source, deps: { resolveSource: async () => source, verifyBinding: async () => true, flushWaitMs: 0 } };
}
