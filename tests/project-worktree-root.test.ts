import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-project-worktree-'));
const dataDir = path.join(testRoot, 'data');
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

type Modules = {
  database: typeof import('../src/lib/db/database');
  projects: typeof import('../src/lib/db/projects');
  tasks: typeof import('../src/lib/db/tasks');
  worktrees: typeof import('../src/lib/db/worktrees');
  gitPanel: typeof import('../src/lib/git/git-panel');
  workspaceFiles: typeof import('../src/lib/workspace-files/read-workspace-root');
};

let loaded: Promise<Modules> | null = null;
function modules(): Promise<Modules> {
  loaded ??= (async () => {
    const [database, projects, tasks, worktrees, gitPanel, workspaceFiles] = await Promise.all([
      import('../src/lib/db/database'),
      import('../src/lib/db/projects'),
      import('../src/lib/db/tasks'),
      import('../src/lib/db/worktrees'),
      import('../src/lib/git/git-panel'),
      import('../src/lib/workspace-files/read-workspace-root'),
    ]);
    await database.initDatabase();
    return { database, projects, tasks, worktrees, gitPanel, workspaceFiles };
  })();
  return loaded;
}

function createRepository(name: string): string {
  const repository = path.join(testRoot, name);
  fs.mkdirSync(repository, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Tessera Test'], { cwd: repository });
  fs.writeFileSync(path.join(repository, 'README.md'), `${name}\n`);
  execFileSync('git', ['add', 'README.md'], { cwd: repository });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repository, stdio: 'ignore' });
  return repository;
}

test('Project views persist one canonical Worktree across branch and view changes', async () => {
  const { projects } = await modules();
  const repository = createRepository('canonical-root');

  projects.registerProject('view-a', repository, 'View A');
  const first = projects.getProjectWorktree('view-a');
  assert.ok(first);
  assert.match(first.id, /^wt_[A-Za-z0-9_-]+$/);
  assert.equal(first.filesystemPath, fs.realpathSync.native(repository));

  execFileSync('git', ['checkout', '-b', 'feature/branch-independent'], {
    cwd: repository,
    stdio: 'ignore',
  });
  projects.registerProject('view-a', repository, 'View A');
  projects.registerProject('view-b', repository, 'View B');

  assert.equal(projects.getProjectWorktree('view-a')?.id, first.id);
  assert.equal(projects.getProjectWorktree('view-b')?.id, first.id);
  assert.equal(projects.getProjectWorktree('view-b')?.currentBranch, 'feature/branch-independent');
});

test('importing a known linked checkout reuses its existing public Worktree identity', async () => {
  const { projects, tasks, worktrees } = await modules();
  const repository = createRepository('known-linked-root');

  const publicWorktreeId = tasks.createTask({
    id: 'known-linked-task',
    projectId: 'origin-project',
    title: 'Known linked checkout',
    worktreeBranch: 'main',
    worktreePath: repository,
  });
  assert.equal(worktrees.getWorktree(publicWorktreeId)?.filesystemPath, fs.realpathSync.native(repository));

  projects.registerProject('linked-project-view', repository, 'Linked view');
  assert.equal(projects.getProjectWorktree('linked-project-view')?.id, publicWorktreeId);
});

test('legacy non-Git Projects remain readable without a synthetic Worktree', async () => {
  const { projects } = await modules();
  const directory = path.join(testRoot, 'plain-directory');
  fs.mkdirSync(directory, { recursive: true });

  projects.registerProject('legacy-plain-project', directory, 'Plain directory');

  assert.equal(projects.getProject('legacy-plain-project')?.decoded_path, directory);
  assert.equal(projects.getProjectWorktree('legacy-plain-project'), undefined);
});

test('a zero-Session Project Worktree provides Git status and Files directly', async () => {
  const { gitPanel, projects, workspaceFiles } = await modules();
  const repository = createRepository('sessionless-routing');
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/sessionless.git'], {
    cwd: repository,
  });
  fs.writeFileSync(path.join(repository, 'uncommitted.txt'), 'visible without a Session\n');
  projects.registerProject('sessionless-project', repository, 'Sessionless');
  const worktree = projects.getProjectWorktree('sessionless-project');
  assert.ok(worktree);

  const git = await gitPanel.getWorktreeGitPanelData(worktree.id);
  assert.equal(git.worktreeId, worktree.id);
  assert.equal(git.branch, 'main');
  assert.equal(git.changedFiles.some((file) => file.path === 'uncommitted.txt'), true);
  assert.equal(
    git.github.reason,
    'Start a session in this worktree to check pull request status.',
  );
  const diff = await gitPanel.getWorktreeGitDiffData(worktree.id, 'uncommitted.txt');
  assert.equal(diff.sessionId, worktree.id);
  assert.match(diff.diff, /visible without a Session/);

  const files = await workspaceFiles.readWorkspaceRootFiles(worktree.filesystemPath!);
  assert.equal(files.files.includes('README.md'), true);
  assert.equal(files.files.includes('uncommitted.txt'), true);
});
