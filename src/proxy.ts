import { NextRequest, NextResponse } from 'next/server';
import { isElectronAuthBypassEnabled } from '@/lib/auth/electron-mode';

/**
 * Proxy — runs on Node.js runtime (Next.js 16+).
 *
 * Only checks for token cookie existence (lightweight).
 * Full JWT verification happens in API route handlers.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isElectronAuthBypassEnabled()) {
    return NextResponse.next();
  }

  // Skip auth routes and static assets
  if (
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next();
  }

  const token = request.cookies.get('jwt')?.value;

  if (!token) {
    // No token - redirect to login for pages, return 401 for API
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // Token exists - pass through (full verification in API handlers)
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/chat/:path*',
    '/api/:path*',
  ],
};
