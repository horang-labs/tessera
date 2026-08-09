import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  describeGitActionFailure,
  describeGitActionToast,
  describeGitRequestFailure,
  GIT_FAILURE_TITLE_KEY,
  type GitActionVerb,
} from '@/components/git/git-action-report';
import type { GitFailureKind } from '@/lib/worktrees/git-runner';
import type { GitActionFailure } from '@/types/git';

function failure(overrides: Partial<GitActionFailure> = {}): GitActionFailure {
  return {
    kind: 'command_failed',
    message: 'fatal: something broke',
    stderr: 'fatal: something broke',
    stdout: '',
    exitCode: 1,
    changedFiles: [],
    ...overrides,
  };
}

/**
 * The failure from the reported incident: the summary line is the one Git
 * writes last, and the sentence that explains it is nowhere near the top.
 */
const UPSTREAM_STDERR = [
  'To github.com:horang-labs/tessera.git',
  " ! [rejected]        feature/0803-kq -> feature/0803-kq (non-fast-forward)",
  "fatal: the upstream branch 'refs/heads/feature/0803-kq' is not stored as a remote-tracking branch",
].join('\n');

test('a failed action keeps everything Git said, not just the line the toast quotes', () => {
  const report = describeGitActionFailure(
    failure({ message: UPSTREAM_STDERR, stderr: UPSTREAM_STDERR, exitCode: 128 }),
    'feature/0803-kq',
    'push',
  );

  assert.equal(report.verb, 'push');
  assert.equal(report.stderr, UPSTREAM_STDERR);
  assert.equal(report.exitCode, 128);
  // The whole point: the sentence that explains the failure is the last line,
  // and the toast's one-line summary would have thrown it away.
  assert.match(report.stderr, /not stored as a remote-tracking branch/);
});

test('the banner leads with the same line the toast says', () => {
  const failed = failure({ kind: 'hook_rejected', message: 'lint said no', stderr: 'lint said no' });
  const report = describeGitActionFailure(failed, 'main', 'commit');
  const toast = describeGitActionToast({ ok: false, failure: failed }, 'main', 'commit');

  assert.deepEqual(report.summary, toast);
});

test('a kind this build was never taught is quoted verbatim rather than worded', () => {
  // Another agent adds a `GitFailureKind` on the server; a renderer that had not
  // been rebuilt for it must still say what the server said, in full.
  const message =
    "fatal: the upstream branch 'refs/heads/feature/0803-kq' is not stored as a remote-tracking branch";
  const report = describeGitActionFailure(
    failure({ kind: 'upstream_unresolvable' as GitFailureKind, message, stderr: message }),
    'feature/0803-kq',
    'push',
  );

  assert.equal(report.summary, null, 'an unknown kind gets no house sentence');
  assert.equal(report.message, message);
  // Still attributed to the verb that was pressed, which is what the heading
  // reads off — an unknown kind must not cost the user that too.
  assert.equal(report.verb, 'push');
});

test('an unknown kind is reported whole, where the toast would have truncated it', () => {
  const message = `error: the reason is at the bottom\n${'x'.repeat(4000)}\nfatal: here it is`;
  const report = describeGitActionFailure(
    failure({ kind: 'brand_new_kind' as GitFailureKind, message, stderr: message }),
    'main',
    'pull',
  );

  assert.equal(report.message, message);
  assert.match(report.message, /fatal: here it is/);
});

test('every kind the runner classifies today still gets its house wording', () => {
  const kinds: GitFailureKind[] = [
    'authentication',
    'not_found',
    'hook_rejected',
    'timeout',
    'spawn_failed',
    'command_failed',
  ];

  for (const kind of kinds) {
    const report = describeGitActionFailure(failure({ kind }), 'main', 'push');
    assert.notEqual(report.summary, null, `${kind} lost its summary`);
  }
});

test('a request that never reached Git has no command output to expand', () => {
  const report = describeGitRequestFailure(
    'Session is no longer available',
    'main',
    'create_pr',
  );

  assert.equal(report.verb, 'create_pr');
  assert.equal(report.stderr, '');
  assert.equal(report.stdout, '');
  assert.equal(report.exitCode, null);
  // There is still a report: a dropped request is exactly the case a toast that
  // leaves on a timer loses entirely.
  assert.equal(report.summary?.messageKey, 'gitPanel.pr.failureToast');
  assert.equal(report.message, 'Session is no longer available');
});

