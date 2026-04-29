import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth/jwt';
import { findUserById } from '@/lib/users';
import { createAuthError } from '@/lib/error';
import { isElectronAuthBypassEnabled } from '@/lib/auth/electron-mode';
import { getElectronAuthUser } from '@/lib/auth/electron-user';
import type { MeResponse } from '@/types/auth';

export async function GET(request: NextRequest) {
  try {
    if (isElectronAuthBypassEnabled()) {
      const user = await getElectronAuthUser();
      if (user) {
        return NextResponse.json({
          user,
        } satisfies MeResponse);
      }
    }

    const token = request.cookies.get('jwt')?.value;

    if (!token) {
      const error = createAuthError(
        'unauthorized',
        'Authentication required',
        401,
        'No valid authentication token.',
        '/api/auth/me'
      );
      return NextResponse.json(error, { status: 401 });
    }

    const payload = await verifyToken(token);
    if (!payload) {
      const error = createAuthError(
        'unauthorized',
        'Authentication required',
        401,
        'No valid authentication token.',
        '/api/auth/me'
      );
      return NextResponse.json(error, { status: 401 });
    }

    const user = await findUserById(payload.sub);
    if (!user) {
      const error = createAuthError(
        'unauthorized',
        'Authentication required',
        401,
        'User not found.',
        '/api/auth/me'
      );
      return NextResponse.json(error, { status: 401 });
    }

    const response: MeResponse = {
      user: {
        id: user.id,
        username: user.username,
        lastLoginAt: user.lastLoginAt.toISOString(),
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[Auth] Me error:', error);
    const authError = createAuthError(
      'internal',
      'Internal error',
      500,
      'Authentication system error.',
      '/api/auth/me'
    );
    return NextResponse.json(authError, { status: 500 });
  }
}
