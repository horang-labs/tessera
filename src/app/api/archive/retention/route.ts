import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getArchivedWorktreeRetentionProgress } from '@/lib/archive/archive-retention-runner';

export async function GET(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;
  return NextResponse.json({ progress: getArchivedWorktreeRetentionProgress(auth.userId) }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
