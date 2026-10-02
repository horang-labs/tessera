import type { DatabaseWrapper } from '../db/database';
import { automationInputSchema, sessionSelectionSnapshotSchema, type Automation, type AutomationRun, type InputOwnership, type ControlResult } from './contracts';
import type { ArmEvidence, Boundary, RuntimeObservation } from './runtime-port';

export type StoredAutomation = {
  automation: Automation; ownership: InputOwnership | null; evidence: ArmEvidence | null;
};
export type StoredRun = {
  run: AutomationRun; snapshot: Automation; boundary: Boundary | null;
  leaseEpoch: number | null; permitToken: string | null; externalStarted: boolean;
  completedWrite: boolean; retryAt: number | null; canonicalWorktreeId: string | null;
  overlapHeld: boolean; resolvedAt: number | null; observation: RuntimeObservation | null;
  recoveryStartedAt: number | null; recoveryEpoch: number | null;
  recoveryOwnerInstance: string | null; recoveryStatus: 'none' | 'started' | 'observed' | 'unknown';
};

function readAutomation(json: string): StoredAutomation {
  const value = JSON.parse(json) as StoredAutomation;
  const a = value.automation;
  automationInputSchema.parse({ name: a.name, enabled: a.state === 'enabled', target: a.target, trigger: a.trigger, prompt: a.prompt, limits: a.limits });
  sessionSelectionSnapshotSchema.parse(a.savedSelection);
  return value;
}

function readRun(json: string): StoredRun {
  const value = JSON.parse(json) as StoredRun;
  readAutomation(JSON.stringify({ automation: value.snapshot, ownership: null, evidence: null }));
  sessionSelectionSnapshotSchema.parse(value.run.effectiveSelection);
  return value;
}

