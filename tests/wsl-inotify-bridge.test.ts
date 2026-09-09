import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWslInotifyArguments,
  buildInotifyExcludeRegex,
  parseInotifyLine,
  parseWslRunningDistros,
  parseWslUncRoot,
  SharedWslInotifyBridgePool,
  type WslInotifyBridgeOptions,
} from '@/lib/workspace-files/wsl-inotify-bridge';

test('shared bridge pool retains one WSL process for identical roots', async () => {
  let created = 0;
  let started = 0;
  let stopped = 0;
  let bridgeOptions: WslInotifyBridgeOptions | undefined;
  const pool = new SharedWslInotifyBridgePool((options) => {
    created += 1;
    bridgeOptions = options;
    return {
      start: () => {
        started += 1;
        options.onEstablished();
      },
      stop: () => { stopped += 1; },
    };
  });
  const root = { distro: 'Ubuntu-24.04', posixPath: '/home/work/.codex/sessions' };
  const received: string[] = [];
  const established: string[] = [];
  const first = pool.acquire({
    root,
    eventMask: 'create,move,close_write',
    onEvent: ({ relativePath }) => received.push(`first:${relativePath}`),
    onEstablished: () => { established.push('first'); },
    onDown: () => {},
  });
  const second = pool.acquire({
    root,
    eventMask: 'create,move,close_write',
    onEvent: ({ relativePath }) => received.push(`second:${relativePath}`),
    onEstablished: () => { established.push('second'); },
    onDown: () => {},
  });

  assert.equal(created, 1);
  assert.equal(started, 1);
  assert.equal(pool.size, 1);
  await Promise.resolve();
  assert.deepEqual(established, ['first', 'second']);
  bridgeOptions?.onEvent({ eventName: 'add', relativePath: '2026/session.jsonl' });
  assert.deepEqual(received, [
    'first:2026/session.jsonl',
    'second:2026/session.jsonl',
  ]);

  first.stop();
  assert.equal(stopped, 0);
  assert.equal(pool.size, 1);
  second.stop();
  assert.equal(stopped, 1);
  assert.equal(pool.size, 0);
});

test('inotify arguments only apply workspace exclusions when the caller supplies them', () => {
  const root = { distro: 'Ubuntu-24.04', posixPath: '/home/work/.codex/sessions' };
  const providerArgs = buildWslInotifyArguments({ root });
  assert.equal(providerArgs.includes('--exclude'), false);

  const providerCreateArgs = buildWslInotifyArguments({
    root,
    eventMask: 'create,move,close_write',
  });
  assert.equal(
    providerCreateArgs[providerCreateArgs.indexOf('-e') + 1],
    'create,move,close_write',
  );

  const excludeRegex = '^/home/work/project/(node_modules|.git)(/|$)';
  const workspaceArgs = buildWslInotifyArguments({ root, excludeRegex });
  const excludeIndex = workspaceArgs.indexOf('--exclude');
  assert.notEqual(excludeIndex, -1);
  assert.equal(workspaceArgs[excludeIndex + 1], excludeRegex);
});

test('parseWslUncRoot extracts distro and posix path from wsl UNC roots', () => {
  assert.deepEqual(
    parseWslUncRoot('\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\proj'),
    { distro: 'Ubuntu-24.04', posixPath: '/home/work/proj' },
  );
  assert.deepEqual(
    parseWslUncRoot('//wsl.localhost/Ubuntu-24.04/home/work/proj'),
    { distro: 'Ubuntu-24.04', posixPath: '/home/work/proj' },
  );
  assert.deepEqual(
    parseWslUncRoot('\\\\wsl$\\Debian\\srv'),
    { distro: 'Debian', posixPath: '/srv' },
  );
  assert.equal(parseWslUncRoot('\\\\fileserver\\share\\dir'), null);
  assert.equal(parseWslUncRoot('/home/work/proj'), null);
  assert.equal(parseWslUncRoot('C:\\Users\\work'), null);
  assert.equal(parseWslUncRoot('\\\\wsl.localhost\\Ubuntu-24.04'), null);
});

