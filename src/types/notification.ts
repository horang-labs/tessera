export interface Notification {
  id: string;
  sessionId: string;
  type: 'completed' | 'input_required' | 'permission_request' | 'ask_user_question' | 'plan_approval';
  preview: string;
  timestamp: string;
  read: boolean;
  dismissed: boolean;
  actions?: NotificationAction[]; // NEW - for FEAT-003 (Interactive notification buttons)
}

// NEW: Action button definition for FEAT-003
export interface NotificationAction {
  label: string;
  value: string | number;
  primary?: boolean;
}
