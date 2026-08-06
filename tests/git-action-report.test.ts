import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeGitActionOrigin,
  describeGitActionToast,
  describeGitRequestFailureToast,
  type GitActionToastKey,
} from '@/components/git/git-action-report';
import type { GitActionFailure, GitActionResult } from '@/types/git';

const COMMITTED: GitActionResult = {
  ok: true,
  outcome: {
    action: 'commit',
    sha: '0f1e2d3',
    subject: 'fix the thing',
    branch: 'feature/0806-t230',
    files: ['src/a.ts'],
  },
};

function failedWith(failure: Partial<GitActionFailure>): GitActionResult {
  return {
    ok: false,
    failure: {
      kind: 'command_failed',
      message: 'fatal: something broke',
      stderr: 'fatal: something broke',
      stdout: '',
      exitCode: 1,
      changedFiles: [],
      ...failure,
    },
  };
}

test('a completed action names where it came from', () => {
  const toast = describeGitActionToast(COMMITTED, 'feature/0806-t230');

  assert.equal(toast.tone, 'success');
  assert.equal(toast.messageKey, 'gitPanel.commit.successToast');
  assert.equal(toast.params.origin, 'feature/0806-t230');
});

test('provenance is the branch, and the worktree only when there is no branch', () => {
  assert.equal(
    describeGitActionOrigin({ branch: 'feature/0806-t230', worktreeName: '0806-t230' }),
    'feature/0806-t230',
  );
  // Detached HEAD reports no branch, and the worktree still says which of the
  // parallel sessions moved.
  assert.equal(
    describeGitActionOrigin({ branch: '', worktreeName: '0806-t230' }),
    '0806-t230',
  );
  assert.ok(describeGitActionOrigin(null).length > 0, 'a toast is never left unattributed');
});

test('a failed action carries the Git error, truncated to something readable', () => {
  const stderr = `error: the first line is what happened\n${'x'.repeat(4000)}`;
  const toast = describeGitActionToast(failedWith({ message: stderr, stderr }), 'main');

  assert.equal(toast.tone, 'error');
  assert.equal(toast.messageKey, 'gitPanel.commit.failureToast');
  assert.equal(toast.params.origin, 'main');
  assert.equal(toast.params.reason, 'error: the first line is what happened');
  assert.ok(
    (toast.params.reason?.length ?? 0) < 400,
    'a toast that long stops being readable',
  );
});

test('a hook rejection is reported as one, not as a generic failure', () => {
  const rejected = describeGitActionToast(
    failedWith({ kind: 'hook_rejected', message: 'lint said no', stderr: 'lint said no' }),
    'main',
  );
  const generic = describeGitActionToast(failedWith({}), 'main');

  assert.equal(rejected.messageKey, 'gitPanel.commit.hookRejectedToast');
  assert.equal(rejected.params.reason, 'lint said no');
  assert.notEqual(generic.messageKey, rejected.messageKey);
});

test('a hook rejection quotes its verdict, not the progress line above it', () => {
  // Git relays the whole of a hook's output, and a hook runner narrates before
  // it fails. The first line is "starting"; the reason is at the bottom.
  const stderr = [
    '✔ Preparing lint-staged...',
    '✖ eslint --fix failed: 2 problems',
    'husky - pre-commit script failed (code 1)',
  ].join('\n');

  const toast = describeGitActionToast(
    failedWith({ kind: 'hook_rejected', message: stderr, stderr }),
    'main',
  );

  assert.equal(toast.params.reason, 'husky - pre-commit script failed (code 1)');
});

test('a hook that refused in silence is not given Git plumbing as its reason', () => {
  // With no stderr the runner's message is "git exited with code 1", which
  // tells the user nothing about their code being refused.
  const toast = describeGitActionToast(
    failedWith({ kind: 'hook_rejected', message: 'git exited with code 1', stderr: '' }),
    'main',
  );

  assert.equal(toast.messageKey, 'gitPanel.commit.hookRejectedNoDetailToast');
  assert.equal(toast.params.reason, undefined);
});

