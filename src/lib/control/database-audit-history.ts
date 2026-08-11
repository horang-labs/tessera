import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db/database';
import type {
  ControlAuditHistory,
  ControlAuditOperation,
  ControlAuditOutcome,
  ControlAuditTarget,
  PublicControlAuditRecord,
} from './audit';

interface ControlAuditRow {
  id: string;
  project_id: string;
  source_session_id: string;
  operation: ControlAuditOperation;
  target_kind: ControlAuditTarget['kind'];
  target_id: string;
  occurred_at: string;
  outcome: ControlAuditOutcome;
  failure_code: string | null;
}

export function createDatabaseControlAuditHistory(options: {
  now?: () => string;
} = {}): ControlAuditHistory {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async list(projectId) {
      const rows = getDb().prepare(`
        SELECT id, project_id, source_session_id, operation, target_kind,
               target_id, occurred_at, outcome, failure_code
        FROM control_audit_history
        WHERE project_id = ?
        ORDER BY id ASC
      `).all(projectId) as ControlAuditRow[];
      return rows.map(toPublicRecord);
    },
    async begin(attempt) {
      const id = randomUUID();
      const occurredAt = now();
      getDb().prepare(`
        INSERT INTO control_audit_history (
          id, project_id, source_session_id, operation, target_kind,
          target_id, occurred_at, outcome, failure_code
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL)
      `).run(
        id,
        attempt.projectId,
        attempt.sourceSessionId,
        attempt.operation,
        attempt.target.kind,
        attempt.target.id,
        occurredAt,
      );
      return {
        ...attempt,
        id,
        occurredAt,
        outcome: 'pending',
      };
    },
    async complete(recordId, completion) {
      const result = getDb().prepare(`
        UPDATE control_audit_history
        SET target_kind = ?, target_id = ?, outcome = ?, failure_code = ?
        WHERE id = ? AND outcome = 'pending'
      `).run(
        completion.target.kind,
        completion.target.id,
        completion.outcome,
        completion.failureCode ?? null,
        recordId,
      );
      if (result.changes !== 1) {
        throw new Error('Control audit attempt could not be completed.');
      }
    },
  };
}

function toPublicRecord(row: ControlAuditRow): PublicControlAuditRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceSessionId: row.source_session_id,
    operation: row.operation,
    target: { kind: row.target_kind, id: row.target_id },
    occurredAt: row.occurred_at,
    outcome: row.outcome,
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
  };
}
