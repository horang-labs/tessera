export type ControlAuditOperation =
  | 'worktree.create'
  | 'session.create'
  | 'session.start'
  | 'session.launch'
  | 'session.prompt'
  | 'session.send-keys'
  | 'session.stop';

export type ControlAuditTarget =
  | { kind: 'project'; id: string }
  | { kind: 'worktree'; id: string }
  | { kind: 'session'; id: string };

export type ControlAuditOutcome = 'pending' | 'succeeded' | 'failed';

export interface PublicControlAuditRecord {
  id: string;
  projectId: string;
  sourceSessionId: string;
  operation: ControlAuditOperation;
  target: ControlAuditTarget;
  occurredAt: string;
  outcome: ControlAuditOutcome;
  failureCode?: string;
}

export type NewControlAuditAttempt = Omit<
  PublicControlAuditRecord,
  'id' | 'occurredAt' | 'outcome' | 'failureCode'
>;

export interface ControlAuditCompletion {
  target: ControlAuditTarget;
  outcome: Exclude<ControlAuditOutcome, 'pending'>;
  failureCode?: string;
}

export interface ControlAuditHistory {
  list(projectId: string): Promise<PublicControlAuditRecord[]>;
  begin(attempt: NewControlAuditAttempt): Promise<PublicControlAuditRecord>;
  complete(recordId: string, completion: ControlAuditCompletion): Promise<void>;
}

export interface ControlMutationAuditContext<T> {
  projectId: string;
  sourceSessionId: string;
  operation: ControlAuditOperation;
  failureTarget: ControlAuditTarget | (() => ControlAuditTarget);
  successTarget(result: T): ControlAuditTarget;
  failureCode(error: unknown): string | undefined;
}

export async function auditControlMutation<T>(
  history: ControlAuditHistory,
  context: ControlMutationAuditContext<T>,
  mutation: () => Promise<T>,
): Promise<T> {
  const failureTarget = (): ControlAuditTarget => (
    typeof context.failureTarget === 'function'
      ? context.failureTarget()
      : context.failureTarget
  );
  const attempt = await history.begin({
    projectId: context.projectId,
    sourceSessionId: context.sourceSessionId,
    operation: context.operation,
    target: failureTarget(),
  });
  let result: T;
  try {
    result = await mutation();
  } catch (error) {
    const failureCode = context.failureCode(error);
    await settleControlAudit(history, attempt.id, {
      target: failureTarget(),
      outcome: 'failed',
      ...(failureCode === undefined ? {} : { failureCode }),
    });
    throw error;
  }

  await settleControlAudit(history, attempt.id, {
    target: context.successTarget(result),
    outcome: 'succeeded',
  });
  return result;
}

async function settleControlAudit(
  history: ControlAuditHistory,
  recordId: string,
  completion: ControlAuditCompletion,
): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await history.complete(recordId, completion);
      return;
    } catch {
      if (attempt === maxAttempts) {
        // The write-ahead record remains durably pending after bounded retries.
        // Audit finalization must never invert the mutation result it describes.
        return;
      }
    }
  }
}

export function createInMemoryControlAuditHistory(options: {
  now?: () => string;
} = {}): ControlAuditHistory {
  const records: PublicControlAuditRecord[] = [];
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async list(projectId) {
      return records.filter((record) => record.projectId === projectId).map(cloneRecord);
    },
    async begin(attempt) {
      const record: PublicControlAuditRecord = {
        ...cloneRecord(attempt),
        id: `audit-${records.length + 1}`,
        occurredAt: now(),
        outcome: 'pending',
      };
      records.push(record);
      return cloneRecord(record);
    },
    async complete(recordId, completion) {
      const record = records.find((candidate) => candidate.id === recordId);
      if (!record) throw new Error('Control audit attempt does not exist.');
      record.target = { ...completion.target };
      record.outcome = completion.outcome;
      if (completion.failureCode === undefined) delete record.failureCode;
      else record.failureCode = completion.failureCode;
    },
  };
}

function cloneRecord<T extends NewControlAuditAttempt | PublicControlAuditRecord>(record: T): T {
  return { ...record, target: { ...record.target } };
}
