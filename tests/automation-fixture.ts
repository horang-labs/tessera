import fs from 'node:fs';
import path from 'node:path';
import { DatabaseWrapper } from '../src/lib/db/database';
import { AUTOMATION_SCHEMA, CREATE_TABLES } from '../src/lib/db/schema';
import { AutomationRepository } from '../src/lib/automation/repository';
import { AutomationService } from '../src/lib/automation/service';
import type { AutomationInput, InputOwnership, SessionSelectionSnapshot } from '../src/lib/automation/contracts';
import type { AutomationRuntime } from '../src/lib/automation/runtime-port';
const SQLite = require('better-sqlite3');
export const selection: SessionSelectionSnapshot = { provider: 'codex', model: 'test-model', reasoningEffort: 'high', serviceTier: 'default', settings: { permissionPolicy: 'inherit-cli', allowPreparationFailure: false } };
export function input(): AutomationInput {
  return { name: 'Scheduled task', enabled: true, target: { kind: 'create-session', worktreeId: 'wt_test', title: 'Task', selection: selection as Required<typeof selection> & { model: string; reasoningEffort: string } }, trigger: { kind: 'interval', anchorAt: 60_000, everyMs: 60_000 }, prompt: 'continue fixture', limits: { maxDispatches: 3, expiresAt: 900_000 } };
}
export function fixture() {
  fs.mkdirSync('tmp', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('tmp/automation-'));
  const db = new DatabaseWrapper(new SQLite(path.join(dir, 'test.db')));
  db.pragma('journal_mode=WAL'); db.exec(CREATE_TABLES); db.exec(AUTOMATION_SCHEMA);
  const repo = new AutomationRepository(db);
  let now = 1000;
  let ownership: InputOwnership = { sessionId: 's', terminalId: 't', epoch: 'human', mode: 'human', automationId: null, runId: null, reason: null };
  const runtime: AutomationRuntime = {
    ownership: () => ownership,
    arm: async (args, commit) => {
      const held: InputOwnership = { ...ownership, mode: 'armed', epoch: 'armed', automationId: args.automationId };
      commit({ kind: 'completed', boundary: { id: 'b', serverInstanceId: 'server', terminalId: 't', generation: 1, sessionId: 's', userId: 'owner', turnSequence: 1, inputRevision: 0, completedAt: now, source: 'confirmed-lead-turn' } }, held);
      ownership = held; return held;
    },
    drain: () => ownership = { ...ownership, mode: 'human', epoch: 'human-2', automationId: null, runId: null },
    releaseRecovery: (_args, commit) => { commit(); return ownership = { ...ownership, mode: 'human', automationId: null, runId: null }; },
    dispatch: async () => ({ kind: 'failed', reason: 'fixture-unimplemented' }),
    reconcileRun: async () => ({ kind: 'unknown', reason: 'fixture-recovery', inputOwnership: ownership }),
  };
  const service = new AutomationService(repo, {
    now: () => now, runtime: () => runtime,
    owner: async () => ({ userId: 'owner', agentEnvironment: 'wsl' }),
    inspect: async () => ({ selection, canonicalWorktreeId: 'wt_test', assertCurrent: () => {} }),
    publish: () => {},
  });
  const createSession = (id: string) => db.prepare(`INSERT INTO sessions
    (id,title,provider,provider_state,model,reasoning_effort,service_tier,worktree_id,created_at,updated_at)
    VALUES (?, 'Fixture', 'codex', '{"kind":"terminal"}', 'test-model', 'high', 'default', 'wt_test', 'test', 'test')`).run(id);
  return { db, repo, service, runtime, createSession, setNow: (value: number) => { now = value; }, close: () => { db.close(); fs.rmSync(dir, { recursive: true }); } };
}
