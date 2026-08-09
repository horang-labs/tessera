import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { clearMobileAccessLocalState } from '@/lib/mobile-access/mobile-access-local-state';

export async function DELETE(request: NextRequest) {
  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) return auth.response;
  if (auth.kind !== 'app') {
    return NextResponse.json(
      { error: 'Installation app authentication is required' },
      { status: 403 },
    );
  }

  const result = await clearMobileAccessLocalState();
  return NextResponse.json({ success: true, ...result });
}
