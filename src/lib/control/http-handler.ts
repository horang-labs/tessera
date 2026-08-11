import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isTerminalNamedKey,
  type TerminalNamedKey,
} from '@/lib/terminal/session-control-input';
import type { WorktreeCreationSource } from '@/lib/worktrees/create';
import type { RuntimeDescriptor } from './runtime-descriptor';
import {
  ControlOperationError,
  isControlCodexServiceTier,
  type ControlCallerContext,
  type ControlCodexServiceTier,
  type ControlErrorCode,
  type ControlService,
} from './service';

export const CONTROL_ROUTE_PREFIX = '/__tessera/control/v1';
export const CONTROL_RUNTIME_ID_HEADER = 'x-tessera-runtime-id';
export const CONTROL_API_VERSION_HEADER = 'x-tessera-control-version';
export const CONTROL_APP_VERSION_HEADER = 'x-tessera-app-version';
const MAX_CALLER_ID_LENGTH = 2_048;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

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
    const requestUrl = request.url ? new URL(request.url, 'http://localhost') : null;
    const pathname = requestUrl?.pathname ?? '';
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

    const context = callerContext(request);
    try {
      if (pathname === `${CONTROL_ROUTE_PREFIX}/status`) {
        requireMethod(request, 'GET');
        writeSuccess(response, await service.status(context));
        return true;
      }

      if (pathname === `${CONTROL_ROUTE_PREFIX}/projects`) {
        requireMethod(request, 'GET');
        writeSuccess(response, await service.listProjects(context));
        return true;
      }

      if (pathname === `${CONTROL_ROUTE_PREFIX}/worktrees`) {
        const current = requestUrl?.searchParams.get('current');
        const projectId = requestUrl?.searchParams.get('projectId');
        if ((current === '1') === Boolean(projectId)) {
          throw new ControlOperationError(
            'INVALID_USAGE',
            'Exactly one Worktree Project selector is required.',
            400,
          );
        }
        const selector = current === '1'
          ? { kind: 'current' as const }
          : { kind: 'project' as const, projectId: projectId as string };
        if (request.method === 'GET') {
          writeSuccess(response, await service.listWorktrees(selector, context));
          return true;
        }
        requireMethod(request, 'POST');
        const body = await readWorktreeCreationBody(request);
        writeSuccess(response, await service.createWorktree({ selector, ...body }, context));
        return true;
      }

      const worktreeSessionsMatch = pathname.match(
        new RegExp(`^${CONTROL_ROUTE_PREFIX}/worktrees/([^/]+)/sessions$`),
      );
      if (worktreeSessionsMatch) {
        requireMethod(request, 'GET');
        const worktreeId = decodeControlId(worktreeSessionsMatch[1], 'Worktree');
        writeSuccess(response, await service.listSessions(worktreeId, context));
        return true;
      }

      if (pathname === `${CONTROL_ROUTE_PREFIX}/sessions`) {
        requireMethod(request, 'POST');
        writeSuccess(response, await service.createSession(
          await readSessionCreationBody(request),
          context,
        ));
        return true;
      }

      if (pathname === `${CONTROL_ROUTE_PREFIX}/sessions/launch`) {
        requireMethod(request, 'POST');
        writeSuccess(response, await service.launchSession(
          await readSessionLaunchBody(request),
          context,
        ));
        return true;
      }

      const sessionStartMatch = pathname.match(
        new RegExp(`^${CONTROL_ROUTE_PREFIX}/sessions/([^/]+)/start$`),
      );
      if (sessionStartMatch) {
        requireMethod(request, 'POST');
        const sessionId = decodeControlId(sessionStartMatch[1], 'Session');
        writeSuccess(response, await service.startSession({
          sessionId,
          ...await readSessionStartBody(request),
        }, context));
        return true;
      }

      const sessionReadMatch = pathname.match(
        new RegExp(`^${CONTROL_ROUTE_PREFIX}/sessions/([^/]+)/read$`),
      );
      if (sessionReadMatch) {
        requireMethod(request, 'GET');
        const sessionId = decodeControlId(sessionReadMatch[1], 'Session');
        writeSuccess(response, await service.readSession(sessionId, context));
        return true;
      }

      const sessionWaitMatch = pathname.match(
        new RegExp(`^${CONTROL_ROUTE_PREFIX}/sessions/([^/]+)/wait$`),
      );
      if (sessionWaitMatch) {
        requireMethod(request, 'POST');
        const sessionId = decodeControlId(sessionWaitMatch[1], 'Session');
        writeSuccess(response, await service.waitForSession({
          sessionId,
          ...await readSessionWaitBody(request),
        }, context));
        return true;
      }

      const sessionPromptMatch = pathname.match(
        new RegExp(`^${CONTROL_ROUTE_PREFIX}/sessions/([^/]+)/prompt$`),
      );
      if (sessionPromptMatch) {
        requireMethod(request, 'POST');
        const sessionId = decodeControlId(sessionPromptMatch[1], 'Session');
        writeSuccess(response, await service.promptSession({
          sessionId,
          ...await readSessionPromptBody(request),
        }, context));
        return true;
      }

      const sessionKeysMatch = pathname.match(
        new RegExp(`^${CONTROL_ROUTE_PREFIX}/sessions/([^/]+)/keys$`),
      );
      if (sessionKeysMatch) {
        requireMethod(request, 'POST');
        const sessionId = decodeControlId(sessionKeysMatch[1], 'Session');
        writeSuccess(response, await service.sendSessionKeys({
          sessionId,
          ...await readSessionKeysBody(request),
        }, context));
        return true;
      }

      const sessionStopMatch = pathname.match(
        new RegExp(`^${CONTROL_ROUTE_PREFIX}/sessions/([^/]+)/stop$`),
      );
      if (sessionStopMatch) {
        requireMethod(request, 'POST');
        const sessionId = decodeControlId(sessionStopMatch[1], 'Session');
        const body = await readJsonObject(request);
        rejectUnknownFields(body, [], 'Session stop');
        writeSuccess(response, await service.stopSession(sessionId, context));
        return true;
      }

      const sessionShowMatch = pathname.match(
        new RegExp(`^${CONTROL_ROUTE_PREFIX}/sessions/([^/]+)$`),
      );
      if (sessionShowMatch) {
        requireMethod(request, 'GET');
        const sessionId = decodeControlId(sessionShowMatch[1], 'Session');
        writeSuccess(response, await service.showSession(sessionId, context));
        return true;
      }

      const worktreePrefix = `${CONTROL_ROUTE_PREFIX}/worktrees/`;
      if (pathname.startsWith(worktreePrefix)) {
        requireMethod(request, 'GET');
        const encodedWorktreeId = pathname.slice(worktreePrefix.length);
        if (!encodedWorktreeId || encodedWorktreeId.includes('/')) {
          throw new ControlOperationError('INVALID_USAGE', 'A Worktree ID is required.', 400);
        }
        let worktreeId: string;
        try {
          worktreeId = decodeURIComponent(encodedWorktreeId);
        } catch {
          throw new ControlOperationError('INVALID_USAGE', 'The Worktree ID is invalid.', 400);
        }
        writeSuccess(response, await service.showWorktree(worktreeId, context));
        return true;
      }

      const projectPrefix = `${CONTROL_ROUTE_PREFIX}/projects/`;
      if (pathname.startsWith(projectPrefix)) {
        requireMethod(request, 'GET');
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

function requireMethod(request: IncomingMessage, expected: 'GET' | 'POST'): void {
  if (request.method !== expected) {
    throw new ControlOperationError('INVALID_USAGE', 'The Control request is invalid.', 400);
  }
}

async function readWorktreeCreationBody(request: IncomingMessage): Promise<{
  branch: string;
  startPoint: string;
  source?: WorktreeCreationSource;
  title?: string;
}> {
  const body = await readJsonObject(request);
  const unknownKey = Object.keys(body).find(
    (key) => !['branch', 'startPoint', 'source', 'title'].includes(key),
  );
  if (unknownKey) {
    throw new ControlOperationError('INVALID_USAGE', `Unsupported Worktree field: ${unknownKey}`, 400);
  }
  if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) {
    throw new ControlOperationError('INVALID_USAGE', 'A Worktree title must not be empty.', 400);
  }
  if (body.source !== undefined) {
    const source = parseControlWorktreeSource(body.source);
    if (source.mode === 'checkout-branch') {
      return {
        branch: source.branch,
        startPoint: source.branch,
        source,
        ...(body.title === undefined ? {} : { title: body.title as string }),
      };
    }
    if (typeof body.branch !== 'string' || !body.branch.trim()) {
      throw new ControlOperationError('BRANCH_REQUIRED', 'A new Worktree branch is required.', 400);
    }
    return {
      branch: body.branch,
      startPoint: source.baseRef ?? 'HEAD',
      source,
      ...(body.title === undefined ? {} : { title: body.title as string }),
    };
  }
  if (typeof body.branch !== 'string' || !body.branch.trim()) {
    throw new ControlOperationError('BRANCH_REQUIRED', 'A new Worktree branch is required.', 400);
  }
  if (typeof body.startPoint !== 'string' || !body.startPoint.trim()) {
    throw new ControlOperationError('START_POINT_REQUIRED', 'A Worktree start point is required.', 400);
  }
  return {
    branch: body.branch,
    startPoint: body.startPoint,
    ...(body.title === undefined ? {} : { title: body.title as string }),
  };
}

function parseControlWorktreeSource(source: unknown): WorktreeCreationSource {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new ControlOperationError('INVALID_USAGE', 'The Worktree source is invalid.', 400);
  }
  const candidate = source as { mode?: unknown; baseRef?: unknown; branch?: unknown };
  if (candidate.mode === 'branch-off') {
    if (
      candidate.baseRef !== undefined
      && candidate.baseRef !== null
      && typeof candidate.baseRef !== 'string'
    ) {
      throw new ControlOperationError('INVALID_USAGE', 'The Worktree base ref is invalid.', 400);
    }
    return {
      mode: 'branch-off',
      baseRef: typeof candidate.baseRef === 'string' && candidate.baseRef.trim()
        ? candidate.baseRef.trim()
        : null,
    };
  }
  if (candidate.mode === 'checkout-branch') {
    if (typeof candidate.branch !== 'string' || !candidate.branch.trim()) {
      throw new ControlOperationError('BRANCH_REQUIRED', 'A Worktree branch is required.', 400);
    }
    return { mode: 'checkout-branch', branch: candidate.branch.trim() };
  }
  throw new ControlOperationError('INVALID_USAGE', 'The Worktree source mode is invalid.', 400);
}

