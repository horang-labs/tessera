import { randomUUID } from 'node:crypto';
import * as dbSessions from '@/lib/db/sessions';
import { getDb } from '@/lib/db/database';
import { providerLaunchModule } from '@/lib/terminal/shared-provider-launch-module';
import type { ProviderLaunchModule } from '@/lib/terminal/provider-launch-module';
import {
  broadcastSessionMutation,
  broadcastTaskMutation,
} from '@/lib/ws/mutation-broadcast';
import {
  ControlOperationError,
  type ControlSessionMutator,
} from './service';
import { createDatabaseControlSessionSource } from './database-session-source';
import { toControlLaunchError } from './session-launch-errors';

interface WorktreeIdentityRow {
  task_id: string;
  project_id: string;
}

export function createDatabaseControlSessionMutator(options: {
  userId?: string;
  resolveUserId?: () => Promise<string | undefined>;
  launchModule?: ProviderLaunchModule;
}): ControlSessionMutator {
  const source = createDatabaseControlSessionSource();
  const launchModule = options.launchModule ?? providerLaunchModule;
  let resolvedUserId = options.userId;
  let resolvingUserId: Promise<string | undefined> | undefined;

  const requireUserId = async (): Promise<string> => {
    if (resolvedUserId) return resolvedUserId;
    resolvingUserId ??= Promise.resolve(options.resolveUserId?.());
    const userId = await resolvingUserId;
    if (userId) {
      resolvedUserId = userId;
      return userId;
    }
    resolvingUserId = undefined;
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
          'The Session provider is not supported for PTY launch.',
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