test('a failure keeps the draft so the same button re-runs the action', () => {
  assert.equal(describeGitActionToast(COMMITTED, 'main').clearsDraft, true);
  assert.equal(describeGitActionToast(failedWith({}), 'main').clearsDraft, false);
  assert.equal(
    describeGitActionToast(failedWith({ kind: 'hook_rejected', stderr: '' }), 'main').clearsDraft,
    false,
  );
  assert.equal(describeGitRequestFailureToast('Failed to commit.', 'main').clearsDraft, false);
});

test('every key a report can name resolves to a real string in every locale', async () => {
  // `t()` is typed loosely enough that a key which does not exist compiles and
  // then shows up in the toast verbatim.
  const locales = Object.entries({
    en: (await import('@/lib/i18n/en')).en,
    ko: (await import('@/lib/i18n/ko')).ko,
    ja: (await import('@/lib/i18n/ja')).ja,
    zh: (await import('@/lib/i18n/zh')).zh,
  });

  const keys: GitActionToastKey[] = [
    'gitPanel.commit.successToast',
    'gitPanel.commit.failureToast',
    'gitPanel.commit.hookRejectedToast',
    'gitPanel.commit.hookRejectedNoDetailToast',
    'gitPanel.push.successToast',
    'gitPanel.push.successNoUpstreamToast',
    'gitPanel.push.publishedToast',
    'gitPanel.push.failureToast',
    'gitPanel.push.hookRejectedToast',
    'gitPanel.push.hookRejectedNoDetailToast',
    'gitPanel.pull.successToast',
    'gitPanel.pull.failureToast',
    'gitPanel.pull.hookRejectedToast',
    'gitPanel.pull.hookRejectedNoDetailToast',
  ];

  for (const [language, bundle] of locales) {
    for (const key of keys) {
      const value = key
        .split('.')
        .reduce<unknown>(
          (node, segment) => (node as Record<string, unknown> | undefined)?.[segment],
          bundle,
        );
      assert.equal(typeof value, 'string', `${language} is missing ${key}`);
      assert.match(value as string, /\{\{origin\}\}/, `${language}.${key} drops its provenance`);
    }
  }
});

test('a first push reports the remote branch it created', () => {
  const toast = describeGitActionToast(
    {
      ok: true,
      outcome: {
        action: 'push',
        branch: 'feature/0807-t233',
        remoteBranch: 'origin/feature/0807-t233',
        setUpstream: true,
      },
    },
    'feature/0807-t233',
    'push',
  );

  assert.equal(toast.tone, 'success');
  assert.equal(toast.messageKey, 'gitPanel.push.publishedToast');
  assert.equal(toast.params.remoteBranch, 'origin/feature/0807-t233');
  // Nothing about a push belongs to the commit draft.
  assert.equal(toast.clearsDraft, false);
});

test('a push onto an existing upstream is reported as a push, not as a publish', () => {
  const toast = describeGitActionToast(
    {
      ok: true,
      outcome: {
        action: 'push',
        branch: 'feature/0807-t233',
        remoteBranch: 'origin/feature/0807-t233',
        setUpstream: false,
      },
    },
    'feature/0807-t233',
    'push',
  );

  assert.equal(toast.messageKey, 'gitPanel.push.successToast');
  assert.equal(toast.params.remoteBranch, 'origin/feature/0807-t233');
});

test('a push whose upstream could not be read back still reports the push', () => {
  const toast = describeGitActionToast(
    {
      ok: true,
      outcome: {
        action: 'push',
        branch: 'feature/0807-t233',
        remoteBranch: null,
        setUpstream: false,
      },
    },
    'feature/0807-t233',
    'push',
  );

  // The push landed; a follow-up read that stumbled must not turn it into a
  // report about a remote branch named "null".
  assert.equal(toast.messageKey, 'gitPanel.push.successNoUpstreamToast');
  assert.equal(toast.params.remoteBranch, undefined);
});

