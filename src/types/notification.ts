export interface Notification {
  id: string;
  sessionId: string;
  type: 'completed' | 'input_required' | 'permission_request' | 'ask_user_question' | 'plan_approval';
  preview: string;
  timestamp: string;
  read: boolean;
  dismissed: boolean;
  actions?: NotificationAction[]; // NEW - for FEAT-003 (Interactive notification buttons)
  /**
   * Orca식 dedup 키. 같은 완료 인스턴스가 replay(재연결/리로드)나 근접 이중
   * 발화로 여러 번 도착해도 하나만 남긴다. 서버가 완료 발생시각 등 안정적
   * 식별자를 실어 보내면 그걸로 구성한다. 없으면 dedup하지 않는다(항상 추가).
   */
  dedupKey?: string;
}

// NEW: Action button definition for FEAT-003
export interface NotificationAction {
  label: string;
  value: string | number;
  primary?: boolean;
}