export class AutomationRepository {
  constructor(readonly db: DatabaseWrapper) {
    db.pragma('synchronous = FULL');
    if (db.pragma('synchronous') !== 2) throw new Error('Automation requires FULL durability');
  }
  transaction<T>(fn: () => T): T { return this.db.immediateTransaction(fn); }
  get(id: string): StoredAutomation | null {
    const row = this.db.prepare('SELECT config_json FROM session_automations WHERE id=?').get(id);
    return row ? readAutomation(row.config_json) : null;
  }
  all(): StoredAutomation[] {
    return this.db.prepare('SELECT config_json FROM session_automations ORDER BY id').all().map(row => readAutomation(row.config_json));
  }
  save(value: StoredAutomation): void {
    const a = value.automation, o = value.ownership;
    const hold = o && ['armed', 'draining', 'recovery-required'].includes(o.mode) ? o.mode : 'none';
    this.db.prepare(`INSERT INTO session_automations VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state,next_due_at=excluded.next_due_at,
      input_hold=excluded.input_hold,held_session_id=excluded.held_session_id,input_epoch=excluded.input_epoch,config_json=excluded.config_json`)
      .run(a.id, a.ownerUserId, a.revision, a.state, a.target.kind === 'wake-session' ? a.target.sessionId : null,
        a.nextDueAt, hold, o?.sessionId ?? null, o?.epoch ?? null, JSON.stringify(value));
  }
  run(id: string): StoredRun | null {
    const row = this.db.prepare('SELECT snapshot_json FROM session_automation_runs WHERE id=?').get(id);
    return row ? readRun(row.snapshot_json) : null;
  }
  runs(automationId?: string): StoredRun[] {
    const rows = automationId
      ? this.db.prepare('SELECT snapshot_json FROM session_automation_runs WHERE automation_id=? ORDER BY due_at DESC,id DESC').all(automationId)
      : this.db.prepare('SELECT snapshot_json FROM session_automation_runs ORDER BY due_at DESC,id DESC').all();
    return rows.map(row => readRun(row.snapshot_json));
  }
  recoverySessionIds(): ReadonlySet<string> {
    // Retained ownership is independent of current rule/run state. In particular,
    // deleted/stopped/unknown records must never fall through to generic respawn.
    return new Set(this.db.prepare(`SELECT DISTINCT session_id FROM session_automation_runs
      WHERE session_id IS NOT NULL AND json_extract(snapshot_json,'$.snapshot.target.kind')='create-session'`)
      .all().map(row => row.session_id as string));
  }
  activeRuns(automationId?: string): StoredRun[] {
    const condition = "(state IN ('pending','deferred','dispatching') OR (state='unknown' AND json_extract(snapshot_json,'$.resolvedAt') IS NULL))";
    const rows = automationId ? this.db.prepare(`SELECT snapshot_json FROM session_automation_runs WHERE ${condition} AND automation_id=?`).all(automationId)
      : this.db.prepare(`SELECT snapshot_json FROM session_automation_runs WHERE ${condition} OR overlap_held=1`).all();
    return rows.map(row => readRun(row.snapshot_json));
  }
  dueRuns(now: number): StoredRun[] {
    return this.db.prepare(`SELECT snapshot_json FROM session_automation_runs WHERE state IN ('pending','deferred')
      AND due_at<=? AND (retry_at IS NULL OR retry_at<=?) ORDER BY due_at,id`).all(now, now).map(row => readRun(row.snapshot_json));
  }
  observedRuns(userId: string, sessionId: string): StoredRun[] {
    return this.db.prepare(`SELECT snapshot_json FROM session_automation_runs WHERE owner_user_id=? AND session_id=?
      AND state IN ('dispatching','delivered','unknown')`).all(userId, sessionId).map(row => readRun(row.snapshot_json));
  }
  occurrenceExists(automationId: string, revision: number, key: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM session_automation_runs WHERE automation_id=? AND
      (state IN ('pending','deferred','dispatching') OR (automation_revision=? AND occurrence_key=?)) LIMIT 1`).get(automationId, revision, key));
  }
  overlapExists(id: string, automationId: string, worktreeId: string | null): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM session_automation_runs WHERE id!=? AND overlap_held=1
      AND (automation_id=? OR canonical_worktree_id=?) LIMIT 1`).get(id, automationId, worktreeId));
  }
  saveRun(value: StoredRun): void {
    const r = value.run;
    this.db.prepare(`INSERT INTO session_automation_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,retry_at=excluded.retry_at,session_id=excluded.session_id,
      overlap_held=excluded.overlap_held,snapshot_json=excluded.snapshot_json`)
      .run(r.id, r.automationId, r.automationRevision, value.snapshot.ownerUserId, r.occurrenceKey, r.state,
        r.dueAt, value.retryAt, r.sessionId, value.canonicalWorktreeId, value.overlapHeld ? 1 : 0, JSON.stringify(value));
  }
  replay(owner: string, key: string): { hash: string; response: ControlResult } | null {
    const row = this.db.prepare('SELECT * FROM session_automation_idempotency WHERE owner_user_id=? AND key=?').get(owner, key);
    return row ? { hash: row.request_hash, response: JSON.parse(row.response_json) } : null;
  }
  remember(owner: string, key: string, hash: string, response: ControlResult, now: number): void {
    this.db.prepare('INSERT INTO session_automation_idempotency VALUES (?,?,?,?,?)').run(owner, key, hash, JSON.stringify(response), now);
  }
  acquireLease(instance: string, now: number): number | null {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM session_automation_scheduler WHERE id=1').get();
      if (row && row.instance_id !== instance && row.lease_until > now) return null;
      const epoch = row ? row.lease_epoch + (row.instance_id !== instance || row.lease_until <= now ? 1 : 0) : 1;
      this.db.prepare(`INSERT INTO session_automation_scheduler VALUES (1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET instance_id=excluded.instance_id, lease_epoch=excluded.lease_epoch,
        lease_until=excluded.lease_until, heartbeat_at=excluded.heartbeat_at`).run(instance, epoch, now + 20_000, now);
      return epoch;
    });
  }
  ownsLease(instance: string, epoch: number, now: number): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM session_automation_scheduler
      WHERE id=1 AND instance_id=? AND lease_epoch=? AND lease_until>? AND heartbeat_at<=?`).get(instance, epoch, now, now));
  }
  releaseLease(instance: string, epoch: number): void {
    this.db.prepare('UPDATE session_automation_scheduler SET lease_until=0 WHERE instance_id=? AND lease_epoch=?').run(instance, epoch);
  }
}
