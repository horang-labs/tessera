import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getTask, setTaskWorktreeCheckout, taskExists } from '@/lib/db/tasks';
import { getProjectWorktree } from '@/lib/db/projects';
import logger from '@/lib/logger';
import { validateProjectEnvironment } from '@/lib/projects/environment-policy';
import { startWorktreePreparation } from '@/lib/projects/worktree-preparation';
import { SettingsManager } from '@/lib/settings/manager';
import {
  allocateCheckoutManagedWorktree,
  allocateManagedWorktree,
  ExplicitManagedWorktreeAllocationError,
  ManagedWorktreeAllocationError,
  resolveManagedWorktreeRoot,
} from '@/lib/worktrees/managed';
import { ManagedWorktreePathTemplateError } from '@/lib/worktrees/path-template-server';
import { checkManagedWorktreePreflight } from '@/lib/worktrees/preflight';
import { createGitRunner } from '@/lib/worktrees/git-runner';
import {
  createGitWorktree,
  WorktreeCreationError,
  type WorktreeCreationSource,
} from '@/lib/worktrees/create';
import {
  listWorktreeBaseRefs,
  resolveWorktreeCheckoutTarget,
  validateWorktreeBaseRef,
} from '@/lib/worktrees/base-refs';
import { resolveAgentReportedPath } from '@/lib/filesystem/path-environment';