test('a failed push says the push failed, not the commit', () => {
  const toast = describeGitActionToast(failedWith({}), 'main', 'push');
  const rejected = describeGitActionToast(
    failedWith({ kind: 'hook_rejected', message: 'pre-push said no', stderr: 'pre-push said no' }),
    'main',
    'push',
  );

  assert.equal(toast.messageKey, 'gitPanel.push.failureToast');
  assert.equal(rejected.messageKey, 'gitPanel.push.hookRejectedToast');
  assert.equal(
    describeGitRequestFailureToast('Session is no longer available', 'main', 'push').messageKey,
    'gitPanel.push.failureToast',
  );
});

test('a request that never reached Git still reports with provenance', () => {
  const toast = describeGitRequestFailureToast('Session is no longer available', 'main');

  assert.equal(toast.tone, 'error');
  assert.equal(toast.messageKey, 'gitPanel.commit.failureToast');
  assert.equal(toast.params.origin, 'main');
  assert.equal(toast.params.reason, 'Session is no longer available');
});

test('a completed pull says where the commits came from', () => {
  const toast = describeGitActionToast(
    {
      ok: true,
      outcome: { action: 'pull', branch: 'main', upstream: 'origin/main' },
    },
    'main',
    'pull',
  );

  assert.equal(toast.tone, 'success');
  assert.equal(toast.messageKey, 'gitPanel.pull.successToast');
  assert.equal(toast.params.remoteBranch, 'origin/main');
  // Nothing about a pull belongs to the commit draft.
  assert.equal(toast.clearsDraft, false);
});

test('a failed pull says the pull failed, not the commit', () => {
  const failed = describeGitActionToast(failedWith({}), 'main', 'pull');

  assert.equal(failed.messageKey, 'gitPanel.pull.failureToast');
  assert.equal(
    describeGitRequestFailureToast('Session is no longer available', 'main', 'pull').messageKey,
    'gitPanel.pull.failureToast',
  );
});

test('a conflicted pull quotes the merge verdict, not the fetch that succeeded', () => {
  // Exactly how a real `git pull` splits itself: the fetch reports the refs it
  // moved on stderr, and the merge narrates to its verdict on stdout. Quoting
  // stderr would tell the user a ref advanced and never that it conflicted.
  const stderr = ['From ../remote', '   08987e7..0bef747  main       -> origin/main'].join('\n');
  const stdout = [
    'Auto-merging seed.txt',
    'CONFLICT (content): Merge conflict in seed.txt',
    'Automatic merge failed; fix conflicts and then commit the result.',
  ].join('\n');

  const toast = describeGitActionToast(
    failedWith({ message: stderr, stderr, stdout }),
    'main',
    'pull',
  );

  assert.equal(
    toast.params.reason,
    'Automatic merge failed; fix conflicts and then commit the result.',
  );
});

test('a pull that Git refused in its own voice is quoted from the top', () => {
  // Git leads with the diagnostic and trails hints, so the last line would be
  // advice rather than the reason — and there is no merge to read instead.
  const stderr = [
    "fatal: couldn't find remote ref topic",
    'hint: check the branch name and try again',
  ].join('\n');

  const toast = describeGitActionToast(
    failedWith({ kind: 'not_found', message: stderr, stderr, stdout: '' }),
    'main',
    'pull',
  );

  assert.equal(toast.params.reason, "fatal: couldn't find remote ref topic");
});

test('Git refusing mid-pull outranks whatever the merge had printed by then', () => {
  // A merge that starts and is then stopped by Git itself: the narration is on
  // stdout, but Git's diagnostic is the reason and it is on stderr.
  const stderr = 'error: Your local changes to the following files would be overwritten by merge:';
  const toast = describeGitActionToast(
    failedWith({ message: stderr, stderr, stdout: 'Updating 08987e7..0bef747' }),
    'main',
    'pull',
  );

  assert.equal(toast.params.reason, stderr);
});
