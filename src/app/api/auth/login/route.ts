import { NextRequest, NextResponse } from 'next/server';
import { loginSchema } from '@/lib/validation/auth';
import { findUserByUsername, updateLastLogin } from '@/lib/users';
import { verifyPassword } from '@/lib/auth/password';
import { generateToken } from '@/lib/auth/jwt';
import { isRateLimited, recordFailedAttempt, clearAttempts } from '@/lib/auth/rate-limit';
import { createAuthError } from '@/lib/error';
import logger from '@/lib/logger';
import type { LoginResponse } from '@/types/auth';

function getClientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

export async function POST(request: NextRequest) {
  try {
    const ip = getClientIp(request);

    // Rate limit check
    const rateCheck = isRateLimited(ip);
    if (rateCheck.limited) {
      logger.warn({ ip }, 'Login rate limited');
      const error = createAuthError(
        'rate-limited',
        'Rate limited',
        429,
        `Too many login attempts. Try again in ${Math.ceil(rateCheck.retryAfterSeconds! / 60)} minutes.`,
        '/api/auth/login'
      );
      const response = NextResponse.json(error, { status: 429 });
      response.headers.set('Retry-After', String(rateCheck.retryAfterSeconds));
      return response;
    }

    const body = await request.json();

    // Validate input
    const validation = loginSchema.safeParse(body);
    if (!validation.success) {
      const error = createAuthError(
        'validation',
        'Invalid input',
        400,
        validation.error.issues[0].message,
        '/api/auth/login'
      );
      return NextResponse.json(error, { status: 400 });
    }

    const { username, password } = validation.data;

    // Find user
    const user = await findUserByUsername(username);
    if (!user) {
      recordFailedAttempt(ip);
      const error = createAuthError(
        'auth-failed',
        'Authentication failed',
        401,
        'Username or password is incorrect.',
        '/api/auth/login'
      );
      logger.warn({ username, ip }, 'Login failed: user not found');
      return NextResponse.json(error, { status: 401 });
    }

    // Verify password
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      recordFailedAttempt(ip);
      const error = createAuthError(
        'auth-failed',
        'Authentication failed',
        401,
        'Username or password is incorrect.',
        '/api/auth/login'
      );
      logger.warn({ username, ip }, 'Login failed: invalid password');
      return NextResponse.json(error, { status: 401 });
    }

    // Login success — clear rate limit for this IP
    clearAttempts(ip);

    // Generate JWT token
    const token = await generateToken(user.id, user.username);

    // Update last login
    await updateLastLogin(user.id);

    logger.info({
      userId: user.id,
      username: user.username,
      }, 'User logged in');

    // Create response
    const response: LoginResponse = {
      success: true,
      user: {
        id: user.id,
        username: user.username,
      },
    };

    // Set httpOnly cookie
    const nextResponse = NextResponse.json(response);
    nextResponse.cookies.set('jwt', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 604800, // 7 days
      path: '/',
    });

    return nextResponse;
  } catch (error) {
    logger.error({ error }, 'Login error');
    const authError = createAuthError(
      'internal',
      'Internal error',
      500,
      'Authentication system error.',
      '/api/auth/login'
    );
    return NextResponse.json(authError, { status: 500 });
  }
}
