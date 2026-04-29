import { NextResponse } from 'next/server';
import type { LogoutResponse } from '@/types/auth';

export async function POST() {
  const response: LogoutResponse = {
    success: true,
    message: 'Logged out.',
  };

  console.log('[Auth] User logged out');

  const nextResponse = NextResponse.json(response);

  // Clear JWT cookie
  nextResponse.cookies.set('jwt', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  });

  return nextResponse;
}
