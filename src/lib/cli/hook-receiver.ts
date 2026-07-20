import type { IncomingMessage, ServerResponse } from 'http';
import { resolvePaneToken } from '@/lib/terminal/pane-token-registry';
import { wsServer } from '@/lib/ws/server';
import {
  markCodexTerminalSession,
  markOpenCodeTerminalSession,
  markTerminalLaunched,
} from '@/lib/db/sessions';
import { sessionHistory } from '@/lib/session-history';
import { maybeAutoGenerateProtocolTitle } from './protocol-adapter-auto-title';
import logger from '@/lib/logger';
import { terminalManager } from '@/lib/terminal/shared-terminal-manager';
import { refreshSessionDiffStateInBackground } from '@/lib/git/session-diff-refresh';

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

/** hook_event_name → 상태. null이면 상태 승격 안 함(idle Notification 등). */
function mapEventToStatus(
  event: string,
  payload: Record<string, unknown>,
): { status: TerminalSessionStatus; preview?: string } | null {
  switch (event) {
    case 'SessionStart':
      return { status: 'idle' };
    case 'UserPromptSubmit': // 옵션 이벤트. 등록 시 즉시 running.
    case 'PostToolUse':
      return { status: 'running' };
    case 'Stop':
      // stock Stop payload엔 assistant 텍스트가 없다. 포크 필드가 있으면만 preview로.
      return { status: 'completed', preview: readString(payload.last_assistant_message) || undefined };
    case 'Notification':
      return classifyNotification(payload);
    default:
      return null;
  }
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
      return { status: 'completed', preview: readString(payload.last_assistant_message) || undefined };
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
    const mapped = isCodex
      ? mapCodexEventToStatus(event, payload)
      : mapEventToStatus(event, payload);
    // brick finding: launched 마커는 SessionStart 수신 시 찍는다 = agent가 세션을 실제 persist한 시점.
    if (event === 'SessionStart' && entry.sessionId) {
      if (isCodex) {
        // codex rollout id를 provider_state에 캡처(resume용) + launched 마커 + kind.
        markCodexTerminalSession(entry.sessionId, readString(payload.session_id));
      } else if (isOpenCode) {
        // invocation plugin이 고정한 target id만 별도 키에 저장해 GUI session과 교차 resume하지 않는다.
        const providerSessionId = readString(payload.session_id);
        if (providerSessionId) {
          markOpenCodeTerminalSession(entry.sessionId, providerSessionId);
        }
      } else {
        markTerminalLaunched(entry.sessionId);
      }
    }
    // 터미널 세션 AI 자동 타이틀용: 사용자 프롬프트를 Tessera session-history에 user_message로
    // 기록한다(jsonl 원본 파싱이 아니라 hook payload.prompt 활용). generateAITitle이 이걸 읽는다.
    if (event === 'UserPromptSubmit' && entry.sessionId) {
      const prompt = readString(payload.prompt);
      if (prompt) sessionHistory.recordUserMessage(entry.sessionId, prompt);
    }
    // 턴 종료(Stop) 시 자동 타이틀 1회 — headless의 result 트리거는 터미널 세션엔 오지 않으므로
    // 여기서 발화한다(커스텀 타이틀 없고 미발화일 때만; maybeAutoGenerateProtocolTitle 내부 가드).
    if (event === 'Stop' && entry.sessionId) {
      refreshSessionDiffStateInBackground(entry.sessionId, entry.userId, 'terminal Stop hook');
      maybeAutoGenerateProtocolTitle({
        autoTitleTriggered: terminalAutoTitleTriggered,
        sendAppMessage: (uid, m) => wsServer.sendToUser(uid, m),
        sessionId: entry.sessionId,
        userId: entry.userId,
      });
    }
    if (mapped && entry.sessionId) {
      const message = {
        type: 'session_state',
        sessionId: entry.sessionId,
        terminalId: entry.terminalId,
        status: mapped.status,
        hookEvent: event,
        ...(mapped.preview ? { preview: mapped.preview } : {}),
      } as const;
      terminalManager.recordSessionState(message, entry.userId);
      wsServer.sendToUser(entry.userId, message);
    }
  } catch (err) {
    logger.debug({ err }, 'Terminal hook parse/dispatch skipped (fail-open)');
  }
  return send(204);
}
