import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getActiveSessionIds } from '@/lib/session/active-session-runtime';
import * as dbTasks from '@/lib/db/tasks';
import { collectionExists } from '@/lib/db/collections';
import { generateTaskId } from '@/types/task-entity';
import { getCachedOrScheduleBulk } from '@/lib/git/worktree-diff-stats-bulk';
import { broadcastTaskMutation, getOriginClientIdFromRequest } from '@/lib/ws/mutation-broadcast';
import logger from '@/lib/logger';
import { pathExists } from '@/lib/filesystem/path-exists';

/**
 * GET /api/tasks?projectId=xxx
 * Returns all tasks for a project with their child sessions.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;
  const { userId } = auth;

  const projectId = req.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  try {
    const activeSessionIds = getActiveSessionIds(userId);
    const rawTasks = dbTasks.getTasks(projectId, activeSessionIds);
    const worktreePresence = await Promise.all(
      rawTasks.map(async (task) => ({
        id: task.id,
        missing:
          Boolean(task.worktreeBranch)
          && Boolean(task.workDir)
          && !task.worktreeDeletedAt
          && !(await pathExists(task.workDir!)),
      })),
    );
    const worktreeMissingByTaskId = new Map(
      worktreePresence.map(({ id, missing }) => [id, missing]),
    );
    // Diff badge only applies to tasks bound to a worktree branch.
    const diffStatsByWorkDir = getCachedOrScheduleBulk(
      rawTasks.map((t) => (t.worktreeBranch ? t.workDir : undefined)),
      userId,
    );
    const tasks = rawTasks.map((t) => ({
      ...t,
      worktreeMissing: worktreeMissingByTaskId.get(t.id) ?? false,
      diffStats:
        t.worktreeBranch && t.workDir
          ? diffStatsByWorkDir.get(t.workDir) ?? undefined
          : undefined,
    }));
    return NextResponse.json({ tasks });
  } catch (err: unknown) {
    logger.error({ error: err }, 'Failed to fetch tasks');
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}

/**
 * POST /api/tasks
 * Creates a new task.
 * Body: { projectId, title, collectionId?, workflowStatus?, worktreeBranch? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { projectId, title, collectionId, workflowStatus, worktreeBranch } = body as {
    projectId?: unknown;
    title?: unknown;
    collectionId?: unknown;
    workflowStatus?: unknown;
    worktreeBranch?: unknown;
  };

  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }
  if (
    typeof collectionId === 'string' &&
    collectionId.trim().length > 0 &&
    !collectionExists(collectionId.trim(), projectId.trim())
  ) {
    return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
  }

  try {
    const id = generateTaskId();
    dbTasks.createTask({
      id,
      projectId: projectId.trim(),
      title: title.trim(),
      collectionId: typeof collectionId === 'string' && collectionId.trim().length > 0
        ? collectionId.trim()
        : undefined,
      workflowStatus: typeof workflowStatus === 'string' ? workflowStatus as any : undefined,
      worktreeBranch: typeof worktreeBranch === 'string' ? worktreeBranch : undefined,
    });

    const activeSessionIds = getActiveSessionIds();
    const task = dbTasks.getTask(id, activeSessionIds);
    logger.info({ taskId: id, projectId }, 'Task created via API');
    broadcastTaskMutation(auth.userId, {
      kind: 'created',
      projectId: projectId.trim(),
      originClientId: getOriginClientIdFromRequest(req),
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (err: unknown) {
    logger.error({ error: err }, 'Failed to create task');
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}