test('a conflicted pull keeps both streams, because it wrote to both', () => {
  const stderr = 'From ../remote\n   08987e7..0bef747  main       -> origin/main';
  const stdout = [
    'Auto-merging seed.txt',
    'CONFLICT (content): Merge conflict in seed.txt',
    'Automatic merge failed; fix conflicts and then commit the result.',
  ].join('\n');

  const report = describeGitActionFailure(
    failure({ message: stderr, stderr, stdout }),
    'main',
    'pull',
  );

  assert.equal(report.stderr, stderr);
  assert.equal(report.stdout, stdout);
});

test('every verb has a heading, and every key resolves in every locale', async () => {
  const verbs: GitActionVerb[] = ['commit', 'push', 'pull', 'create_pr', 'abort'];
  const locales = Object.entries({
    en: (await import('@/lib/i18n/en')).en,
    ko: (await import('@/lib/i18n/ko')).ko,
    ja: (await import('@/lib/i18n/ja')).ja,
    zh: (await import('@/lib/i18n/zh')).zh,
  });

  const keys = [
    ...verbs.map((verb) => GIT_FAILURE_TITLE_KEY[verb]),
    'gitPanel.failure.showDetails',
    'gitPanel.failure.hideDetails',
    'gitPanel.failure.dismiss',
    'gitPanel.failure.copyOutput',
    'gitPanel.failure.exitCode',
    'gitPanel.failure.exitCodeUnknown',
    'gitPanel.failure.stderrLabel',
    'gitPanel.failure.stdoutLabel',
    'gitPanel.failure.noOutput',
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
    }
  }

  // A verb without a heading would leave the banner unable to say what failed.
  assert.equal(new Set(Object.values(GIT_FAILURE_TITLE_KEY)).size, verbs.length);
});

/**
 * The wiring, asserted against the source. There is no DOM harness in this
 * repo, and the reporting gap this fixes was never a wrong value — it was a
 * value the renderer computed and then dropped on the floor.
 */
function read(relativePath: string): string {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('the worktree owner keeps the failure until the next action or dismiss', () => {
  const controller = read('src/components/git/use-git-panel-controller.ts');
  const store = read('src/stores/git-panel-store.ts');

  assert.match(
    controller,
    /setWorktreeActionFailure\(\s*worktreeKey,\s*describeGitActionFailure\(/,
  );
  assert.match(
    controller,
    /setWorktreeActionFailure\(\s*worktreeKey,\s*describeGitRequestFailure\(/,
  );
  // Cleared when the next action starts — `markPending` is the one place every
  // action passes through — and on dismiss. A session switch deliberately does
  // not clear a report owned by the same canonical worktree (#311).
  assert.match(store, /actionFailure: pendingVerb \? null : current\.actionFailure/);
  assert.match(
    controller,
    /dismissActionFailure = useCallback\(\(\) => \{\s*if \(worktreeKey\) setWorktreeActionFailure\(worktreeKey, null\)/,
  );
  assert.match(controller, /actionFailure,\n\s*dismissActionFailure,/);
});

test('the toast is still raised — the banner is additive', () => {
  const controller = read('src/components/git/use-git-panel-controller.ts');

  assert.match(controller, /toast\.error\(rendered\)/);
  assert.match(controller, /reportAction\(describeGitActionToast\(result, commitOrigin, verb\)\)/);
});

test('panel-load failure and action failure stay two different things', () => {
  const sections = read('src/components/git/git-panel-sections.tsx');

  // `error` still gates the changed-file list and still draws "Git panel
  // unavailable"; the banner is rendered outside that gate, so a panel that
  // reads fine can still report a command that did not.
  assert.match(sections, /Git panel unavailable/);
  assert.match(sections, /failure\.report \? \(\s*<GitActionFailureBanner/);
});

test('the banner shows what git actually said, and can be dismissed', () => {
  const banner = read('src/components/git/git-action-failure-banner.tsx');

  assert.match(banner, /gitPanel\.failure\.stderrLabel/);
  assert.match(banner, /gitPanel\.failure\.stdoutLabel/);
  assert.match(banner, /gitPanel\.failure\.exitCode/);
  assert.match(banner, /onClick=\{onDismiss\}/);
  // The fallback for a kind with no wording, at the point it is rendered.
  assert.match(banner, /report\.summary\s*\?[\s\S]*?:\s*report\.message\.trim\(\)/);
});

test('the banner renders beside the primary action, not in a toast', () => {
  const panel = read('src/components/git/git-panel.tsx');

  assert.match(panel, /report: controller\.actionFailure/);
  assert.match(panel, /onDismiss: controller\.dismissActionFailure/);
});
