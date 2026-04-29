import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { processManager } from '@/lib/cli/process-manager';
import * as dbTasks from '@/lib/db/tasks';
import { collectionExists } from '@/lib/db/collections';
import { generateTaskId } from '@/types/task-entity';
import { getCachedOrScheduleBulk } from '@/lib/git/worktree-diff-stats-bulk';
import logger from '@/lib/logger';

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
    const activeSessionIds = processManager.getActiveSessionIds();
    const rawTasks = dbTasks.getTasks(projectId, activeSessionIds);
    // Diff badge only applies to tasks bound to a worktree branch.
    const diffStatsByWorkDir = getCachedOrScheduleBulk(
      rawTasks.map((t) => (t.worktreeBranch ? t.workDir : undefined)),
      userId,
    );
    const tasks = rawTasks.map((t) => ({
      ...t,
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

    const activeSessionIds = processManager.getActiveSessionIds();
    const task = dbTasks.getTask(id, activeSessionIds);
    logger.info({ taskId: id, projectId }, 'Task created via API');
    return NextResponse.json({ task }, { status: 201 });
  } catch (err: unknown) {
    logger.error({ error: err }, 'Failed to create task');
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}