async function readSessionCreationBody(request: IncomingMessage): Promise<{
  worktreeId: string;
  provider: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: ControlCodexServiceTier;
}> {
  const body = await readJsonObject(request);
  rejectUnknownFields(
    body,
    ['worktreeId', 'provider', 'title', 'model', 'reasoningEffort', 'serviceTier'],
    'Session',
  );
  return readSessionCreationFields(body);
}

async function readSessionStartBody(request: IncomingMessage): Promise<{
  initialPrompt?: string;
  allowPreparationFailure?: boolean;
}> {
  const body = await readJsonObject(request);
  rejectUnknownFields(body, ['initialPrompt', 'allowPreparationFailure'], 'Session start');
  return readPromptChoice(body);
}

async function readSessionLaunchBody(request: IncomingMessage): Promise<{
  worktreeId: string;
  provider: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: ControlCodexServiceTier;
  initialPrompt?: string;
  allowPreparationFailure?: boolean;
}> {
  const body = await readJsonObject(request);
  rejectUnknownFields(
    body,
    [
      'worktreeId',
      'provider',
      'title',
      'model',
      'reasoningEffort',
      'serviceTier',
      'initialPrompt',
      'allowPreparationFailure',
    ],
    'Session launch',
  );
  const creation = readSessionCreationFields(body);
  return { ...creation, ...readPromptChoice(body) };
}

