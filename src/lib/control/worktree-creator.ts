import { SettingsManager } from '@/lib/settings/manager';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { validateProjectEnvironment } from '@/lib/projects/environment-policy';
import { startWorktreePreparation } from '@/lib/projects/worktree-preparation';
import { waitForPreparationBeforeAgent } from '@/lib/projects/preparation-gate';
import { broadcastTaskMutation } from '@/lib/ws/mutation-broadcast';
import { checkManagedWorktreePreflight } from '@/lib/worktrees/preflight';
import { createGitRunner, type GitRunner } from '@/lib/worktrees/git-runner';
import { createGitWorktree } from '@/lib/worktrees/create';
import {
  allocateExplicitManagedWorktree,
  ExplicitManagedWorktreeAllocationError,
  removeManagedWorktree,
  resolveManagedWorktreeRoot,
} from '@/lib/worktrees/managed';
import {
  createDatabaseControlWorktreeSource,
  persistDatabaseControlWorktree,
} from './database-worktree-source';
import {
  ControlOperationError,
  ControlWorktreeCreationError,
  type ControlWorktreeCreator,
  type ControlWorktreeRecord,
} from './service';

const DEFAULT_PREPARATION_TIMEOUT_MS = 10 * 60 * 1000;

export function createDatabaseControlWorktreeCreator(options: {
  userId?: string;
  resolveUserId?: () => Promise<string | undefined>;
  preparationTimeoutMs?: number;
}): ControlWorktreeCreator {
  return {
    async create(request) {
      const userId = options.userId ?? await options.resolveUserId?.();
      if (!userId) {
        throw new ControlOperationError(
          'INSTANCE_UNAVAILABLE',
          'The Tessera user context is unavailable.',
          503,
        );
      }
      const [settings, agentEnvironment] = await Promise.all([
        SettingsManager.load(userId, { silent: true }),
        getAgentEnvironment(userId),
      ]);
      const projectDir = request.project.decodedPath;
      const environmentValidation = validateProjectEnvironment(
        projectDir,
        agentEnvironment,
      );
      if (!environmentValidation.ok) {
        throw new ControlOperationError(
          'PROJECT_ENVIRONMENT_MISMATCH',
          environmentValidation.error
            ?? 'The Project is not compatible with the configured agent environment.',
          400,
          {
            projectId: request.project.id,
            agentEnvironment,
            filesystemKind: environmentValidation.filesystemKind,
          },
        );
      }
      const runGit = createGitRunner(agentEnvironment);

      const preflight = await checkManagedWorktreePreflight(projectDir, runGit);
      if (!preflight.ok) {
        throw new ControlWorktreeCreationError(
          'WORKTREE_CREATE_FAILED',
          preflight.error,
          preflight.status,
          { projectId: request.project.id, ...(preflight.installUrl ? { installUrl: preflight.installUrl } : {}) },
        );
      }

      await validateBranch(projectDir, request.branch, runGit);
      await resolveStartPoint(
        projectDir,
        request.startPoint,
        runGit,
      );

      let worktreePath: string;
      try {
        const rootDir = await resolveManagedWorktreeRoot(projectDir, agentEnvironment);
        const allocation = await allocateExplicitManagedWorktree(projectDir, request.branch, {
          rootDir,
          runGit,
          pathTemplate: settings.managedWorktreePathTemplate,
          agentEnvironment,
        });
        worktreePath = allocation.worktreePath;
      } catch (error) {
        if (error instanceof ExplicitManagedWorktreeAllocationError) {
          if (error.code === 'branch_already_exists') {
            throw new ControlWorktreeCreationError(
              'BRANCH_ALREADY_EXISTS',
              `Branch '${request.branch}' already exists.`,
              409,
              { branch: request.branch },
            );
          }
          throw new ControlWorktreeCreationError(
            'WORKTREE_CREATE_FAILED',
            'The managed Worktree path is unavailable.',
            409,
            { branch: request.branch },
          );
        }
        throw new ControlWorktreeCreationError(
          'WORKTREE_CREATE_FAILED',
          'The managed Worktree path policy could not allocate a checkout.',
          500,
          { branch: request.branch },
        );
      }

      try {
        await createGitWorktree({
          projectDir,
          worktreePath,
          branchName: request.branch,
          source: { mode: 'branch-off', baseRef: request.startPoint },
          runGit,
        });
      } catch (error) {
        const branchAlreadyExists = isExistingBranchError(error);
        throw new ControlWorktreeCreationError(
          branchAlreadyExists ? 'BRANCH_ALREADY_EXISTS' : 'WORKTREE_CREATE_FAILED',
          branchAlreadyExists
            ? `Branch '${request.branch}' already exists.`
            : 'Git could not create the managed Worktree.',
          branchAlreadyExists ? 409 : 500,
          { branch: request.branch, startPoint: request.startPoint },
        );
      }
      let persisted: { taskId: string; worktree: ControlWorktreeRecord };
      try {
        persisted = persistDatabaseControlWorktree({
          projectId: request.project.id,
          title: request.title ?? request.branch,
          branch: request.branch,
          filesystemPath: worktreePath,
        });
      } catch {
        await compensateCreatedWorktree(projectDir, worktreePath, request.branch, runGit);
        throw new ControlWorktreeCreationError(
          'WORKTREE_PERSIST_FAILED',
          'The managed Worktree could not be persisted.',
          500,
          { branch: request.branch, startPoint: request.startPoint },
        );
      }

      broadcastTaskMutation(userId, {
        kind: 'created',
        projectId: request.project.id,
      });

      try {
        await startWorktreePreparation({
          userId,
          taskId: persisted.taskId,
          projectId: request.project.id,
          projectDir,
          worktreePath,
          branchName: request.branch,
        });
      } catch {
        const failedWorktree = createDatabaseControlWorktreeSource()
          .get(persisted.worktree.worktreeId) ?? persisted.worktree;
        throw preparationError('PREPARATION_FAILED', failedWorktree, request.startPoint);
      }

      const wait = await waitForPreparationBeforeAgent({
        workDir: worktreePath,
        timeoutMs: options.preparationTimeoutMs ?? DEFAULT_PREPARATION_TIMEOUT_MS,
      });
      const worktree = createDatabaseControlWorktreeSource().get(persisted.worktree.worktreeId)
        ?? persisted.worktree;
      if (wait.waited && wait.result === 'timedOut') {
        throw preparationError('PREPARATION_TIMEOUT', worktree, request.startPoint);
      }
      if (worktree.preparationStatus === 'failed' && worktree.preparationPhase === 'before') {
        throw preparationError('PREPARATION_FAILED', worktree, request.startPoint);
      }

      return { worktree, startPoint: request.startPoint };
    },
  };
}

