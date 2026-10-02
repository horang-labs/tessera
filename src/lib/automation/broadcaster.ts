import type { DurableAutomation } from './autorun-storage';
import type { AutomationAttention } from './autorun-contracts';
import { wsServer } from '../ws/server';

export function broadcastAutomationMutation(automation: DurableAutomation): void {
  wsServer.sendToUser(automation.ownerUserId, {
    type: 'automation_mutated', automationId: automation.id, revision: automation.revision,
  });
}

export function broadcastAutorunAttention(owner: string, attention: AutomationAttention): void {
  wsServer.sendToUser(owner, { type: 'automation_attention', ...attention });
}
