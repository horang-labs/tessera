import type { Automation } from './contracts';
import { wsServer } from '../ws/server';

export function broadcastAutomationMutation(automation: Automation): void {
  wsServer.sendToUser(automation.ownerUserId, {
    type: 'automation_mutated', automationId: automation.id, revision: automation.revision,
  });
}
