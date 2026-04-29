import { NextRequest, NextResponse } from 'next/server';
import { loginSchema } from '@/lib/validation/auth';
import { generateToken } from '@/lib/auth/jwt';
import { createAuthError } from '@/lib/error';
import { createFirstUser, hasAnyUsers } from '@/lib/users';
import { isElectronAuthBypassEnabled } from '@/lib/auth/electron-mode';
import type { LoginResponse } from '@/types/auth';

export async function GET() {
  if (isElectronAuthBypassEnabled()) {
    return NextResponse.json({ needsAccountSetup: false });
  }

  return NextResponse.json({
    needsAccountSetup: !(await hasAnyUsers()),
  });
}

export async function POST(request: NextRequest) {
  try {
    if (isElectronAuthBypassEnabled()) {
      return NextResponse.json({ needsAccountSetup: false }, { status: 409 });
    }

    if (await hasAnyUsers()) {
      const error = createAuthError(
        'conflict',
        'Account already exists',
        409,
        'The first account has already been created.',
        '/api/auth/setup',
      );
      return NextResponse.json(error, { status: 409 });
    }

    const body = await request.json();
    const validation = loginSchema.safeParse(body);
    if (!validation.success) {
      const error = createAuthError(
        'validation',
        'Invalid account details',
        400,
        validation.error.issues[0].message,
        '/api/auth/setup',
      );
      return NextResponse.json(error, { status: 400 });
    }

    const { username, password } = validation.data;
    const user = await createFirstUser(username, password);
    const token = await generateToken(user.id, user.username);

    const responseBody: LoginResponse = {
      success: true,
      user: {
        id: user.id,
        username: user.username,
      },
    };

    const response = NextResponse.json(responseBody);
    response.cookies.set('jwt', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 604800,
      path: '/',
    });

    return response;
  } catch {
    const authError = createAuthError(
      'internal',
      'Internal error',
      500,
      'Could not create the first account.',
      '/api/auth/setup',
    );
    return NextResponse.json(authError, { status: 500 });
  }
}
