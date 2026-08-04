import type { NextRequest } from 'next/server';
import type { RequestGateInput } from './request-gate';

interface RequestHeaders {
  get(name: string): string | null;
  entries(): IterableIterator<[string, string]>;
}

interface RequestCookies {
  getAll(): Array<{ name: string; value: string }>;
}

export function requestGateInputFromServerContext({
  headers,
  cookies,
  method,
  rawUrl,
}: {
  headers: RequestHeaders;
  cookies: RequestCookies;
  method: string;
  rawUrl: string;
}): RequestGateInput {
  return {
    purpose: 'http',
    method,
    rawUrl,
    host: headers.get('host') ?? '',
    origin: headers.get('origin') ?? '',
    cookies: Object.fromEntries(
      cookies.getAll().map(({ name, value }) => [name, value]),
    ),
    headers: Object.fromEntries(headers.entries()),
  };
}

export function requestGateInputFromNextRequest(request: NextRequest): RequestGateInput {
  return requestGateInputFromServerContext({
    headers: request.headers,
    cookies: request.cookies,
    method: request.method,
    rawUrl: request.url,
  });
}
