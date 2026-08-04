import { randomUUID } from 'node:crypto';
import * as dbSessions from '@/lib/db/sessions';
import { getDb } from '@/lib/db/database';
import { providerLaunchModule } from '@/lib/terminal/shared-provider-launch-module';
import {
  ProviderLaunchError,
  type ProviderLaunchModule,
} from '@/lib/terminal/provider-launch-module';
import {
  broadcastSessionMutation,
  broadcastTaskMutation,
} from '@/lib/ws/mutation-broadcast';
import {
  ControlOperationError,
  ControlSessionStartError,
  type ControlSessionMutator,
  type ControlSessionRecord,
  type ControlSessionSource,
} from './service';

interface SessionProjectionRow {
  session_id: string;
  public_worktree_id: string;
  project_id: string;
  title: string;
  provider: string;
  provider_state: string | null;
  updated_at: string;
}

interface WorktreeIdentityRow {
  task_id: string;
  project_id: string;
}

const SESSION_PROJECTION_SQL = `
  SELECT s.id AS session_id, t.public_worktree_id, s.project_id, s.title,
         s.provider, s.provider_state, s.updated_at
  FROM sessions s
  JOIN tasks t ON t.id = s.task_id
  WHERE s.deleted = 0
    AND s.archived = 0
    AND t.archived = 0
    AND t.worktree_deleted_at IS NULL
`;

export function createDatabaseControlSessionSource(): ControlSessionSource {
  return {
    list: (worktreeId) => (getDb().prepare(`
      ${SESSION_PROJECTION_SQL}
        AND t.public_worktree_id = ?
      ORDER BY s.updated_at DESC, s.id ASC
    `).all(worktreeId) as SessionProjectionRow[]).map(toRecord),
    get: (sessionId) => {
      const row = getDb().prepare(`
        ${SESSION_PROJECTION_SQL}
          AND s.id = ?
      `).get(sessionId) as SessionProjectionRow | undefined;
      return row ? toRecord(row) : undefined;
    },
  };
}

export function createDatabaseControlSessionMutator(options: {
  userId?: string;
  resolveUserId?: () => Promise<string | undefined>;
  launchModule?: ProviderLaunchModule;
}): ControlSessionMutator {
  const source = createDatabaseControlSessionSource();
  const launchModule = options.launchModule ?? providerLaunchModule;

  const requireUserId = async (): Promise<string> => {
    const userId = options.userId ?? await options.resolveUserId?.();
    if (userId) return userId;
    throw new ControlOperationError(
      'INSTANCE_UNAVAILABLE',
      'The Tessera user context is unavailable.',
      503,
    );
  };

  return {
    async create(request) {
      const userId = await requireUserId();
      if (!launchModule.supportsProvider(request.provider)) {
        throw new ControlOperationError(
          'PROVIDER_NOT_SUPPORTED',
          `PTY Session creation is not supported for provider '${request.provider}'.`,
          400,
          { provider: request.provider },
        );
      }
      const worktree = getWorktreeIdentity(request.worktreeId);
      if (!worktree) {
        throw new ControlOperationError(
          'WORKTREE_NOT_FOUND',
          'The requested Worktree does not exist.',
          404,
          { worktreeId: request.worktreeId },
        );
      }

      const sessionId = randomUUID();
      dbSessions.createSession(
        sessionId,
        worktree.project_id,
        request.title?.trim() || 'New Session',
        request.provider,
        {
          taskId: worktree.task_id,
          providerState: JSON.stringify({ kind: 'terminal' }),
        },
      );
      const created = source.get(sessionId);
      if (!created) {
        dbSessions.deleteSession(sessionId);
        throw new ControlOperationError(
          'INSTANCE_UNAVAILABLE',
          'The Session could not be read after creation.',
          500,
        );
      }
      broadcastSessionMutation(userId, { kind: 'created', projectId: created.projectId });
      broadcastTaskMutation(userId, { kind: 'updated', projectId: created.projectId });
      return created;
    },

    async start(request) {
      const userId = await requireUserId();
      try {
        return await launchModule.launch({
          mode: 'detached',
          sessionId: request.sessionId,
          userId,
          initialPrompt: request.initialPrompt,
          allowPreparationFailure: request.allowPreparationFailure,
        });
      } catch (error) {
        throw toControlLaunchError(error, request.sessionId);
      }
    },

    async removeCreated(sessionId) {
      const userId = await requireUserId();
      const session = source.get(sessionId);
      if (!session) return;
      dbSessions.deleteSession(sessionId);
      broadcastSessionMutation(userId, { kind: 'deleted', projectId: session.projectId });
      broadcastTaskMutation(userId, { kind: 'updated', projectId: session.projectId });
    },
  };
}

function getWorktreeIdentity(worktreeId: string): WorktreeIdentityRow | undefined {
  return getDb().prepare(`
    SELECT id AS task_id, project_id
    FROM tasks
    WHERE public_worktree_id = ?
      AND archived = 0
      AND worktree_deleted_at IS NULL
  `).get(worktreeId) as WorktreeIdentityRow | undefined;
}

function toRecord(row: SessionProjectionRow): ControlSessionRecord {
  return {
    sessionId: row.session_id,
    worktreeId: row.public_worktree_id,
    projectId: row.project_id,
    title: row.title,
    provider: row.provider,
    providerState: row.provider_state,
    updatedAt: row.updated_at,
  };
}

function toControlLaunchError(error: unknown, sessionId: string): ControlOperationError {
  if (!(error instanceof ProviderLaunchError)) {
    return new ControlOperationError(
      'INSTANCE_UNAVAILABLE',
      'The Session runtime could not be started.',
      500,
      { sessionId },
    );
  }
  let mapped: ControlOperationError;
  switch (error.code) {
    case 'SESSION_NOT_FOUND':
      mapped = new ControlOperationError('SESSION_NOT_FOUND', error.message, 404, { sessionId });
      break;
    case 'SESSION_RUNTIME_ALREADY_RUNNING':
      mapped = new ControlOperationError(
        'SESSION_RUNTIME_ALREADY_RUNNING',
        error.message,
        409,
        { sessionId, terminalId: error.terminalId },
      );
      break;
    case 'SESSION_NOT_FRESH':
      mapped = new ControlOperationError('SESSION_NOT_FRESH', error.message, 409, { sessionId });
      break;
    case 'PROVIDER_NOT_SUPPORTED':
      mapped = new ControlOperationError('PROVIDER_NOT_SUPPORTED', error.message, 400, { sessionId });
      break;
    case 'INITIAL_PROMPT_TOO_LARGE':
      mapped = new ControlOperationError('INITIAL_PROMPT_TOO_LARGE', error.message, 400, { sessionId });
      break;
    case 'INITIAL_PROMPT_EMPTY':
      mapped = new ControlOperationError('INVALID_USAGE', error.message, 400, { sessionId });
      break;
    case 'PREPARATION_FAILED':
      mapped = new ControlOperationError('PREPARATION_FAILED', error.message, 409, { sessionId });
      break;
    case 'PREPARATION_TIMEOUT':
      mapped = new ControlOperationError('PREPARATION_TIMEOUT', error.message, 504, { sessionId });
      break;
    default:
      mapped = new ControlOperationError(
        'INSTANCE_UNAVAILABLE',
        error.message,
        500,
        { sessionId, terminalId: error.terminalId },
      );
      break;
  }
  return new ControlSessionStartError(
    mapped.code,
    mapped.message,
    mapped.httpStatus,
    mapped.details,
    error.runtimeSpawned,
  );
}
