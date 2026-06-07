import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase } from '../src/lib/db/database';
import {
  createSession,
  getSession,
  updateSession,
  mapSessionRowToApi,
} from '../src/lib/db/sessions';

// Real sql.js round-trip: prove model + reasoningEffort survive the database,
// so an ultracode / opus-4-8 session resumes correctly after the process (and
// the in-memory store) is gone. Env is read by initDatabase() at call time, so
// setting it at module top-level (before the test runs) is sufficient.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-db-test-'));
process.env.TESSERA_DATA_DIR = tmp;
process.env.TESSERA_PRODUCTION_DB = '1';

test('model + reasoningEffort persist through create → get → API mapping', async () => {
  await initDatabase();
  createSession('s-ultra', 'proj-1', 'Title', 'claude-code', {
    model: 'claude-opus-4-8[1m]',
    reasoningEffort: 'ultracode',
  });

  const row = getSession('s-ultra');
  assert.ok(row, 'session row should exist');
  assert.equal(row.model, 'claude-opus-4-8[1m]');
  assert.equal(row.reasoning_effort, 'ultracode');

  const api = mapSessionRowToApi(row, new Set(), new Set());
  assert.equal(api.model, 'claude-opus-4-8[1m]');
  assert.equal(api.reasoningEffort, 'ultracode');
});

test('updateSession patches model + reasoningEffort (resume re-apply path)', async () => {
  await initDatabase();
  createSession('s-upd', 'proj-1', 'Title', 'claude-code', {});
  updateSession('s-upd', { model: 'claude-opus-4-8', reasoning_effort: 'xhigh' });
  const row = getSession('s-upd');
  assert.equal(row?.model, 'claude-opus-4-8');
  assert.equal(row?.reasoning_effort, 'xhigh');
});
