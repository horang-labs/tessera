import type { IncomingMessage, ServerResponse } from 'http';
import { resolvePaneToken } from '@/lib/terminal/pane-token-registry';
import { wsServer } from '@/lib/ws/server';
import {
  markCodexTerminalSession,
  markOpenCodeTerminalSession,
} from '@/lib/db/sessions';
import { sessionHistory } from '@/lib/session-history';
import { maybeAutoGenerateProtocolTitle } from './protocol-adapter-auto-title';
import logger from '@/lib/logger';
import { terminalManager } from '@/lib/terminal/shared-terminal-manager';
import { refreshSessionDiffStateInBackground } from '@/lib/git/session-diff-refresh';
import { applyImmediateSessionTitle } from '@/lib/session/immediate-session-title';
import {
  CLAUDE_LIFECYCLE_EVENTS,
  claudeHookLifecycleHasWorkingSubagents,
  mapClaudeHookLifecycle,
} from '@/lib/cli/providers/claude-code/terminal-hook-lifecycle';
import { classifyAskUserQuestionEvent } from '@/lib/cli/providers/claude-code/ask-user-question-status';
import { extractTerminalProviderSessionIdentity } from '@/lib/terminal/provider-session-identity';
import { getTerminalProviderSessionForTesseraSession } from '@/lib/db/terminal-provider-sessions';
import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import { observeTerminalProviderSession } from '@/lib/terminal/provider-session-observation';

const MAX_BODY_BYTES = 1_000_000;

// 터미널 세션 자동 타이틀을 세션당 1회만 발화하기 위한 가드(서버 프로세스 수명).
// has_custom_title 체크와 이중으로 재생성을 막는다.
const terminalAutoTitleTriggered = new Set<string>();

