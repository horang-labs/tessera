import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const schema = read('../src/lib/db/schema.ts');
const database = read('../src/lib/db/database.ts');
const persistence = read('../src/lib/session/session-persistence.ts');
const lifecycle = read('../src/lib/session/session-orchestrator-lifecycle.ts');
const restCreate = read('../src/app/api/sessions/route.ts');
const wsActions = read('../src/lib/ws/server-session-actions.ts');

test('schema declares model + reasoning_effort columns and bumps the version', () => {
  assert.match(schema, /SCHEMA_VERSION = 26/);
  assert.match(schema, /model\s+TEXT/);
  assert.match(schema, /reasoning_effort TEXT/);
});

test('database adds the columns via migration v26 and the idempotent guard', () => {
  assert.match(database, /fromVersion < 26/);
  assert.match(database, /addColumnIfMissing\(db, 'sessions', 'model'/);
  assert.match(database, /addColumnIfMissing\(db, 'sessions', 'reasoning_effort'/);
});

test('session creation persists model + reasoningEffort', () => {
  // persistence forwards them to createSession
  assert.match(persistence, /model: options\.model/);
  assert.match(persistence, /reasoningEffort: options\.reasoningEffort/);
  // both create entry points pass them in
  assert.match(restCreate, /persistCreatedSessionRecord\([\s\S]*model,[\s\S]*reasoningEffort,[\s\S]*\}\)/);
  assert.match(wsActions, /persistCreatedSessionRecord\([\s\S]*model,[\s\S]*reasoningEffort,[\s\S]*\}\)/);
});

test('resume falls back to the persisted model/effort when the caller omits them', () => {
  // This is what makes WS-resume / retry / cold-restart preserve ultracode.
  assert.match(lifecycle, /options\.model \?\? session\.model/);
  assert.match(lifecycle, /session\.reasoning_effort/);
});

test('API mapping exposes model + reasoningEffort for stopped sessions', () => {
  const sessions = read('../src/lib/db/sessions.ts');
  assert.match(sessions, /model: row\.model \?\? undefined/);
  assert.match(sessions, /reasoningEffort: row\.reasoning_effort \?\? undefined/);
});