async function readSessionWaitBody(request: IncomingMessage): Promise<{
  condition: 'running' | 'turn-complete' | 'input-required' | 'runtime-exit';
  timeoutSeconds?: number;
}> {
  const body = await readJsonObject(request);
  rejectUnknownFields(body, ['condition', 'timeoutSeconds'], 'Session wait');
  if (
    body.condition !== 'running'
    && body.condition !== 'turn-complete'
    && body.condition !== 'input-required'
    && body.condition !== 'runtime-exit'
  ) {
    throw new ControlOperationError(
      'INVALID_USAGE',
      'The Session wait condition is not supported.',
      400,
    );
  }
  if (
    body.timeoutSeconds !== undefined
    && (!Number.isInteger(body.timeoutSeconds) || Number(body.timeoutSeconds) < 1)
  ) {
    throw new ControlOperationError(
      'INVALID_USAGE',
      'The Session wait timeout must be a positive integer.',
      400,
    );
  }
  return {
    condition: body.condition,
    ...(body.timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: Number(body.timeoutSeconds) }),
  };
}

async function readSessionPromptBody(request: IncomingMessage): Promise<{ text: string }> {
  const body = await readJsonObject(request);
  rejectUnknownFields(body, ['text'], 'Session prompt');
  if (typeof body.text !== 'string') {
    throw new ControlOperationError('INVALID_USAGE', 'The Session prompt is invalid.', 400);
  }
  return { text: body.text };
}

