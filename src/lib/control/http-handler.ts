import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RuntimeDescriptor } from './runtime-descriptor';
import {
  ControlOperationError,
  type ControlCallerContext,
  type ControlErrorCode,
  type ControlService,
} from './service';

export const CONTROL_ROUTE_PREFIX = '/__tessera/control/v1';
export const CONTROL_RUNTIME_ID_HEADER = 'x-tessera-runtime-id';
export const CONTROL_API_VERSION_HEADER = 'x-tessera-control-version';
export const CONTROL_APP_VERSION_HEADER = 'x-tessera-app-version';
const MAX_CALLER_ID_LENGTH = 2_048;

interface ControlFailureEnvelope {
  ok: false;
  apiVersion: 1;
  error: {
    code: ControlErrorCode;
    message: string;
    details: Record<string, unknown>;
  };
}

export function createControlHttpHandler(options: {
  descriptor: RuntimeDescriptor;
  service: ControlService;
}): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const { descriptor, service } = options;

  return async (request, response) => {
    const pathname = request.url ? new URL(request.url, 'http://localhost').pathname : '';
    if (pathname !== CONTROL_ROUTE_PREFIX && !pathname.startsWith(`${CONTROL_ROUTE_PREFIX}/`)) {
      return false;
    }

    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      response.writeHead(404).end();
      return true;
    }

    if (!isValidBearerToken(headerValue(request, 'authorization'), descriptor.token)) {
      writeFailure(response, 401, {
        ok: false,
        apiVersion: 1,
        error: {
          code: 'UNAUTHORIZED',
          message: 'The Control credential was rejected.',
          details: {},
        },
      });
      return true;
    }

    if (headerValue(request, CONTROL_RUNTIME_ID_HEADER) !== descriptor.runtimeId) {
      writeFailure(response, 409, failure(
        'INSTANCE_UNAVAILABLE',
        'The selected Tessera runtime is unavailable.',
      ));
      return true;
    }

    const requestedControlVersion = headerValue(request, CONTROL_API_VERSION_HEADER);
    const requestedAppVersion = headerValue(request, CONTROL_APP_VERSION_HEADER);
    if (
      requestedControlVersion !== String(descriptor.controlApiVersion)
      || requestedAppVersion !== descriptor.appVersion
    ) {
      writeFailure(response, 409, failure(
        'CONTROL_VERSION_MISMATCH',
        'The Tessera CLI and selected runtime are not compatible.',
        {
          expectedAppVersion: descriptor.appVersion,
          expectedControlVersion: descriptor.controlApiVersion,
        },
      ));
      return true;
    }

    if (request.method !== 'GET') {
      writeFailure(response, 400, failure('INVALID_USAGE', 'The Control request is invalid.'));
      return true;
    }

    const context = callerContext(request);
    try {
      if (pathname === `${CONTROL_ROUTE_PREFIX}/status`) {
        writeSuccess(response, await service.status(context));
        return true;
      }

      if (pathname === `${CONTROL_ROUTE_PREFIX}/projects`) {
        writeSuccess(response, await service.listProjects(context));
        return true;
      }

      const projectPrefix = `${CONTROL_ROUTE_PREFIX}/projects/`;
      if (pathname.startsWith(projectPrefix)) {
        const encodedProjectId = pathname.slice(projectPrefix.length);
        if (!encodedProjectId || encodedProjectId.includes('/')) {
          throw new ControlOperationError('INVALID_USAGE', 'A Project ID is required.', 400);
        }
        let projectId: string;
        try {
          projectId = decodeURIComponent(encodedProjectId);
        } catch {
          throw new ControlOperationError('INVALID_USAGE', 'The Project ID is invalid.', 400);
        }
        writeSuccess(response, await service.showProject(projectId, context));
        return true;
      }

      writeFailure(response, 404, failure('INVALID_USAGE', 'The Control operation is unknown.'));
      return true;
    } catch (error) {
      if (error instanceof ControlOperationError) {
        writeFailure(response, error.httpStatus, failure(error.code, error.message, error.details));
      } else {
        writeFailure(response, 500, failure(
          'INSTANCE_UNAVAILABLE',
          'The selected Tessera runtime could not complete the operation.',
        ));
      }
      return true;
    }
  };
}

export function isValidBearerToken(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  const suppliedToken = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  const expectedDigest = createHmac('sha256', expectedToken).update(expectedToken).digest();
  const suppliedDigest = createHmac('sha256', expectedToken).update(suppliedToken).digest();
  return authorization?.startsWith('Bearer ') === true
    && timingSafeEqual(expectedDigest, suppliedDigest);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true;
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  return /^127(?:\.\d{1,3}){3}$/.test(ipv4)
    && ipv4.split('.').every((part) => Number(part) <= 255);
}

function callerContext(request: IncomingMessage): ControlCallerContext {
  return {
    agentEnvironment: headerValue(request, 'x-tessera-agent-environment') === 'wsl'
      ? 'wsl'
      : 'native',
    ...readCallerId(request, 'x-tessera-caller-project-id', 'projectId'),
    ...readCallerId(request, 'x-tessera-caller-session-id', 'sessionId'),
    ...readCallerId(request, 'x-tessera-caller-worktree-id', 'worktreeId'),
  };
}

function readCallerId<Key extends 'projectId' | 'sessionId' | 'worktreeId'>(
  request: IncomingMessage,
  header: string,
  key: Key,
): Partial<Record<Key, string>> {
  const value = headerValue(request, header)?.trim();
  return value && value.length <= MAX_CALLER_ID_LENGTH ? { [key]: value } as Record<Key, string> : {};
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function failure(
  code: ControlErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ControlFailureEnvelope {
  return {
    ok: false,
    apiVersion: 1,
    error: { code, message, details },
  };
}

function writeSuccess(response: ServerResponse, data: unknown): void {
  writeJson(response, 200, { ok: true, apiVersion: 1, data });
}

function writeFailure(
  response: ServerResponse,
  status: number,
  envelope: ControlFailureEnvelope,
): void {
  writeJson(response, status, envelope);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}
