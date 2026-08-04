import { NextRequest, NextResponse } from 'next/server';
import { requestGateInputFromNextRequest } from '@/lib/auth/next-request-gate';
import {
  hasPresentedCredential,
  requestGateLogContext,
} from '@/lib/auth/request-gate';
import { isOriginAllowed } from '@/lib/auth/allowed-origins';
import logger from '@/lib/logger';

/**
 * Proxy — runs on Node.js runtime (Next.js 16+).
 *
 * Translates protected Next.js requests into the shared request gate.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const input = requestGateInputFromNextRequest(request);

  if (!await isOriginAllowed(input)) {
    logger.warn(requestGateLogContext(input), 'HTTP Origin rejected');
    return NextResponse.json(
      { error: 'Origin not allowed' },
      { status: 403 },
    );
  }

  // Skip auth routes and static assets
  if (
    pathname.startsWith('/api/auth') ||
    pathname === '/api/pairing/redeem' ||
    pathname === '/pair' ||
    pathname.startsWith('/pair/') ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next();
  }

  if (!hasPresentedCredential(input)) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      );
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/pair/:path*',
    '/chat/:path*',
    '/api/:path*',
  ],
};
