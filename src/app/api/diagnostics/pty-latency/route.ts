import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';

let report = 0;

const stages = new Set(['keydown-dispatch', 'animation-frame-gap', 'xterm-input', 'output-received', 'output-parsed', 'input-sent', 'input-send-failed']);

export async function POST(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_TESSERA_PTY_LATENCY !== '1') {
    return new NextResponse(null, { status: 404 });
  }
  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) return auth.response;
  const raw = await request.text();
  if (raw.length > 128000) return new NextResponse(null, { status: 413 });
  let batch: unknown;
  try { batch = JSON.parse(raw); } catch { return new NextResponse(null, { status: 400 }); }
  if (!Array.isArray(batch) || batch.length > 500) return new NextResponse(null, { status: 400 });
  const clean = [];
  for (const entry of batch) {
    if (!entry || !stages.has(entry.stage) || ![entry.at, entry.length, entry.ms].every(Number.isFinite)) {
      return new NextResponse(null, { status: 400 });
    }
    // Deliberately omit arbitrary strings/IDs: only timing and counts are persisted.
    clean.push({ receivedAt: Date.now(), at: entry.at, stage: entry.stage, length: entry.length, ms: entry.ms });
  }
  if (clean.length) {
    const directory = getTesseraDataPath('logs', 'pty-latency');
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `browser-${process.pid}-${++report % 50}.json`), JSON.stringify(clean));
    } catch {
      return new NextResponse(null, { status: 503 });
    }
  }
  return new NextResponse(null, { status: 204 });
}
