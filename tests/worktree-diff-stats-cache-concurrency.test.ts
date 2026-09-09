import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { invalidateAgentEnvironmentCache } from '@/lib/cli/spawn-cli';
import { flushRecompute } from '@/lib/git/worktree-diff-stats-cache';

const POLL_INTERVAL_MS = 10;
const POLL_TIMEOUT_MS = 5_000;

interface GitProbeFixture {
  controlDir: string;
  createWorkDir(name: string): string;
  startedProbes(): string[];
  activeProbes(): string[];
  completedProbes(): string[];
  release(probeName: string): void;
  releaseAll(): void;
  restore(): void;
}

async function waitFor(
  description: string,
  predicate: () => boolean,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function createGitProbeFixture(): GitProbeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-diff-queue-'));
  const binDir = path.join(root, 'bin');
  const controlDir = path.join(root, 'control');
  const workDirsRoot = path.join(root, 'workdirs');
  fs.mkdirSync(binDir);
  fs.mkdirSync(controlDir);
  fs.mkdirSync(workDirsRoot);

  const probeScriptPath = path.join(binDir, 'git-probe.cjs');
  fs.writeFileSync(probeScriptPath, `
const fs = require('node:fs');
const path = require('node:path');

const controlDir = process.env.TESSERA_DIFF_STATS_TEST_CONTROL;
const workDirsRoot = process.env.TESSERA_DIFF_STATS_TEST_WORKDIRS;
const hasExplicitCwd = process.argv[2] === '-C';
const workDir = hasExplicitCwd ? process.argv[3] : process.cwd();
const command = hasExplicitCwd ? process.argv[4] : process.argv[2];
if (
  !controlDir
  || !workDirsRoot
  || !workDir.startsWith(workDirsRoot + path.sep)
  || command !== 'rev-parse'
) process.exit(0);

const workName = path.basename(workDir);
const countFile = path.join(controlDir, 'count-' + workName);
const count = (fs.existsSync(countFile)
  ? Number.parseInt(fs.readFileSync(countFile, 'utf8'), 10)
  : 0) + 1;
fs.writeFileSync(countFile, String(count));

const probeName = workName + '-' + count;
const marker = (prefix) => path.join(controlDir, prefix + probeName);
fs.writeFileSync(marker('started-'), '');
fs.writeFileSync(marker('active-'), '');

const sleeper = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(marker('release-'))
  && !fs.existsSync(path.join(controlDir, 'release-all'))) {
  Atomics.wait(sleeper, 0, 0, 10);
}

fs.rmSync(marker('active-'), { force: true });
fs.writeFileSync(marker('completed-'), '');
if (workName.startsWith('fail-')) process.exit(1);
process.stdout.write('true\\n');
`);

  const gitPath = path.join(binDir, 'git');
  fs.writeFileSync(gitPath, `#!/bin/sh
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/git-probe.cjs" "$@"
`);
  fs.chmodSync(gitPath, 0o755);
  fs.writeFileSync(path.join(binDir, 'git.cmd'), `@echo off\r
node "%~dp0git-probe.cjs" %*\r
`);

  const previousPath = process.env.PATH;
  const previousControlDir = process.env.TESSERA_DIFF_STATS_TEST_CONTROL;
  const previousWorkDirsRoot = process.env.TESSERA_DIFF_STATS_TEST_WORKDIRS;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.TESSERA_DIFF_STATS_TEST_CONTROL = controlDir;
  process.env.TESSERA_DIFF_STATS_TEST_WORKDIRS = workDirsRoot;
  invalidateAgentEnvironmentCache();

  const matchingFiles = (prefix: string): string[] => (
    fs.readdirSync(controlDir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length))
      .sort()
  );

  return {
    controlDir,
    createWorkDir(name) {
      const workDir = path.join(workDirsRoot, name);
      fs.mkdirSync(workDir);
      return workDir;
    },
    startedProbes: () => matchingFiles('started-'),
    activeProbes: () => matchingFiles('active-'),
    completedProbes: () => matchingFiles('completed-'),
    release(probeName) {
      fs.writeFileSync(path.join(controlDir, `release-${probeName}`), '');
    },
    releaseAll() {
      fs.writeFileSync(path.join(controlDir, 'release-all'), '');
    },
    restore() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousControlDir === undefined) {
        delete process.env.TESSERA_DIFF_STATS_TEST_CONTROL;
      } else {
        process.env.TESSERA_DIFF_STATS_TEST_CONTROL = previousControlDir;
      }
      if (previousWorkDirsRoot === undefined) {
        delete process.env.TESSERA_DIFF_STATS_TEST_WORKDIRS;
      } else {
        process.env.TESSERA_DIFF_STATS_TEST_WORKDIRS = previousWorkDirsRoot;
      }
      invalidateAgentEnvironmentCache();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function cleanupGitProbeFixture(
  fixture: GitProbeFixture,
  computations: Array<Promise<unknown>>,
): Promise<void> {
  fixture.releaseAll();
  await Promise.allSettled(computations);
  fixture.restore();
}

