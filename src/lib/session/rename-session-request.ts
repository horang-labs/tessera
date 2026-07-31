/**
 * Session rename request
 *
 * 세션 제목 변경의 단일 경로 — 낙관적 업데이트 → PATCH → 실패 시 롤백.
 * 훅이 아닌 순수 함수로 두어, 탭 헤더처럼 useSessionCrud의 전체 스토어 구독을
 * 감당할 수 없는 곳(리렌더가 탭 수만큼 번지는 곳)에서도 같은 경로를 쓰게 한다.
 */

import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import { toast } from '@/stores/notification-store';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import type { useI18n } from '@/lib/i18n';

type Translate = ReturnType<typeof useI18n>['t'];

export async function requestSessionRename(
  sessionId: string,
  newTitle: string,
  t: Translate,
): Promise<void> {
  const session = useSessionStore.getState().getSession(sessionId);
  const oldTitle = session?.title;
  const oldHasCustomTitle = session?.hasCustomTitle;
  const linkedTask = useTaskStore.getState().getTaskBySessionId(sessionId);
  const oldTaskTitle = linkedTask?.title;

  useSessionStore.getState().updateSessionTitle(sessionId, newTitle, true);
  useTaskStore.getState().syncLinkedTaskTitle(sessionId, newTitle);

  try {
    const response = await fetchWithClientId(`/api/sessions/${sessionId}/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle }),
    });

    if (!response.ok) {
      throw new Error(t('errors.renameSessionFailed'));
    }

    toast.success(t('notifications.sessionRenamed'));
  } catch (err) {
    if (oldTitle) {
      useSessionStore.getState().updateSessionTitle(sessionId, oldTitle, oldHasCustomTitle);
    }
    if (linkedTask?.sessions.length === 1 && oldTaskTitle) {
      useTaskStore.getState().syncLinkedTaskTitle(sessionId, oldTaskTitle);
    } else if (oldTitle) {
      useTaskStore.getState().syncLinkedTaskTitle(sessionId, oldTitle);
    }
    toast.error(t('errors.renameSessionFailed'));
    console.error('Rename session error:', err);
  }
}
