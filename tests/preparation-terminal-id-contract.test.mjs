/**
 * A preparation terminal is started by the server and attached to from the
 * browser, and that attach request is validated against SAFE_TERMINAL_ID. An id
 * the rule rejects leaves the runtime running with no way to ever look at it,
 * so the two have to be checked against each other rather than by eye.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSafeTerminalIdPattern() {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src/lib/ws/server-message-routing.ts'),
    'utf8',
  );
  const match = source.match(/const SAFE_TERMINAL_ID = (\/.+\/);/);
  assert.ok(match, 'SAFE_TERMINAL_ID must stay a literal regex in the websocket router');
  const [, literal] = match;
  const lastSlash = literal.lastIndexOf('/');
  return new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1));
}

function readPreparationTerminalPrefix() {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src/lib/projects/preparation-terminal-id.ts'),
    'utf8',
  );
  const match = source.match(/const PREPARATION_TERMINAL_PREFIX = '([^']+)';/);
  assert.ok(match, 'the preparation terminal prefix must stay a literal');
  return match[1];
}

test('a preparation terminal id is one the websocket layer will accept', () => {
  const safeTerminalId = readSafeTerminalIdPattern();
  const prefix = readPreparationTerminalPrefix();
  // The shape task ids actually take: `task_` plus a uuid.
  const taskId = 'task_4c1698f6-4dd2-428d-9608-1dc3baa17d0b';

  assert.equal(
    safeTerminalId.test(`${prefix}${taskId}`),
    true,
    `terminal id "${prefix}${taskId}" is rejected by ${safeTerminalId}, so nothing could attach to it`,
  );
});