async function readSessionKeysBody(request: IncomingMessage): Promise<{
  keys: TerminalNamedKey[];
}> {
  const body = await readJsonObject(request);
  rejectUnknownFields(body, ['keys'], 'Session keys');
  if (
    !Array.isArray(body.keys)
    || body.keys.length === 0
    || !body.keys.every(isTerminalNamedKey)
  ) {
    throw new ControlOperationError(
      'INVALID_USAGE',
      'At least one supported Session key is required.',
      400,
    );
  }
  return { keys: body.keys as TerminalNamedKey[] };
}

function readSessionCreationFields(body: Record<string, unknown>): {
  worktreeId: string;
  provider: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: ControlCodexServiceTier;
} {
  const worktreeId = requireBodyString(body, 'worktreeId', 'A Worktree ID is required.');
  const provider = requireBodyString(body, 'provider', 'An explicit supported provider is required.');
  if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) {
    throw new ControlOperationError('INVALID_USAGE', 'A Session title must not be empty.', 400);
  }
  if (body.model !== undefined && typeof body.model !== 'string') {
    throw new ControlOperationError('INVALID_USAGE', 'The Session model is invalid.', 400);
  }
  if (body.reasoningEffort !== undefined && typeof body.reasoningEffort !== 'string') {
    throw new ControlOperationError('INVALID_USAGE', 'The Session effort is invalid.', 400);
  }
  if (body.serviceTier !== undefined && !isControlCodexServiceTier(body.serviceTier)) {
    throw new ControlOperationError('INVALID_USAGE', 'The Session fast mode is invalid.', 400);
  }
  return {
    worktreeId,
    provider,
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.model === undefined ? {} : { model: body.model }),
    ...(body.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: body.reasoningEffort }),
    ...(body.serviceTier === undefined
      ? {}
      : { serviceTier: body.serviceTier as ControlCodexServiceTier }),
  };
}

function readPromptChoice(body: Record<string, unknown>): {
  initialPrompt?: string;
  allowPreparationFailure?: boolean;
} {
  if (!Object.hasOwn(body, 'initialPrompt')) {
    throw new ControlOperationError(
      'INVALID_USAGE',
      'Exactly one initial prompt choice is required.',
      400,
    );
  }
  if (body.initialPrompt !== null && typeof body.initialPrompt !== 'string') {
    throw new ControlOperationError('INVALID_USAGE', 'The initial prompt is invalid.', 400);
  }
  if (
    body.allowPreparationFailure !== undefined
    && typeof body.allowPreparationFailure !== 'boolean'
  ) {
    throw new ControlOperationError(
      'INVALID_USAGE',
      'The preparation failure override is invalid.',
      400,
    );
  }
  return {
    ...(typeof body.initialPrompt === 'string' ? { initialPrompt: body.initialPrompt } : {}),
    ...(body.allowPreparationFailure === true ? { allowPreparationFailure: true } : {}),
  };
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      throw new ControlOperationError('INVALID_USAGE', 'The Control request is too large.', 400);
    }
    raw += chunk;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ControlOperationError('INVALID_USAGE', 'The Control request body is invalid.', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlOperationError('INVALID_USAGE', 'The Control request body is invalid.', 400);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  body: Record<string, unknown>,
  supported: string[],
  label: string,
): void {
  const unknownKey = Object.keys(body).find((key) => !supported.includes(key));
  if (unknownKey) {
    throw new ControlOperationError(
      'INVALID_USAGE',
      `Unsupported ${label} field: ${unknownKey}`,
      400,
    );
  }
}

function requireBodyString(
  body: Record<string, unknown>,
  key: string,
  message: string,
): string {
  const value = body[key];
  if (typeof value === 'string' && value.trim()) return value;
  throw new ControlOperationError('INVALID_USAGE', message, 400);
}

function decodeControlId(encoded: string | undefined, label: string): string {
  if (!encoded) {
    throw new ControlOperationError('INVALID_USAGE', `A ${label} ID is required.`, 400);
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new ControlOperationError('INVALID_USAGE', `The ${label} ID is invalid.`, 400);
  }
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
    ...readCallerId(request, 'x-tessera-control-authority', 'authorityToken'),
    ...readCallerId(request, 'x-tessera-caller-project-id', 'projectId'),
    ...readCallerId(request, 'x-tessera-caller-session-id', 'sessionId'),
    ...readCallerId(request, 'x-tessera-caller-worktree-id', 'worktreeId'),
  };
}

function readCallerId<Key extends 'authorityToken' | 'projectId' | 'sessionId' | 'worktreeId'>(
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
