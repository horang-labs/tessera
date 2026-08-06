import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { GitActionRejection, type GitActionTarget } from '@/lib/git/git-actions';
import {
  CommitMessageGenerationError,
  generateCommitMessage,
  type OneShotCommitMessageGenerator,
} from '@/lib/git/commit-message-generator';
import type { AgentEnvironment } from '@/lib/settings/types';

const execFileAsync = promisify(execFile);

/**
 * 'wsl' is the environment that reaches a plain local `spawn` on every non-Windows
 * platform, including a server running inside WSL — 'native' there means *Windows*
 * binaries (spawn-cli-runtime.ts:175), which cannot see a distro-local temp repo.
 */
const LOCAL_ENVIRONMENT: AgentEnvironment = 'wsl';
const SKIP_ON_WINDOWS = process.platform === 'win32';

async function withTempRepo(
  run: (target: GitActionTarget, repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-commit-message-'));
  try {
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'test@tessera.local'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Tessera Test'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n');
    fs.writeFileSync(path.join(repoDir, 'other.txt'), 'other\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: repoDir });

    await run({ workDir: repoDir, agentEnvironment: LOCAL_ENVIRONMENT }, repoDir);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

/** Captures the prompt the one-shot call was handed and answers with a fixed reply. */
function recordingGenerator(reply: string | null) {
  const prompts: string[] = [];
  return {
    prompts,
    generate: async (prompt: string) => {
      prompts.push(prompt);
      return reply;
    },
  };
}

test('the message comes back from the one-shot call, prompted with the selection only', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed grew a second line\n');
    fs.writeFileSync(path.join(repoDir, 'other.txt'), 'other changed as well\n');

    const recorder = recordingGenerator('fix: tighten the seed file');
    const message = await generateCommitMessage(
      target,
      ['seed.txt'],
      recorder.generate,
    );

    assert.equal(message, 'fix: tighten the seed file');
    assert.equal(recorder.prompts.length, 1);
    const prompt = recorder.prompts[0];
    assert.match(prompt, /seed\.txt/);
    assert.match(prompt, /seed grew a second line/);
    // The deselected file is a change in the same worktree, and the whole point
    // of the button is that it summarizes what is about to be committed.
    assert.doesNotMatch(prompt, /other\.txt/);
    assert.doesNotMatch(prompt, /other changed as well/);
  });
});

test('a selection of new files still describes them to the model', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    // Git has never heard of these, so `git diff HEAD` says nothing about them
    // and the prompt has to carry the selection itself.
    fs.writeFileSync(path.join(repoDir, 'brand-new.ts'), 'export const x = 1;\n');

    const recorder = recordingGenerator('feat: add brand-new module');
    const message = await generateCommitMessage(
      target,
      ['brand-new.ts'],
      recorder.generate,
    );

    assert.equal(message, 'feat: add brand-new module');
    assert.match(recorder.prompts[0], /brand-new\.ts/);
    assert.match(recorder.prompts[0], /untracked/);
  });
});

test('a quoted or fenced reply lands in the field as a bare message', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');

    const replies = [
      '"fix: tighten the seed"',
      '```\nfix: tighten the seed\n```',
      '```text\nfix: tighten the seed\n```',
      '  fix: tighten the seed  ',
    ];

    for (const reply of replies) {
      const message = await generateCommitMessage(
        target,
        ['seed.txt'],
        async () => reply,
      );
      // Whatever wrapping the model added is presentation, and it would be
      // committed verbatim if it survived into the field.
      assert.equal(message, 'fix: tighten the seed', `reply: ${JSON.stringify(reply)}`);
    }
  });
});

test('a huge diff is capped before it reaches the prompt', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    // A vendored tree or a generated lockfile lands in the change set like any
    // other edit, and the whole diff would otherwise become one CLI argument.
    const huge = Array.from({ length: 40_000 }, (_, i) => `line ${i}`).join('\n');
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), `${huge}\n`);

    const recorder = recordingGenerator('chore: regenerate seed');
    await generateCommitMessage(target, ['seed.txt'], recorder.generate);

    const prompt = recorder.prompts[0];
    assert.ok(
      prompt.length < 80_000,
      `expected a capped prompt, got ${prompt.length} characters`,
    );
    // The model must be told the diff is partial, or it will summarize the
    // first hunk as if it were the whole change.
    assert.match(prompt, /truncated/i);
  });
});

test('a provider that answers with nothing fails as a generation failure', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');

    const generators: Array<OneShotCommitMessageGenerator> = [
      async () => null,
      async () => '   \n  ',
      async () => {
        throw new Error('claude CLI timed out after 30s');
      },
    ];

    for (const generate of generators) {
      const failure = await generateCommitMessage(target, ['seed.txt'], generate).then(
        () => null,
        (error: unknown) => error,
      );

      // A generation failure has to be distinguishable from a bad request: the
      // panel keeps committing available and only the generate button reports it.
      assert.ok(
        failure instanceof CommitMessageGenerationError,
        `expected a CommitMessageGenerationError, got ${String(failure)}`,
      );
      assert.ok(!(failure instanceof GitActionRejection));
    }
  });
});

test('a path outside the current change set never reaches the provider', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target, repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n');

    for (const outsider of ['other.txt', '../escape.txt', 'never-existed.txt']) {
      const recorder = recordingGenerator('should not be asked');
      const rejection = await generateCommitMessage(
        target,
        ['seed.txt', outsider],
        recorder.generate,
      ).then(() => null, (error: unknown) => error);

      assert.ok(
        rejection instanceof GitActionRejection,
        `expected a GitActionRejection for ${outsider}`,
      );
      assert.equal(rejection.code, 'file_not_in_change_set');
      // Reading a file the panel never offered would leak it into a prompt.
      assert.deepEqual(recorder.prompts, []);
    }
  });
});

test('an empty selection never reaches the provider', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (target) => {
    const recorder = recordingGenerator('should not be asked');
    const rejection = await generateCommitMessage(target, [], recorder.generate).then(
      () => null,
      (error: unknown) => error,
    );

    assert.ok(rejection instanceof GitActionRejection);
    assert.equal(rejection.code, 'no_files_selected');
    assert.deepEqual(recorder.prompts, []);
  });
});
