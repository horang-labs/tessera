import type { NextRequest } from 'next/server';
import type { RequestGateInput } from './request-gate';

export function requestGateInputFromNextRequest(request: NextRequest): RequestGateInput {
  return {
    purpose: 'http',
    method: request.method,
    rawUrl: request.url,
    host: request.headers.get('host') ?? '',
    origin: request.headers.get('origin') ?? '',
    cookies: Object.fromEntries(
      request.cookies.getAll().map(({ name, value }) => [name, value]),
    ),
    headers: Object.fromEntries(request.headers.entries()),
  };
}
