import type { ClientMessage, AppServerMessage } from '../../src/lib/ws/message-types';
import type { ControlResponse, Selection } from '../../src/lib/automation/contracts';
import type { AutomationRuntime } from '../../src/lib/automation/runtime-port';
import { automationFixture, inheritedSelection, ownershipFixture } from './automation';

export const legacyRaw: ClientMessage = { type: 'terminal_input', requestId: '1', terminalId: 't', surfaceId: 's', data: 'a' };
export const currentRaw: ClientMessage = { ...legacyRaw, inputEpoch: 'opaque' };
export const semantic: ClientMessage = { type: 'terminal_prompt', requestId: '2', submissionId: '2', sessionId: 'session-1', text: 'continue', inputEpoch: 'opaque' };
export const chat: ClientMessage = { type: 'send_message', requestId: '3', sessionId: 'session-1', content: 'continue', inputEpoch: 'opaque' };
export const legacySnapshot: AppServerMessage = { type: 'terminal_snapshot', terminalId: 't', surfaceId: 's', generation: 1, seq: 1, data: '', cols: 80, rows: 24 };
export const currentSnapshot: AppServerMessage = { ...legacySnapshot, inputOwnership: ownershipFixture() };
export const reconnect: AppServerMessage = { type: 'terminal_session_runtime_snapshot', activeSessionIds: ['session-1'], inputOwnerships: [ownershipFixture()] };
export const ack: AppServerMessage = { type: 'terminal_input_result', requestId: '1', terminalId: 't', surfaceId: 's', outcome: 'rejected', code: 'INPUT_OWNERSHIP_STALE', inputOwnership: ownershipFixture() };
export const ownershipEvent: AppServerMessage = { type: 'session_input_ownership', ...ownershipFixture() };
export const mutation: AppServerMessage = { type: 'automation_mutated', automationId: 'rule-1', revision: 2 };
export const draining: ControlResponse = { status: 202, body: { automation: automationFixture(), inputOwnership: { ...ownershipFixture(), mode: 'draining' }, inFlightRunId: 'run-1' } };
export const paused: ControlResponse = { ...draining, status: 200 };
export const wakeArm: Parameters<AutomationRuntime['arm']>[0] = { userId: 'owner-1', sessionId: 'session-1', automationId: 'rule-1', selection: inheritedSelection };

// @ts-expect-error An inherited snapshot cannot be used as explicit fresh-launch selection.
export const invalidFreshSelection: Selection = inheritedSelection;
// @ts-expect-error Raw acknowledgements must include authoritative ownership.
export const invalidAck: AppServerMessage = { type: 'terminal_input_result', requestId: '1', terminalId: 't', surfaceId: 's', outcome: 'accepted' };
