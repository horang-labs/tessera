import { NextRequest, NextResponse } from 'next/server';
import { sessionOrchestrator } from '@/lib/session/session-orchestrator';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { collectionExists } from '@/lib/db/collections';
import { taskExists } from '@/lib/db/tasks';
import logger from '@/lib/logger';
import { persistCreatedSessionRecord } from '@/lib/session/session-persistence';
import { broadcastSessionMutation, getOriginClientIdFromRequest } from '@/lib/ws/mutation-broadcast';

/**
 * POST /api/sessions - Create a new session (pending; CLI spawns on first message)
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(req);
    if ('response' in auth) {
      return auth.response;
    }
    const { userId } = auth;

    const body = await req.json();
    const {
      workDir,
      title,
      hasCustomTitle,
      permissionMode,
      model,
      reasoningEffort,
      sessionMode,
      accessMode,
      collaborationMode,
      approvalPolicy,
      sandboxMode,
      providerId,
      parentProjectId,
      worktreeBranch,
      taskId,
      collectionId,
    } = body;

    const resolvedWorkDir = workDir || process.cwd();
    const normalizedTaskId =
      typeof taskId === 'string' && taskId.trim().length > 0
        ? taskId.trim()
        : undefined;
    const normalizedWorktreeBranch =
      typeof worktreeBranch === 'string' && worktreeBranch.trim().length > 0
        ? worktreeBranch.trim()
        : undefined;
    const targetProjectId = typeof parentProjectId === 'string' && parentProjectId.trim().length > 0
      ? parentProjectId.trim()
      : resolvedWorkDir;
    const resolvedProviderId = typeof providerId === 'string' ? providerId.trim() : '';

    if (!resolvedProviderId) {
      return NextResponse.json({ error: 'providerId is required' }, { status: 400 });
    }

    if (normalizedWorktreeBranch && !normalizedTaskId) {
      return NextResponse.json(
        { error: 'worktreeBranch requires taskId' },
        { status: 400 },
      );
    }

    if (normalizedTaskId && !taskExists(normalizedTaskId)) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (
      typeof collectionId === 'string' &&
      collectionId.trim().length > 0 &&
      !collectionExists(collectionId.trim(), targetProjectId)
    ) {
      return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
    }

    try {
      const result = await sessionOrchestrator.createSession(userId, {
        workDir,
        title,
        permissionMode,
        model,
        reasoningEffort,
        sessionMode,
        accessMode,
        collaborationMode,
        approvalPolicy,
        sandboxMode,
        providerId: resolvedProviderId,
      });

      logger.info({ userId, sessionId: result.sessionId }, 'Session created via API');

      persistCreatedSessionRecord({
        sessionId: result.sessionId,
        resolvedWorkDir,
        title: result.title,
        providerId: resolvedProviderId,
        parentProjectId: typeof parentProjectId === 'string' ? parentProjectId : undefined,
        taskId: normalizedTaskId,
        collectionId: typeof collectionId === 'string' && collectionId.trim().length > 0 ? collectionId.trim() : undefined,
        hasCustomTitle: hasCustomTitle === true,
        worktreeBranch: normalizedWorktreeBranch,
        worktreeManaged: Boolean(normalizedWorktreeBranch),
      });

      broadcastSessionMutation(userId, {
        kind: 'created',
        projectId: targetProjectId,
        originClientId: getOriginClientIdFromRequest(req),
      });

      return NextResponse.json({
        ...result,
        provider: resolvedProviderId,
        model,
        reasoningEffort,
        sessionMode,
        accessMode,
      }, { status: 201 });
    } catch (err: any) {
      if (err.message.includes('Maximum session limit')) {
        return NextResponse.json(
          {
            error: 'Session limit exceeded',
            message: 'Maximum 20 sessions reached. Please close some sessions.',
          },
          { status: 429 }
        );
      }
      if (err.message.includes('unknown provider')) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  } catch (err) {
    logger.error({ error: err }, 'Failed to create session');
    return NextResponse.json(
      { error: 'Failed to create session' },
      { status: 500 }
    );
  }
}