async function validateBranch(
  projectDir: string,
  branch: string,
  runGit: GitRunner,
): Promise<void> {
  if (branch.startsWith('-')) {
    throw new ControlWorktreeCreationError(
      'WORKTREE_CREATE_FAILED',
      'The requested Worktree branch is invalid.',
      400,
      { branch },
    );
  }
  try {
    await runGit(['-C', projectDir, 'check-ref-format', `refs/heads/${branch}`]);
  } catch {
    throw new ControlWorktreeCreationError(
      'WORKTREE_CREATE_FAILED',
      'The requested Worktree branch is invalid.',
      400,
      { branch },
    );
  }
}

async function resolveStartPoint(
  projectDir: string,
  startPoint: string,
  runGit: GitRunner,
): Promise<string> {
  try {
    const result = await runGit([
      '-C', projectDir, 'rev-parse', '--verify', '--quiet', '--end-of-options',
      `${startPoint}^{commit}`,
    ]);
    return result.stdout.trim();
  } catch {
    throw new ControlWorktreeCreationError(
      'INVALID_START_POINT',
      `Start point '${startPoint}' does not resolve to a commit.`,
      422,
      { startPoint },
    );
  }
}

function isExistingBranchError(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error))
    .toLowerCase()
    .includes('already exists');
}

async function compensateCreatedWorktree(
  projectDir: string,
  worktreePath: string,
  branch: string,
  runGit: GitRunner,
): Promise<void> {
  await removeManagedWorktree(projectDir, worktreePath, runGit).catch(() => undefined);
  await runGit(['-C', projectDir, 'branch', '-D', '--', branch]).catch(() => undefined);
}

function preparationError(
  code: 'PREPARATION_FAILED' | 'PREPARATION_TIMEOUT',
  worktree: ControlWorktreeRecord,
  startPoint: string,
): ControlWorktreeCreationError {
  return new ControlWorktreeCreationError(
    code,
    code === 'PREPARATION_TIMEOUT'
      ? 'Worktree preparation did not finish before the timeout.'
      : 'Worktree preparation failed before an agent could start.',
    code === 'PREPARATION_TIMEOUT' ? 504 : 409,
    {},
    worktree,
    startPoint,
  );
}
