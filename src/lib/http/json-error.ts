import { NextResponse } from 'next/server';

export function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status }
  );
}
