import type { ServerTransportMessage } from '@/lib/ws/message-types';

export const SESSION_NOTIFICATION_KINDS = [
  'completed',
  'input_required',
  'permission_request',
  'ask_user_question',
  'plan_approval',
] as const;

export type SessionNotificationKind = (typeof SESSION_NOTIFICATION_KINDS)[number];

export interface SessionNotificationPayload {
  kind: SessionNotificationKind;
  eventId: string;
  title: string;
  preview: string;
  sessionId: string;
  url: string;
}

export const SESSION_NOTIFICATION_FALLBACKS: Record<
  SessionNotificationKind,
  { title: string; preview: string }
> = {
  completed: {
    title: 'Task completed.',
    preview: 'Your Tessera session completed.',
  },
  input_required: {
    title: 'Input required.',
    preview: 'Your Tessera session needs input.',
  },
  permission_request: {
    title: 'Permission requested.',
    preview: 'A tool is waiting for permission.',
  },
  ask_user_question: {
    title: 'Question requires your answer.',
    preview: 'A question is waiting for your answer.',
  },
  plan_approval: {
    title: 'Plan approval required.',
    preview: 'A plan is waiting for approval.',
  },
};

export interface SessionNotificationDescription {
  kind: SessionNotificationKind;
  sessionId: string;
  title: string;
  preview: string;
  promptId?: string;
}

export function sessionNotificationUrl(sessionId: string, promptId?: string): string {
  const search = new URLSearchParams({ session: sessionId });
  if (promptId) search.set('prompt', promptId);
  return `/chat?${search}`;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function describeSessionNotification(
  message: ServerTransportMessage,
): SessionNotificationDescription | null {
  if (message.type === 'notification') {
    const kind = message.event;
    const fallback = SESSION_NOTIFICATION_FALLBACKS[kind];
    return {
      kind,
      sessionId: message.sessionId,
      title: nonEmpty(message.message) ?? fallback.title,
      preview: nonEmpty(message.preview) ?? fallback.preview,
    };
  }

  if (message.type !== 'interactive_prompt') return null;
  const promptId = nonEmpty(message.data.toolUseId) ?? undefined;
  if (message.promptType === 'permission_request') {
    const toolName = nonEmpty(message.data.toolName);
    return {
      kind: 'permission_request',
      sessionId: message.sessionId,
      title: SESSION_NOTIFICATION_FALLBACKS.permission_request.title,
      preview: toolName
        ? `${toolName} is requesting permission to run`
        : SESSION_NOTIFICATION_FALLBACKS.permission_request.preview,
      promptId,
    };
  }
  if (message.promptType === 'ask_user_question') {
    return {
      kind: 'ask_user_question',
      sessionId: message.sessionId,
      title: SESSION_NOTIFICATION_FALLBACKS.ask_user_question.title,
      preview: nonEmpty(message.data.questions?.[0]?.question)
        ?? nonEmpty(message.data.question)
        ?? SESSION_NOTIFICATION_FALLBACKS.ask_user_question.preview,
      promptId,
    };
  }
  if (message.promptType === 'plan_approval') {
    return {
      kind: 'plan_approval',
      sessionId: message.sessionId,
      title: SESSION_NOTIFICATION_FALLBACKS.plan_approval.title,
      preview: 'Waiting for plan approval',
      promptId,
    };
  }
  return null;
}

export function isSessionNotificationPayload(value: unknown): value is SessionNotificationPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<SessionNotificationPayload>;
  return SESSION_NOTIFICATION_KINDS.includes(payload.kind as SessionNotificationKind)
    && typeof payload.eventId === 'string'
    && payload.eventId.length > 0
    && typeof payload.title === 'string'
    && typeof payload.preview === 'string'
    && typeof payload.sessionId === 'string'
    && typeof payload.url === 'string';
}
