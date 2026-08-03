import { NextRequest, NextResponse } from 'next/server';
import { findUserById } from '@/lib/users';
import { createAuthError } from '@/lib/error';
import { isElectronAuthBypassEnabled } from '@/lib/auth/electron-mode';
import { getElectronAuthUser } from '@/lib/electron-user';
import { requestGateInputFromNextRequest } from '@/lib/auth/next-request-gate';
import {
  evaluateRequestAndLog,
  observeRequestGate,
} from '@/lib/auth/request-gate';
import type { MeResponse } from '@/types/auth';

export async function GET(request: NextRequest) {
  try {
    const input = requestGateInputFromNextRequest(request);

    if (isElectronAuthBypassEnabled()) {
      await observeRequestGate(input);
      const user = await getElectronAuthUser();
      if (user) {
        return NextResponse.json({
          user,
        } satisfies MeResponse);
      }
    }

    const decision = await evaluateRequestAndLog(input);
    if (!decision.allow) {
      const error = createAuthError(
        'unauthorized',
        'Authentication required',
        401,
        'No valid authentication token.',
        '/api/auth/me'
      );
      return NextResponse.json(error, { status: 401 });
    }

    const electronUser = await getElectronAuthUser();
    const storedUser = decision.userId === electronUser.id
      ? null
      : await findUserById(decision.userId);
    if (!storedUser && decision.userId !== electronUser.id) {
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
        id: storedUser?.id ?? electronUser.id,
        username: storedUser?.username ?? electronUser.username,
        lastLoginAt: storedUser?.lastLoginAt.toISOString() ?? electronUser.lastLoginAt,
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