test('parseInotifyLine maps inotifywait events onto watch events', () => {
  const root = '/home/work/proj';
  assert.deepEqual(
    parseInotifyLine('CREATE|/home/work/proj/src/new.ts', root),
    { eventName: 'add', relativePath: 'src/new.ts' },
  );
  assert.deepEqual(
    parseInotifyLine('CREATE,ISDIR|/home/work/proj/src/lib', root),
    { eventName: 'addDir', relativePath: 'src/lib' },
  );
  assert.deepEqual(
    parseInotifyLine('DELETE|/home/work/proj/old.txt', root),
    { eventName: 'unlink', relativePath: 'old.txt' },
  );
  assert.deepEqual(
    parseInotifyLine('MOVED_FROM,ISDIR|/home/work/proj/gone', root),
    { eventName: 'unlinkDir', relativePath: 'gone' },
  );
  assert.deepEqual(
    parseInotifyLine('MOVED_TO|/home/work/proj/renamed.md', root),
    { eventName: 'add', relativePath: 'renamed.md' },
  );
  assert.deepEqual(
    parseInotifyLine('CLOSE_WRITE,CLOSE|/home/work/proj/edited.ts\r', root),
    { eventName: 'change', relativePath: 'edited.ts' },
  );
  assert.deepEqual(
    parseInotifyLine('MODIFY|/home/work/proj/edited.ts', root),
    { eventName: 'change', relativePath: 'edited.ts' },
  );

  assert.equal(parseInotifyLine('MODIFY,ISDIR|/home/work/proj/dir', root), null);
  assert.equal(parseInotifyLine('CREATE|/home/other/file.txt', root), null);
  assert.equal(parseInotifyLine('CREATE|/home/work/proj', root), null);
  assert.equal(parseInotifyLine('OPEN|/home/work/proj/read.txt', root), null);
  assert.equal(parseInotifyLine('not-an-event-line', root), null);
});

test('parseWslRunningDistros reads wsl.exe --list --running output', () => {
  assert.deepEqual(parseWslRunningDistros('Ubuntu-24.04\r\n'), ['Ubuntu-24.04']);
  assert.deepEqual(
    parseWslRunningDistros('Ubuntu-24.04\r\nDebian\r\n'),
    ['Ubuntu-24.04', 'Debian'],
  );
  assert.deepEqual(parseWslRunningDistros(''), []);
  // Stray NULs from a mis-decoded UTF-16 stream must not break matching.
  assert.deepEqual(parseWslRunningDistros('U\0b\0u\0n\0t\0u\0\r\0\n\0'), ['Ubuntu']);
});

test('buildInotifyExcludeRegex skips high-churn descendants without excluding a hidden root', () => {
  const regex = new RegExp(buildInotifyExcludeRegex('/home/work/proj'));
  assert.ok(regex.test('/home/work/proj/node_modules/pkg/index.js'));
  assert.ok(regex.test('/home/work/proj/.git/HEAD'));
  assert.ok(regex.test('/home/work/proj/.next/'));
  assert.ok(regex.test('/home/work/proj/dist'));
  assert.equal(regex.test('/home/work/proj/src/.hidden/file.ts'), false);
  assert.equal(regex.test('/home/work/proj/.env.example'), false);
  assert.equal(regex.test('/home/work/proj/src/app/route.ts'), false);
  assert.equal(regex.test('/home/work/proj/distribution/file.ts'), false);
  assert.equal(regex.test('/home/work/proj/outbox/file.ts'), false);

  const hiddenRootRegex = new RegExp(
    buildInotifyExcludeRegex('/home/work/.tessera/worktrees/proj'),
  );
  assert.equal(hiddenRootRegex.test('/home/work/.tessera/worktrees/proj/src/app.ts'), false);
  assert.ok(hiddenRootRegex.test('/home/work/.tessera/worktrees/proj/node_modules/pkg/index.js'));
});