/**
 * POST /api/worktrees
 *
 * Creates a git worktree for a given session.
 *
 * Request body:
 *   { projectDir: string, source?: WorktreeCreationSource, ...branchNamingInputs }
 *
 * Response (200):
 *   { worktreePath: string, branchName: string }
 *
 * Security:
 * - projectDir must be an absolute path with no ".." components
 * - Shell arguments are passed as separate argv items (no shell=true)
 *
 * This endpoint:
 * 1. Validates all inputs
 * 2. Allocates a managed temp branch/path pair under the configured location
 * 3. Creates the Worktree through the source-aware Git seam
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) {
    return auth.response;
  }
  const { userId } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const {
    projectDir,
    branchPrefix,
    branchSlug,
    allowBranchSlugSuffix,
    baseRef,
    source: requestedSource,
    taskId,
  } = body as {
    projectDir?: unknown;
    branchPrefix?: unknown;
    branchSlug?: unknown;
    allowBranchSlugSuffix?: unknown;
    baseRef?: unknown;
    source?: unknown;
    taskId?: unknown;
  };

  // --- Input validation ---

  if (typeof projectDir !== 'string' || !projectDir) {
    return NextResponse.json({ error: 'projectDir is required' }, { status: 400 });
  }

  if (branchPrefix !== undefined && typeof branchPrefix !== 'string') {
    return NextResponse.json({ error: 'branchPrefix must be a string' }, { status: 400 });
  }

  if (branchSlug !== undefined && typeof branchSlug !== 'string') {
    return NextResponse.json({ error: 'branchSlug must be a string' }, { status: 400 });
  }

  if (allowBranchSlugSuffix !== undefined && typeof allowBranchSlugSuffix !== 'boolean') {
    return NextResponse.json({ error: 'allowBranchSlugSuffix must be a boolean' }, { status: 400 });
  }

  if (baseRef !== undefined && typeof baseRef !== 'string') {
    return NextResponse.json({ error: 'baseRef must be a string' }, { status: 400 });
  }

  const source = parseCreationSource(requestedSource, baseRef);
  if (!source.ok) {
    return NextResponse.json({ error: source.error }, { status: 400 });
  }

  if (taskId !== undefined && typeof taskId !== 'string') {
    return NextResponse.json({ error: 'taskId must be a string' }, { status: 400 });
  }

  if (taskId !== undefined && !taskExists(taskId)) {
    return NextResponse.json({ error: `Unknown task: ${taskId}` }, { status: 404 });
  }

  const settings = await SettingsManager.load(userId);

  const originatingTask = typeof taskId === 'string' ? getTask(taskId) : undefined;
  const originProjectWorktree = originatingTask
    ? getProjectWorktree(originatingTask.projectId)
    : undefined;
  if (originatingTask && !originProjectWorktree?.currentBranch) {
    return NextResponse.json(
      {
        code: 'PROJECT_BRANCH_UNAVAILABLE',
        error: 'The Project Worktree must be on a branch before creating a linked Worktree.',
      },
      { status: 422 },
    );
  }
  const creationScope = originProjectWorktree?.currentBranch
    ? {
        originWorktreeId: originProjectWorktree.id,
        branch: originProjectWorktree.currentBranch,
      }
    : undefined;
  const startPoint = source.value.mode === 'checkout-branch'
    ? source.value.branch
    : source.value.baseRef ?? 'HEAD';

  // Ensure projectDir is absolute and has no path traversal
  if (!isAbsoluteFilesystemPath(projectDir) || projectDir.includes('..')) {
    return NextResponse.json({ error: 'Invalid projectDir' }, { status: 400 });
  }

  const environmentValidation = validateProjectEnvironment(projectDir, settings.agentEnvironment);
  if (!environmentValidation.ok) {
    return NextResponse.json(
      {
        code: 'PROJECT_ENVIRONMENT_MISMATCH',
        error: environmentValidation.error,
        filesystemKind: environmentValidation.filesystemKind,
        agentEnvironment: settings.agentEnvironment,
      },
      { status: 400 },
    );
  }

  const runGit = createGitRunner(settings.agentEnvironment);
  const worktreeRoot = await resolveManagedWorktreeRoot(projectDir, settings.agentEnvironment);
  const preflight = await checkManagedWorktreePreflight(projectDir, runGit);
  if (!preflight.ok) {
    return NextResponse.json(
      {
        code: preflight.code,
        error: preflight.error,
        ...(preflight.installUrl ? { installUrl: preflight.installUrl } : {}),
      },
      { status: preflight.status },
    );
  }

  const selectedBaseRef = source.value.mode === 'branch-off'
    ? source.value.baseRef
    : null;

  const availableBaseRefs = selectedBaseRef || source.value.mode === 'checkout-branch'
    ? await listWorktreeBaseRefs(projectDir, runGit)
    : [];

  if (selectedBaseRef) {
    const baseRefExists = await validateWorktreeBaseRef(
      projectDir,
      selectedBaseRef,
      availableBaseRefs,
      runGit,
    );
    if (!baseRefExists) {
      return NextResponse.json(
        {
          code: 'INVALID_BASE_REF',
          error: `Base ref '${selectedBaseRef}' does not exist or does not point to a commit.`,
        },
        { status: 422 },
      );
    }
  }

  const checkoutTarget = source.value.mode === 'checkout-branch'
    ? resolveWorktreeCheckoutTarget(source.value.branch, availableBaseRefs)
    : null;
  if (source.value.mode === 'checkout-branch' && !checkoutTarget) {
    return NextResponse.json(
      {
        code: 'BRANCH_NOT_FOUND',
        error: `Branch '${source.value.branch}' does not exist.`,
      },
      { status: 422 },
    );
  }

  let branchName: string;
  let worktreePath: string;
  try {
    const allocation = checkoutTarget
      ? await allocateCheckoutManagedWorktree(
          projectDir,
          checkoutTarget.branchName,
          {
            rootDir: worktreeRoot,
            pathTemplate: settings.managedWorktreePathTemplate,
            agentEnvironment: settings.agentEnvironment,
            runGit,
          },
        )
      : await allocateManagedWorktree(
          projectDir,
          branchPrefix ?? settings.gitConfig.branchPrefix,
          branchSlug,
          {
            allowCollisionSuffix: allowBranchSlugSuffix !== false,
            rootDir: worktreeRoot,
            pathTemplate: settings.managedWorktreePathTemplate,
            agentEnvironment: settings.agentEnvironment,
            runGit,
          },
        );
    branchName = allocation.branchName;
    worktreePath = allocation.worktreePath;
  } catch (error) {
    if (error instanceof ManagedWorktreeAllocationError) {
      const status = error.code === 'name_unavailable' ? 409 : 500;
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          branchName: error.branchName,
          worktreePath: error.worktreePath,
        },
        { status }
      );
    }
    if (error instanceof ExplicitManagedWorktreeAllocationError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          branchName: error.branchName,
          worktreePath: error.worktreePath,
        },
        { status: 409 },
      );
    }
    if (error instanceof ManagedWorktreePathTemplateError) {
      return NextResponse.json(
        {
          error: error.message,
          code: 'invalid_worktree_path_template',
        },
        { status: 400 },
      );
    }
    throw error;
  }

  logger.info({ branchName, projectDir, worktreePath, worktreeRoot }, 'Creating git worktree');

  // --- Run git worktree add ---
  let reusedExistingCheckout = false;
  try {
    await createGitWorktree({
      projectDir,
      worktreePath,
      branchName,
      source: checkoutTarget
        ? { mode: 'checkout-branch', branch: checkoutTarget.selectedRef }
        : { mode: 'branch-off', baseRef: selectedBaseRef },
      runGit,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ branchName, projectDir, error: msg }, 'git worktree add failed');

    // Distinguish common git errors for better client messages
    if (err instanceof WorktreeCreationError && err.code === 'branch_not_found') {
      return NextResponse.json(
        { code: 'BRANCH_NOT_FOUND', error: err.message },
        { status: 422 },
      );
    }
    if (
      err instanceof WorktreeCreationError
      && err.code === 'branch_already_checked_out'
      && err.holderWorktreePath
      && err.holderWorktreePath !== projectDir
      && checkoutTarget
    ) {
      // A chat agent can create a Git Worktree directly, before Tessera has a
      // chance to persist it. The branch may only be checked out once, so
      // attach this task/session to that checkout instead of attempting a
      // second `git worktree add` and leaving the user with an unusable error.
      worktreePath = err.holderWorktreePath;
      reusedExistingCheckout = true;
      logger.info(
        { branchName, projectDir, worktreePath },
        'Reusing externally created git worktree already holding branch',
      );
    } else if (err instanceof WorktreeCreationError && err.code === 'branch_already_checked_out') {
      return NextResponse.json(
        {
          code: 'BRANCH_ALREADY_CHECKED_OUT',
          error: err.message,
          branchName: err.branchName,
          holderWorktreePath: err.holderWorktreePath,
        },
        { status: 409 },
      );
    } else if (msg.includes('already exists')) {
      return NextResponse.json(
        { error: `Worktree path already exists: ${worktreePath}` },
        { status: 409 }
      );
    } else if (msg.includes('is not a git repository')) {
      return NextResponse.json(
        { error: 'The project directory is not a git repository.' },
        { status: 422 }
      );
    } else if (msg.includes('already checked out') || msg.includes('already used by worktree')) {
      return NextResponse.json(
        {
          code: 'BRANCH_ALREADY_CHECKED_OUT',
          error: `Branch '${branchName}' is already checked out.`,
        },
        { status: 409 }
      );
    } else {
      return NextResponse.json(
        { error: `Failed to create worktree: ${msg}` },
        { status: 500 }
      );
    }
  }

  // Git runs inside the configured agent environment and must receive its own
  // path spelling. Only convert to the Windows server's filesystem form after
  // the checkout exists, before identity persistence and host-side readers.
  worktreePath = await resolveAgentReportedPath(
    worktreePath,
    settings.agentEnvironment,
  );

  if (taskId) {
    // Recorded here rather than by a follow-up call from the client, so the
    // task and its worktree cannot be left disagreeing if that call never
    // arrives.
    setTaskWorktreeCheckout(taskId, {
      branch: branchName,
      path: worktreePath,
      creationScope,
      startPoint,
    });

    // The worktree exists the moment git succeeds, so its creation is reported
    // without waiting on preparation — which may take as long as the user's
    // script does, and whose failure must not cost them the worktree. The
    // status the run writes to the task is what reports it instead.
    //
    // Not awaiting it is safe only because the run claims its status
    // synchronously, before its own first await: this response is what the
    // client races to open a session and a PTY against, and the agent gate can
    // only hold that PTY if the claim is already stored when the response
    // leaves. Keep the claim ahead of every await in `startWorktreePreparation`.
    void startWorktreePreparation({ userId, taskId, projectDir, worktreePath, branchName })
      .catch((error) => {
        logger.error({ error, branchName, projectDir, worktreePath }, 'Worktree preparation failed to start');
      });
  } else {
    // Preparation records its status on a task, so a worktree created without
    // one has nowhere to report to and is left unprepared.
    logger.warn(
      { branchName, projectDir, worktreePath },
      reusedExistingCheckout
        ? 'Existing worktree reused without a task; preparation was not started'
        : 'Worktree created without a task; preparation was not started',
    );
  }

  return NextResponse.json({ worktreePath, branchName });
}

function parseCreationSource(
  requestedSource: unknown,
  legacyBaseRef: unknown,
): { ok: true; value: WorktreeCreationSource } | { ok: false; error: string } {
  if (requestedSource === undefined) {
    const baseRef = typeof legacyBaseRef === 'string' && legacyBaseRef.trim()
      ? legacyBaseRef.trim()
      : null;
    return { ok: true, value: { mode: 'branch-off', baseRef } };
  }
  if (!requestedSource || typeof requestedSource !== 'object' || Array.isArray(requestedSource)) {
    return { ok: false, error: 'source must be an object' };
  }

  const candidate = requestedSource as { mode?: unknown; baseRef?: unknown; branch?: unknown };
  if (candidate.mode === 'branch-off') {
    if (
      candidate.baseRef !== undefined
      && candidate.baseRef !== null
      && typeof candidate.baseRef !== 'string'
    ) {
      return { ok: false, error: 'source.baseRef must be a string' };
    }
    return {
      ok: true,
      value: {
        mode: 'branch-off',
        baseRef: typeof candidate.baseRef === 'string' && candidate.baseRef.trim()
          ? candidate.baseRef.trim()
          : null,
      },
    };
  }
  if (candidate.mode === 'checkout-branch') {
    if (typeof candidate.branch !== 'string' || !candidate.branch.trim()) {
      return { ok: false, error: 'source.branch is required' };
    }
    return {
      ok: true,
      value: { mode: 'checkout-branch', branch: candidate.branch.trim() },
    };
  }
  return { ok: false, error: 'source.mode is invalid' };
}

function isAbsoluteFilesystemPath(candidate: string): boolean {
  return path.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
}