test('worktree diff stats compute one work directory at a time', async () => {
  const fixture = createGitProbeFixture();
  const workDirs = Array.from(
    { length: 5 },
    (_, index) => fixture.createWorkDir(`repo-${index + 1}`),
  );
  const computations = workDirs.map((workDir) => flushRecompute(workDir));

  try {
    await waitFor('the first diff computation to start', () => (
      fixture.activeProbes().length >= 1
    ));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(fixture.activeProbes(), ['repo-1-1']);

    while (fixture.completedProbes().length < workDirs.length) {
      await waitFor('queued work to take an available compute slot', () => (
        fixture.activeProbes().length > 0
        || fixture.completedProbes().length === workDirs.length
      ));
      if (fixture.completedProbes().length === workDirs.length) break;
      const [active] = fixture.activeProbes();
      assert.ok(active, 'a queued computation should start when a slot is available');
      fixture.release(active);
      await waitFor(`${active} to complete`, () => (
        fixture.completedProbes().includes(active)
      ));
      assert.ok(fixture.activeProbes().length <= 1);
    }

    await Promise.all(computations);
  } finally {
    await cleanupGitProbeFixture(fixture, computations);
  }
});

test('requests during an in-flight compute share it and trigger one trailing rerun', async () => {
  const fixture = createGitProbeFixture();
  const workDir = fixture.createWorkDir('repo-shared');
  const computations = [flushRecompute(workDir)];

  try {
    await waitFor('the shared worktree compute to start', () => (
      fixture.activeProbes().includes('repo-shared-1')
    ));

    computations.push(
      flushRecompute(workDir),
      flushRecompute(workDir),
      flushRecompute(workDir),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(fixture.startedProbes(), ['repo-shared-1']);

    fixture.release('repo-shared-1');
    await waitFor('one trailing rerun to start', () => (
      fixture.activeProbes().includes('repo-shared-2')
    ));
    assert.deepEqual(fixture.startedProbes(), ['repo-shared-1', 'repo-shared-2']);

    fixture.release('repo-shared-2');
    await Promise.all(computations);
    assert.deepEqual(fixture.startedProbes(), ['repo-shared-1', 'repo-shared-2']);
  } finally {
    await cleanupGitProbeFixture(fixture, computations);
  }
});

test('a failed git probe releases its slot for queued work', async () => {
  const fixture = createGitProbeFixture();
  const failedWorkDir = fixture.createWorkDir('fail-repo');
  const busyWorkDir = fixture.createWorkDir('busy-repo');
  const queuedWorkDir = fixture.createWorkDir('queued-repo');
  const failed = flushRecompute(failedWorkDir);
  const busy = flushRecompute(busyWorkDir);
  const queued = flushRecompute(queuedWorkDir);
  const computations = [failed, busy, queued];

  try {
    await waitFor('the compute slot to fill', () => fixture.activeProbes().length === 1);
    assert.deepEqual(fixture.activeProbes(), ['fail-repo-1']);

    fixture.release('fail-repo-1');
    await waitFor('the next worktree to use the released slot', () => (
      fixture.activeProbes().includes('busy-repo-1')
    ));
    fixture.release('busy-repo-1');
    await waitFor('the final queued worktree to use the released slot', () => (
      fixture.activeProbes().includes('queued-repo-1')
    ));
    assert.equal(await failed, null);

    fixture.releaseAll();
    await Promise.all(computations);
  } finally {
    await cleanupGitProbeFixture(fixture, computations);
  }
});