export type TerminalSessionStatus = 'running' | 'completed' | 'input_required' | 'idle';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); reject(new Error('hook body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function completedStatus(payload: Record<string, unknown>): { status: 'completed'; preview?: string } {
  return { status: 'completed', preview: readString(payload.last_assistant_message) || undefined };
}

/**
 * stock Claude Notification은 권한요청/elicitation/idle 등에 두루 발화한다.
 * 구조화 필드 notification_type을 우선 신뢰하고, 없을 때만 message 키워드로 폴백한다
 * (elicitation_dialog는 message에 'permission'/'approv'가 없어 키워드만으로는 놓친다).
 */
function classifyNotification(payload: Record<string, unknown>): { status: TerminalSessionStatus; preview?: string } | null {
  const notificationType = readString(payload.notification_type) || readString(payload.notificationType);
  const message = readString(payload.message) || readString(payload.title);
  if (notificationType === 'permission_prompt' || notificationType === 'elicitation_dialog') {
    return { status: 'input_required', preview: message || undefined };
  }
  // 구조화 필드가 없는 payload를 위한 폴백(권한요청 문구 키워드).
  const m = message.toLowerCase();
  if (m.includes('permission') || m.includes('approv')) {
    return { status: 'input_required', preview: message || undefined };
  }
  return null; // idle/기타 Notification은 상태 승격 안 함
}

/**
 * OpenCode AskUserQuestion(질문 대기) payload에서 질문 본문 preview를 뽑는다.
 * 플러그인이 opencode question.asked properties를 그대로 실어 보내므로, 알려진
 * 위치를 순서대로 시도한다(구조가 버전에 따라 달라도 상태 승격은 유지).
 */
function readAskUserQuestionPreview(payload: Record<string, unknown>): string | undefined {
  const direct = readString(payload.question) || readString(payload.preview) || readString(payload.title);
  if (direct) return direct;
  const question = payload.question;
  if (question && typeof question === 'object') {
    const text = readString((question as Record<string, unknown>).text)
      || readString((question as Record<string, unknown>).title);
    if (text) return text;
  }
  return undefined;
}

/** hook_event_name → 상태. null이면 상태 승격 안 함(idle Notification 등). */
function mapEventToStatus(
  event: string,
  payload: Record<string, unknown>,
): { status: TerminalSessionStatus; preview?: string } | null {
  // OpenCode 주입 플러그인은 권한 승인 대기(opencode permission.asked)와 질문 대기
  // (question.asked)를 각각 PermissionRequest / AskUserQuestion 훅으로 보낸다. 둘 다
  // 사용자 입력 대기(사이드바 노란 깜빡점)로 승격한다. codex/claude와 달리 opencode는
  // stock Notification을 안 내므로 이 두 훅이 유일한 input_required 신호다.
  const permissionRequest = classifyPermissionRequestEvent(event, payload);
  if (permissionRequest) return permissionRequest;
  switch (event) {
    case 'SessionStart':
      return { status: 'idle' };
    case 'UserPromptSubmit': // 옵션 이벤트. 등록 시 즉시 running.
    case 'PostToolUse':
      return { status: 'running' };
    case 'Stop':
      // stock Stop payload엔 assistant 텍스트가 없다. 포크 필드가 있으면만 preview로.
      return completedStatus(payload);
    case 'AskUserQuestion':
      return { status: 'input_required', preview: readAskUserQuestionPreview(payload) };
    case 'Notification':
      return classifyNotification(payload);
    default:
      return null;
  }
}

function mapClaudeEventToStatus(
  terminalId: string,
  event: string,
  payload: Record<string, unknown>,
): { status: TerminalSessionStatus; preview?: string } | null {
  // AskUserQuestion 질문 카드가 뜬 동안은 input_required(사이드바 노란 깜빡점),
  // 답변 제출(PostToolUse) 시 running 복귀. lifecycle tracker는 이 이벤트를 모른다.
  const askUserQuestion = classifyAskUserQuestionEvent(event, payload);
  if (askUserQuestion) return askUserQuestion;
  const lifecycle = mapClaudeHookLifecycle(terminalId, event, payload);
  if (lifecycle) {
    // Stop/StopFailure가 턴을 닫으면 assistant preview를 실어 완료로 보낸다.
    // (StopFailure payload엔 통상 텍스트가 없어 preview는 undefined가 된다.)
    if ((event === 'Stop' || event === 'StopFailure') && lifecycle.status === 'completed') {
      return completedStatus(payload);
    }
    return {
      ...lifecycle,
      ...(claudeHookLifecycleHasWorkingSubagents(terminalId)
        ? { hasWorkingSubagents: true }
        : {}),
    };
  }
  // lifecycle 소유 이벤트의 null은 "의도적 무시"(턴 종료 후 늦은 curl 등)다.
  // 범용 폴백이 PostToolUse→running으로 되살리면 tombstone이 무력화된다.
  if (CLAUDE_LIFECYCLE_EVENTS.has(event)) return null;
  return mapEventToStatus(event, payload);
}

/**
 * codex hook_event_name → 상태. claude와 별도 테이블(이벤트명·대기 신호가 다름).
 * codex는 blocked를 안 낸다: 사람 입력 경계(PermissionRequest)를 input_required로 보낸다.
 * PermissionRequest 훅은 결정을 반환하지 않으므로 codex 자체 승인 TUI가 xterm에 그대로 뜬다.
 */
function mapCodexEventToStatus(
  event: string,
  payload: Record<string, unknown>,
): { status: TerminalSessionStatus; preview?: string } | null {
  switch (event) {
    case 'SessionStart':
      return { status: 'idle' };
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return { status: 'running' };
    case 'PermissionRequest':
      return { status: 'input_required' };
    case 'Stop':
      return completedStatus(payload);
    default:
      return null;
  }
}

/**
 * POST /__tessera/hook 처리. 인증은 strict(401/403), 앱 처리 실패는 fail-open(204)로
 * claude 훅을 깨지 않는다. (S1 단계에서는 상태를 로깅만 하고, broadcast는 S4에서 켠다.)
 */
export async function handleHookRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number) => { res.statusCode = code; res.end(); };

  // 1) 인증 — strict
  const token = readString(req.headers['x-tessera-pane-token']);
  if (!token) return send(401);
  const entry = resolvePaneToken(token);
  if (!entry) return send(403);

  // 2) 파싱/매핑 — 실패는 fail-open(204)
  try {
    const raw = await readBody(req);
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const event = readString(payload.hook_event_name) || readString(payload.hookEventName);
    const isCodex = entry.providerId === 'codex';
    const isOpenCode = entry.providerId === 'opencode';
    const activeSessionId = entry.sessionId
      ? terminalManager.getSessionIdForTerminal(entry.terminalId, entry.userId)
      : null;
    let sessionId = activeSessionId ?? entry.sessionId;
    const providerIdentity = extractTerminalProviderSessionIdentity(entry.providerId, payload);
    if (activeSessionId && providerIdentity) {
      const currentProviderSessionId = getTerminalProviderSessionForTesseraSession(activeSessionId)
        ?.provider_session_id;
      const discoveredInBackground = payload.tessera_session_activation === 'background'
        || Boolean(currentProviderSessionId && cliProviderRegistry.getProvider(entry.providerId)
          .isBackgroundTerminalSessionFork?.({
          currentProviderSessionId,
          observedProviderSessionId: providerIdentity.providerSessionId,
        }));
      const observation = observeTerminalProviderSession({
        pane: entry,
        identity: providerIdentity,
        activation: discoveredInBackground ? 'background' : 'active',
      });
      if (observation.ignored) return send(204);
      sessionId = observation.sessionId;
    }
    const mapped = isCodex
      ? mapCodexEventToStatus(event, payload)
      : isOpenCode
        ? mapEventToStatus(event, payload)
        : mapClaudeEventToStatus(entry.terminalId, event, payload);
    if (event === 'SessionStart' && sessionId) {
      if (isCodex) {
        // codex rollout id를 provider_state에 캡처(resume용) + launched 마커 + kind.
        markCodexTerminalSession(sessionId, readString(payload.session_id));
      } else if (isOpenCode) {
        // invocation plugin이 고정한 target id만 별도 키에 저장해 GUI session과 교차 resume하지 않는다.
        const providerSessionId = providerIdentity?.providerSessionId ?? '';
        if (providerSessionId) {
          markOpenCodeTerminalSession(sessionId, providerSessionId);
        }
      }
      terminalManager.refreshAppearanceRestartAvailability(sessionId, entry.userId);
    }
    // 첫 프롬프트에서 동기 로컬 제목을 즉시 적용한다. 같은 프롬프트를 history에도
    // 기록해 사용자가 AI 개선을 켠 경우 Stop 시점의 선택적 생성 입력으로 활용한다.
    if (event === 'UserPromptSubmit' && sessionId) {
      const prompt = readString(payload.prompt);
      if (prompt) {
        sessionHistory.recordUserMessage(sessionId, prompt);
        const titleUpdate = applyImmediateSessionTitle(sessionId, prompt);
        if (titleUpdate) {
          wsServer.sendToUser(entry.userId, {
            type: 'session_title_updated',
            sessionId,
            title: titleUpdate.title,
            previousTitle: titleUpdate.previousTitle,
            hasCustomTitle: false,
            silent: true,
          });
        }
      }
    }
    // 실제 턴 완료 시 선택적 AI 제목과 Git 상태를 확정한다. Claude는 lead Stop 뒤에도
    // background child가 실행될 수 있으므로 mapped 상태를 완료 경계로 사용한다.
    if (mapped?.status === 'completed' && sessionId) {
      refreshSessionDiffStateInBackground(sessionId, entry.userId, 'terminal lifecycle completion');
      maybeAutoGenerateProtocolTitle({
        autoTitleTriggered: terminalAutoTitleTriggered,
        sendAppMessage: (uid, m) => wsServer.sendToUser(uid, m),
        sessionId,
        userId: entry.userId,
      });
    }
    if (mapped && sessionId) {
      const message = {
        type: 'session_state',
        sessionId,
        terminalId: entry.terminalId,
        status: mapped.status,
        hookEvent: event,
        ...('hasWorkingSubagents' in mapped && mapped.hasWorkingSubagents
          ? { hasWorkingSubagents: true }
          : {}),
        // 이 상태 발생시각. recordSessionState가 저장해 replay 때 같은 값을 실으므로
        // 클라의 알림 dedup 키가 재연결/재전송에도 안정적으로 같은 완료를 가리킨다.
        stateAt: Date.now(),
        ...(mapped.preview ? { preview: mapped.preview } : {}),
      } as const;
      // 죽었거나 미소유인 pane의 늦은 curl은 브로드캐스트하지 않는다 — 이미
      // runtime 종료로 idle 처리된 세션에 유령 running을 그리게 된다. 클라이언트
      // 재연결 replay에도 없는 상태라 한 번 그려지면 스스로 꺼질 길이 없다.
      if (terminalManager.recordSessionState(message, entry.userId)) {
        wsServer.sendToUser(entry.userId, message);
      }
    }
  } catch (err) {
    logger.debug({ err }, 'Terminal hook parse/dispatch skipped (fail-open)');
  }
  return send(204);
}
