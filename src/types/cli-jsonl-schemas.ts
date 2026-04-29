/**
 * Claude CLI JSONL 세션 파일 — 전체 메시지 스키마
 *
 * CLI `--output-format stream-json` 출력의 모든 메시지 타입을 정의.
 * 실제 JSONL 데이터 (~160MB+, CLI 2.0.77~2.1.42)에서 추출한 정확한 스키마.
 *
 * 최상위 7개 타입: assistant, user, progress, system,
 * file-history-snapshot, queue-operation, custom-title
 */

// =============================================================================
// PART 0: 공통 타입
// =============================================================================

/**
 * 모든 메시지(user, assistant, progress, system)에 공통으로 존재하는 envelope 필드.
 * file-history-snapshot, queue-operation, custom-title은 이 envelope을 사용하지 않음.
 */
export interface BaseJsonlEnvelope {
  /**
   * 부모 메시지 UUID. 대화 트리 구조의 링크.
   * - `null`: 루트 메시지 (세션 첫 메시지, compact_boundary 등)
   * - UUID: 이전 메시지를 가리킴 (assistant 스트리밍 청크는 이전 청크를 가리킴)
   */
  parentUuid: string | null;

  /** 사이드체인(분기) 여부. 에이전트 세션에서 `true`. */
  isSidechain: boolean;

  /** 사용자 유형. CLI에서는 항상 `"external"`. */
  userType: 'external';

  /** 메시지 생성 시 작업 디렉토리. */
  cwd: string;

  /** 세션 UUID. JSONL 파일명(확장자 제외)과 일치. */
  sessionId: string;

  /** Claude CLI 버전 (예: `"2.1.41"`). */
  version: string;

  /** 현재 git 브랜치. detached 시 `"HEAD"`. */
  gitBranch: string;

  /**
   * 세션 슬러그 — 사람이 읽을 수 있는 세션 이름 (예: `"adaptive-spinning-valley"`).
   * 세션 초기에는 `null` 또는 없음. CLI가 대화 주제를 파악한 후 생성됨.
   * 한번 생성되면 이후 모든 메시지에 동일 값.
   */
  slug?: string | null;

  /** ISO 8601 타임스탬프. */
  timestamp: string;

  /** 이 JSONL 줄의 고유 UUID. */
  uuid: string;
}

// =============================================================================
// PART 1: assistant — Claude 응답 메시지
// =============================================================================

/**
 * assistant JSONL 줄 하나 = API 응답의 스트리밍 청크 하나.
 *
 * 재조립 규칙:
 * 1. 동일 `requestId` (또는 `message.id`)로 그룹핑
 * 2. `timestamp` 순서 또는 `parentUuid` 체인 순서로 정렬
 * 3. 각 청크의 `message.content` 배열을 연결 → 완전한 응답
 * 4. 각 청크에는 content 블록이 정확히 1개
 *
 * 전형적 순서: text("\n\n") → thinking → text(본문) → tool_use × N
 */
export interface AssistantMessage extends BaseJsonlEnvelope {
  type: 'assistant';

  /** Anthropic Messages API 응답 envelope. */
  message: AssistantMessageEnvelope;

  /**
   * API 요청 ID. 동일 API 호출의 모든 청크가 공유.
   * CLI >= 2.0.77에서 존재. 구버전/OpenRouter에서는 없을 수 있음 → `message.id`로 대체.
   */
  requestId?: string;

  /**
   * API 에러 메시지 여부. `true`면 `message.content`에 에러 설명 포함.
   */
  isApiErrorMessage?: boolean;

  /** 에러 타입. `isApiErrorMessage: true`일 때만 존재. 관찰 값: `"rate_limit"`. */
  error?: string;

  /** 서브에이전트 ID (7자 해시). Task 도구로 생성된 에이전트 세션에서 존재. */
  agentId?: string;
}

/** Anthropic Messages API 응답 envelope. 모든 청크에서 `id`, `model`은 동일. */
export interface AssistantMessageEnvelope {
  /**
   * API 메시지 ID. 동일 응답의 모든 청크가 공유.
   * - Anthropic 직접: `"msg_01VbA..."` (msg_ 접두사)
   * - OpenRouter: `"gen-177039..."` (gen- 접두사)
   * - 합성/에러: UUID 형식
   */
  id: string;

  /**
   * 모델 ID.
   * - Anthropic 직접: `"claude-opus-4-6"`, `"claude-sonnet-4-5-20250929"`
   * - OpenRouter: `"anthropic/claude-opus-4.6"`
   * - 서드파티: `"qwen/qwen3-coder-next"`
   * - 에러/합성: `"<synthetic>"`
   */
  model: string;

  /** 항상 `"message"`. */
  type: 'message';

  /** 항상 `"assistant"`. */
  role: 'assistant';

  /** 콘텐츠 블록 배열. 청크당 정확히 1개. */
  content: ContentBlock[];

  /**
   * 생성 중지 이유.
   *
   * JSONL에서는 99.8%가 `null` (중간 청크 AND 최종 청크 모두).
   * `stop_reason`은 최종 청크를 구분하는 신뢰할 수 있는 지표가 아님.
   *
   * 최종 청크 식별법: usage 객체에 `server_tool_use`, `iterations`, `speed` 같은
   * 추가 필드가 있으면 최종 청크.
   */
  stop_reason: 'end_turn' | 'tool_use' | 'stop_sequence' | null;

  /** 중지 시퀀스. 거의 항상 `null`. */
  stop_sequence: string | null;

  /** 토큰 사용량. 최종 청크에서 가장 완전한 데이터. */
  usage: UsageObject;
}

// ---- Content Block 타입 (4종) ----

/** assistant 메시지의 모든 콘텐츠 블록 유니온. */
export type ContentBlock =
  | TextContentBlock
  | ThinkingContentBlock
  | RedactedThinkingContentBlock
  | ToolUseContentBlock;

/** 텍스트 응답. 첫 청크는 보통 `"\n\n"` (빈 줄). */
export interface TextContentBlock {
  type: 'text';
  text: string;
  /** 인용 참조. 현재까지 항상 `null`. */
  citations?: null;
}

/** 확장 사고 과정. Extended Thinking 활성화 시에만 존재. */
export interface ThinkingContentBlock {
  type: 'thinking';
  /** 모델의 내부 추론 텍스트. */
  thinking: string;
  /** 사고 블록의 암호화 서명 (base64). API 검증용. */
  signature: string;
}

/** 검열된 사고 과정. OpenRouter 프록시 요청 등에서 발생. */
export interface RedactedThinkingContentBlock {
  type: 'redacted_thinking';
  /** base64 인코딩된 암호화 사고 데이터. */
  data: string;
}

/** 도구 호출 요청. 각 도구 호출마다 별도 청크로 전송. */
export interface ToolUseContentBlock {
  type: 'tool_use';
  /** 도구 호출 고유 ID. 형식: `"toolu_01LcGmBG..."` */
  id: string;
  /** 도구 이름 (예: `"Bash"`, `"Read"`, `"mcp__plugin_playwright_playwright__browser_click"`). */
  name: string;
  /** 도구 호출 인자. 도구별 스키마가 다름. */
  input: Record<string, unknown>;
}

// ---- Usage 객체 ----

/**
 * 토큰 사용량 통계.
 *
 * 중간 청크에서는 `input_tokens`, `output_tokens`만 있거나 placeholder 값일 수 있음.
 * 최종 청크에서 `server_tool_use`, `iterations`, `speed` 등 추가 필드 존재.
 */
export interface UsageObject {
  input_tokens: number;
  output_tokens: number;
  /** 프롬프트 캐시에 기록된 토큰. 캐시 미지원 시 `null`. */
  cache_creation_input_tokens: number | null;
  /** 프롬프트 캐시에서 읽은 토큰. 캐시 미지원 시 `null`. */
  cache_read_input_tokens: number | null;
  /** 캐시 생성 상세. 캐시 미지원 시 `null`. */
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  } | null;
  /** 서비스 등급. `"standard"` 또는 `null`. */
  service_tier?: 'standard' | null;
  /** 추론 지역. `"not_available"`, `""`, `null` 등. */
  inference_geo?: string | null;
  /** 서버측 도구 사용 통계. 최종 청크에서만 존재. */
  server_tool_use?: {
    web_search_requests: number;
    web_fetch_requests: number;
  } | null;
  /** 반복 메타데이터. 최종 청크에서만 존재. 항상 `[]`. */
  iterations?: unknown[] | null;
  /** 응답 속도 등급. 최종 청크에서만 존재. `"standard"` 또는 `null`. */
  speed?: 'standard' | null;
  /** OpenRouter 서드파티 모델의 비용 (USD). */
  cost?: number | null;
}

// =============================================================================
// PART 2: user — 사용자 입력 / 도구 결과 메시지
// =============================================================================

/**
 * user 메시지는 2가지 역할:
 * 1. 사용자가 직접 타이핑한 입력 (toolUseResult 없음)
 * 2. 도구 실행 결과를 모델에 피드백 (toolUseResult 있음)
 *
 * `isMeta: true`인 경우 CLI가 자동 주입한 컨텍스트 (스킬 프롬프트 등).
 */
export interface UserMessage extends BaseJsonlEnvelope {
  type: 'user';

  /**
   * 메시지 내용.
   * - 일반 입력: `{ role: "user", content: "텍스트" }` (string)
   * - 멀티파트: `{ role: "user", content: [{ type: "text", text: "..." }] }` (array)
   * - 도구 결과: `{ role: "user", content: [{ type: "tool_result", ... }] }` (array)
   */
  message: {
    role: 'user';
    content: string | UserContentPart[];
  };

  // ---- 도구 결과 관련 ----

  /**
   * 도구 실행의 구조화된 결과. 도구 결과 메시지에만 존재.
   *
   * `message.content[].content`는 모델에 보내는 텍스트 직렬화 버전이고,
   * 이 필드는 UI 렌더링용 구조화 객체. 도구별 스키마가 다름.
   *
   * 에러 시 문자열: `"Error: ..."`, `"User rejected tool use"`, `"Sibling tool call errored"`
   *
   * @see ToolUseResult (tool-use-results.ts)
   */
  toolUseResult?: ToolUseResult;

  /**
   * 이 도구 결과를 요청한 assistant 메시지의 UUID.
   * `toolUseResult`가 있는 모든 메시지에 존재.
   *
   * 예: assistant(uuid="AAA") → tool_use → user(sourceToolAssistantUUID="AAA") → tool_result
   */
  sourceToolAssistantUUID?: string;

  // ---- 사용자 입력 메타데이터 ----

  /**
   * 현재 권한 모드. 사용자가 직접 입력한 메시지에만 존재.
   * - `"bypassPermissions"`: --dangerously-skip-permissions (YOLO 모드)
   * - `"plan"`: 플랜 모드 (Shift+Tab). 코드 변경 불가.
   * - 없음: 일반(기본) 모드. 위험한 동작마다 승인 요청.
   */
  permissionMode?: 'bypassPermissions' | 'plan';

  /**
   * 확장 사고 토큰 예산. Extended Thinking 활성화 세션의 사용자 입력에만 존재.
   * 미지원 모델(Haiku 등)이나 비활성화 시 없음.
   */
  thinkingMetadata?: { maxThinkingTokens: number };

  /**
   * 해당 시점의 내부 태스크 리스트 스냅샷. 사용자 입력 시 존재.
   * 대부분 빈 배열 `[]`. 실제 태스크 생성/변경은 TodoWrite 결과에서.
   */
  todos?: TodoItem[];

  // ---- 시스템 주입 플래그 ----

  /**
   * CLI가 자동 주입한 메시지 여부. `true`면 사용자가 입력한 것이 아님.
   *
   * 4가지 주입 패턴:
   * 1. 스킬 SKILL.md 주입 — /skill 슬래시 커맨드 실행 시 (+ sourceToolUseID)
   * 2. 슬래시 커맨드 오케스트레이터 — /aidlc 같은 커맨드
   * 3. 로컬 커맨드 caveat — /config 등 실행 시 경고
   * 4. 태스크 에이전트 지시사항
   *
   * Tessera에서는 채팅 버블로 표시하지 않거나 접이식 처리.
   */
  isMeta?: boolean;

  /**
   * isMeta 스킬 주입 메시지에서, 주입을 트리거한 tool_use ID (`toolu_*`).
   *
   * sourceToolAssistantUUID와의 차이:
   * - sourceToolAssistantUUID = assistant 메시지의 UUID → 모든 tool_result에 존재
   * - sourceToolUseID = 특정 toolu_* ID → isMeta 스킬 주입에만 존재
   *
   * 한 번의 /skill 실행 → user 메시지 2개 생성:
   *   (1) tool_result (sourceToolAssistantUUID 포함)
   *   (2) isMeta=true (sourceToolUseID 포함)
   */
  sourceToolUseID?: string;

  // ---- 컨텍스트 압축 ----

  /**
   * 컨텍스트 압축 요약 메시지 여부.
   * 대화가 토큰 한계에 도달하면 CLI가 이전 대화를 요약 주입.
   * 항상 `isVisibleInTranscriptOnly: true`와 쌍으로 나타남.
   * 직전에 system `compact_boundary` 메시지가 선행.
   */
  isCompactSummary?: boolean;

  /**
   * JSONL 기록 전용 메시지. 활성 대화 UI에서는 숨겨야 함.
   * 현재까지 `isCompactSummary`와 항상 쌍으로만 관찰됨.
   */
  isVisibleInTranscriptOnly?: boolean;

  // ---- 에이전트/플랜 ----

  /** 서브에이전트 ID (7자 해시). 에이전트 세션 메시지에서 존재. */
  agentId?: string;

  /**
   * 플랜 모드에서 구현 모드로 전환 시 플랜 텍스트.
   * `message.content`는 "Implement the following plan:\n\n{플랜}" 형식이고,
   * 이 필드는 접두사 없이 플랜 텍스트만 별도 저장.
   * UI에서 플랜 마크다운 패널을 렌더링할 때 사용.
   */
  planContent?: string;
}

/** user 메시지의 content 배열 요소. */
export type UserContentPart =
  | { type: 'text'; text: string }
  | UserToolResultPart;

/** 도구 실행 결과를 담는 content 파트. */
export interface UserToolResultPart {
  type: 'tool_result';
  /** 대응하는 tool_use 블록의 ID. */
  tool_use_id: string;
  /** 모델에 보내는 텍스트화된 결과. 에러 시 `<tool_use_error>` 태그 포함. */
  content: string;
  /** 에러 여부. `true`면 content에 `<tool_use_error>` 포함. */
  is_error?: boolean;
}

// =============================================================================
// PART 3: progress — 실시간 진행 상황 (7개 data.type)
// =============================================================================

/** progress 메시지 envelope. */
export interface ProgressMessage extends BaseJsonlEnvelope {
  type: 'progress';

  /**
   * 이 이벤트의 ID. 형식은 subtype별로 다름:
   * - bash_progress: `"bash-progress-N"` (증가 카운터)
   * - agent_progress: `"agent_msg_XXXXX"` (API msg ID 형식)
   * - mcp_progress: `"toolu_XXXXX"` (tool_use ID와 동일)
   * - hook_progress: UUID (parentToolUseID와 동일)
   * - waiting_for_task: `"task-output-waiting-TIMESTAMP"`
   * - search_results_received: `"srvtoolu_XXXXX"`
   * - query_update: `"search-progress-N"`
   */
  toolUseID: string;

  /**
   * 부모 tool_use ID.
   * - hook_progress, mcp_progress: toolUseID와 동일
   * - bash_progress, agent_progress, waiting_for_task: 감싸고 있는 toolu_* ID
   * - search_results_received, query_update: WebSearch의 tool_use ID
   */
  parentToolUseID: string;

  /** subtype별 페이로드. */
  data: ProgressData;
}

/** 7개 progress subtype의 discriminated union. */
export type ProgressData =
  | BashProgressData
  | AgentProgressData
  | McpProgressData
  | HookProgressData
  | WaitingForTaskData
  | SearchResultsReceivedData
  | QueryUpdateData;

/** Bash 명령 실행 중 주기적 상태 업데이트 (~1초 간격). */
export interface BashProgressData {
  type: 'bash_progress';
  /** stdout/stderr 꼬리 부분 (마지막 가시 영역). 아직 없으면 `""`. */
  output: string;
  /** 전체 누적 stdout/stderr. 아직 없으면 `""`. */
  fullOutput: string;
  /** 명령 시작 후 경과 초 (2, 3, 4, ...). */
  elapsedTimeSeconds: number;
  /** 현재까지 출력된 줄 수. */
  totalLines: number;
  /** 이 명령의 타임아웃 (ms). CLI가 제공하지 않으면 생략될 수 있다. */
  timeoutMs?: number;
}

/**
 * 서브에이전트(Task 도구) 진행 상황.
 * `data.message`에 에이전트로 전송되는 전체 메시지가 포함 (재귀적).
 */
export interface AgentProgressData {
  type: 'agent_progress';
  /** 에이전트에 디스패치되는 user 메시지. */
  message: {
    type: 'user';
    message: { role: 'user'; content: Array<{ type: 'text'; text: string }> };
    uuid: string;
    timestamp: string;
  };
  /** 정규화된 메시지 배열. 현재까지 항상 `[]`. */
  normalizedMessages: unknown[];
  /** 에이전트에 보낸 프롬프트 텍스트. */
  prompt: string;
  /** 에이전트 인스턴스 ID (7자 해시, 예: `"a8265be"`). */
  agentId: string;
  /** 재개(resume) 시 재개 대상 에이전트 ID. 첫 호출 시 없음. */
  resume?: string;
  /** 현재 단계 번호 (1부터 시작) */
  currentStep?: number;
  /** 전체 단계 수 */
  totalSteps?: number;
  /** 진행률 (0-100 퍼센트) */
  progressPercent?: number;
  /** 현재 단계 이름 (예: "분석 중", "코드 생성 중") */
  phaseName?: string;
}

/** MCP 도구 호출 상태 업데이트. 시작/완료/실패 시 발생. */
export interface McpProgressData {
  type: 'mcp_progress';
  /** 상태: started → completed 또는 failed. */
  status: 'started' | 'completed' | 'failed';
  /** MCP 서버 이름 (예: `"plugin:playwright:playwright"`). */
  serverName: string;
  /** MCP 도구 이름 (예: `"browser_navigate"`). */
  toolName: string;
  /** 경과 시간(ms). `"completed"` 또는 `"failed"` 시에만 존재. */
  elapsedTimeMs?: number;
  /** 도구 input 파라미터 (UI 미리보기용) */
  toolInput?: Record<string, any>;
  /** failed 상태일 때 에러 메시지 */
  errorMessage?: string;
  /** 시작 시각 (ISO 8601 타임스탬프) */
  startTimestamp?: string;
}

/** 훅 실행 진행. 라이프사이클 이벤트별 발생. */
export interface HookProgressData {
  type: 'hook_progress';
  /** 훅 트리거 이벤트: `"SessionStart"`, `"PostToolUse"`, `"Stop"` 등. */
  hookEvent: string;
  /** 훅 표시 이름 (예: `"PostToolUse:Glob"`, `"SessionStart:clear"`). */
  hookName: string;
  /** 실행 명령 경로 또는 `"callback"`. */
  command: string;
}

/** 백그라운드 태스크 대기 상태. */
export interface WaitingForTaskData {
  type: 'waiting_for_task';
  /** 태스크 설명 (예: `"Start dev server"`). */
  taskDescription: string;
  /** 태스크 유형: `"local_agent"` 또는 `"local_bash"`. */
  taskType: 'local_agent' | 'local_bash';
}

/** WebSearch 결과 수신 알림. query_update 뒤에 발생. */
export interface SearchResultsReceivedData {
  type: 'search_results_received';
  /** 반환된 결과 수 (보통 10). */
  resultCount: number;
  /** 검색 쿼리. */
  query: string;
}

/** WebSearch 쿼리 처리 알림. search_results_received 전에 발생. */
export interface QueryUpdateData {
  type: 'query_update';
  /** 검색 쿼리. */
  query: string;
}

// =============================================================================
// PART 4: system — 시스템 메시지 (5개 subtype)
// =============================================================================

/** 5개 system subtype의 discriminated union. */
export type SystemMessage =
  | LocalCommandMessage
  | StopHookSummaryMessage
  | TurnDurationMessage
  | CompactBoundaryMessage
  | ApiErrorMessage;

/**
 * 슬래시 커맨드 실행 기록.
 * 2줄로 구성: 커맨드 호출 → 커맨드 출력.
 */
export interface LocalCommandMessage extends BaseJsonlEnvelope {
  type: 'system';
  subtype: 'local_command';
  /**
   * XML 태그 형식 내용.
   *
   * 커맨드 호출: `<command-name>/model</command-name><command-message>model</command-message><command-args></command-args>`
   * 커맨드 출력: `<local-command-stdout>결과 텍스트</local-command-stdout>`
   *
   * 출력에 ANSI 이스케이프 코드 포함 가능.
   */
  content: string;
  level: 'info';
  isMeta: boolean;
}

/** Stop 훅 실행 요약. assistant 턴 종료 후 발생. */
export interface StopHookSummaryMessage extends BaseJsonlEnvelope {
  type: 'system';
  subtype: 'stop_hook_summary';
  /** 실행된 Stop 훅 수. */
  hookCount: number;
  /** 실행된 각 훅의 정보. */
  hookInfos: Array<{ command: string }>;
  /** 훅 실행 에러. 정상 시 `[]`. */
  hookErrors: unknown[];
  /** 훅이 후속 동작을 차단했는지 여부. 관찰 데이터에서 항상 `false`. */
  preventedContinuation: boolean;
  /** 중지 이유. 관찰 데이터에서 항상 `""`. */
  stopReason: string;
  /** 훅이 출력을 생성했는지 여부. */
  hasOutput: boolean;
  level: 'suggestion';
  /** 이 요약을 트리거한 Stop 이벤트의 tool_use ID. */
  toolUseID: string;
}

/** assistant 턴 소요 시간. 턴 종료 시 발생. */
export interface TurnDurationMessage extends BaseJsonlEnvelope {
  type: 'system';
  subtype: 'turn_duration';
  /** 턴 소요 시간 (밀리초). */
  durationMs: number;
  isMeta: boolean;
}

/**
 * 컨텍스트 압축 경계 마커.
 *
 * 주의: `parentUuid`는 항상 `null`. 대화 트리 체인은
 * `logicalParentUuid`로 유지.
 */
export interface CompactBoundaryMessage extends BaseJsonlEnvelope {
  type: 'system';
  subtype: 'compact_boundary';
  parentUuid: null;
  /** 압축 전 마지막 메시지 UUID. 논리적 대화 체인 유지용. */
  logicalParentUuid: string;
  /** 항상 `"Conversation compacted"`. */
  content: string;
  level: 'info';
  /** 압축 메타데이터. */
  compactMetadata: {
    /** 트리거: `"auto"` (토큰 한계) 또는 `"manual"` (/compact 커맨드). */
    trigger: 'auto' | 'manual';
    /** 압축 전 토큰 수. */
    preTokens: number;
  };
  isMeta: boolean;
}

/** API 호출 에러. 재시도 정보 포함. */
export interface ApiErrorMessage extends BaseJsonlEnvelope {
  type: 'system';
  subtype: 'api_error';
  level: 'error';
  /** API 에러 상세. */
  error: {
    /** HTTP 상태 코드 (401, 429, 500, 529 등). */
    status: number;
    /** HTTP 응답 헤더. */
    headers: Record<string, string>;
    /** API 요청 ID. 인증 에러 시 `null`. */
    requestID: string | null;
    /** 중첩된 에러 페이로드. */
    error: {
      error: {
        message: string;
        code: number;
      };
    };
  };
  /** 다음 재시도까지 대기 시간 (ms). 지수 백오프 + 지터. */
  retryInMs: number;
  /** 현재 재시도 횟수 (1부터 시작). */
  retryAttempt: number;
  /** 최대 재시도 횟수. 관찰 값: `10`. */
  maxRetries: number;
}

// =============================================================================
// PART 5: 기타 최상위 타입
// =============================================================================

/**
 * 파일 히스토리 스냅샷. CLI의 undo/restore 기능용 파일 백업 추적.
 * envelope 필드 없음 (경량 레코드).
 */
export interface FileHistorySnapshot {
  type: 'file-history-snapshot';
  /** 이 스냅샷의 UUID. */
  messageId: string;
  /**
   * 초기 기준선 vs 증분 업데이트.
   * - `false`: 초기 스냅샷 (턴/세션 시작). snapshot.messageId === messageId
   * - `true`: 증분 업데이트 (파일 수정 시). snapshot.messageId → 초기 스냅샷 ID
   */
  isSnapshotUpdate: boolean;
  snapshot: {
    messageId: string;
    /** 파일 경로 → 백업 메타데이터. 키는 홈 기준 상대경로. */
    trackedFileBackups: Record<string, {
      /** 백업 파일명: `"<hash>@v<N>"` (예: `"7a5b5e6dc221629f@v1"`). */
      backupFileName: string;
      /** 버전 번호 (1부터 증가). */
      version: number;
      /** 백업 생성 시각 (ISO 8601). */
      backupTime: string;
    }>;
    timestamp: string;
  };
}

/** 메시지 큐 조작. 백그라운드 태스크 알림 등의 큐 관리. envelope 없음. */
export type QueueOperation =
  | QueueEnqueueOperation
  | QueueDequeueOperation
  | QueueRemoveOperation
  | QueuePopAllOperation;

interface QueueOperationBase {
  type: 'queue-operation';
  timestamp: string;
  sessionId: string;
}

/** 큐에 메시지 추가. content에 XML 형식 태스크 알림 포함. */
export interface QueueEnqueueOperation extends QueueOperationBase {
  operation: 'enqueue';
  content: string;
}

/** 큐에서 다음 메시지 제거 및 처리. */
export interface QueueDequeueOperation extends QueueOperationBase {
  operation: 'dequeue';
}

/** 큐에서 특정 메시지 제거. */
export interface QueueRemoveOperation extends QueueOperationBase {
  operation: 'remove';
}

/** 큐의 모든 메시지 제거. */
export interface QueuePopAllOperation extends QueueOperationBase {
  operation: 'popAll';
  content: string;
}

/** 세션 커스텀 제목 설정. envelope 없음. */
export interface CustomTitle {
  type: 'custom-title';
  customTitle: string;
  sessionId: string;
}

// =============================================================================
// PART 6: 도구 결과 타입 (toolUseResult)
// =============================================================================

// 공통 diff 구조
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** diff 줄. 접두사: `" "` 컨텍스트, `"+"` 추가, `"-"` 삭제. */
  lines: string[];
}

// --- 개별 도구 결과 ---

export interface BashToolResult {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  isImage: boolean;
  noOutputExpected?: boolean;
  /** 백그라운드 실행 시 태스크 ID (7자 hex). stdout/stderr는 비어 있음. */
  backgroundTaskId?: string;
}

export interface ReadTextToolResult {
  type: 'text';
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
}

export interface ReadImageToolResult {
  type: 'image';
  file: {
    base64: string;
    type: string; // MIME type
    originalSize: number;
    dimensions: {
      originalWidth: number;
      originalHeight: number;
      displayWidth: number;
      displayHeight: number;
    };
  };
}

export type ReadToolResult = ReadTextToolResult | ReadImageToolResult;

export interface WriteToolResult {
  type: 'create' | 'update';
  filePath: string;
  content: string;
  structuredPatch: StructuredPatchHunk[];
  originalFile: string | null;
}

export interface EditToolResult {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string;
  structuredPatch: StructuredPatchHunk[];
  userModified: boolean;
  replaceAll: boolean;
}

export interface GlobToolResult {
  filenames: string[];
  durationMs: number;
  numFiles: number;
  truncated: boolean;
}

export interface GrepContentToolResult {
  mode: 'content';
  filenames: string[];
  numFiles: number;
  content: string;
  numLines: number;
}

export interface GrepFilesToolResult {
  mode: 'files_with_matches';
  filenames: string[];
  numFiles: number;
}

export type GrepToolResult = GrepContentToolResult | GrepFilesToolResult;

export interface TaskToolResult {
  status: 'completed' | 'failed' | 'cancelled';
  prompt: string;
  agentId: string;
  content: Array<{ type: 'text'; text: string }>;
  totalDurationMs: number;
  totalTokens: number;
  totalToolUseCount: number;
  usage: UsageObject;
}

/** Task 도구의 비동기 실행 결과. run_in_background=true 시 반환. */
export interface AsyncTaskToolResult {
  isAsync: true;
  status: 'async_launched';
  agentId: string;
  description: string;
  prompt: string;
  outputFile?: string;
}

export interface TaskOutputToolResult {
  retrieval_status: 'success' | 'error' | 'not_found';
  task: TaskOutputBashTask | TaskOutputAgentTask;
}

export interface TaskOutputBashTask {
  task_id: string;
  task_type: 'local_bash';
  status: 'completed' | 'running' | 'failed';
  description: string;
  output: string;
  exitCode: number;
}

export interface TaskOutputAgentTask {
  task_id: string;
  task_type: 'local_agent';
  status: 'completed' | 'running' | 'failed';
  description: string;
  output: string;
  prompt: string;
  result: string;
}

export interface TaskStopToolResult {
  message: string;
  task_id: string;
  task_type: 'local_bash' | 'local_agent';
  command: string;
}

export interface WebSearchToolResult {
  query: string;
  results: Array<WebSearchServerResult | string>;
  durationSeconds: number;
}

export interface WebSearchServerResult {
  tool_use_id: string;
  content: Array<{ title: string; url: string }>;
}

export interface WebFetchToolResult {
  bytes: number;
  code: number;
  codeText: string;
  result: string;
  durationMs: number;
  url: string;
}

// ---------- AskUserQuestion Tool Types ----------

/** A single option within a question */
export interface AskUserQuestionOption {
  label: string;            // 1-5 word short option name
  description: string;      // Always displayed description text
  markdown?: string;        // Optional: hover/select shows side-by-side preview
}

/** A single question item */
export interface AskUserQuestionItem {
  question: string;         // Question body text
  header: string;           // Required, max 12 chars, chip/badge identifier
  options: AskUserQuestionOption[];  // Required, 2-4 options
  multiSelect: boolean;     // true: checkbox, false: radio
}

/** Full input schema sent by CLI as tool_use.input */
export interface AskUserQuestionInput {
  questions: AskUserQuestionItem[];  // 1-4 questions
  answers?: Record<string, string>;  // Only present when reading from history
  annotations?: Record<string, {
    markdown?: string;
    notes?: string;
  }>;
  metadata?: {
    source?: string;  // Internal tracking, not displayed
  };
}

/** Result stored in toolUseResult for session history rendering */
export interface AskUserQuestionToolResult {
  questions: AskUserQuestionItem[];
  answers: Record<string, string>;
  annotations?: Record<string, { notes?: string }>;
}

export interface EnterPlanModeToolResult {
  message: string;
}

export interface ExitPlanModeToolResult {
  plan: string;
  isAgent: boolean;
  filePath: string;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface TodoWriteToolResult {
  oldTodos: TodoItem[];
  newTodos: TodoItem[];
}

/** MCP 도구 결과. 항상 text content 블록 배열. */
export type McpToolResult = Array<{ type: 'text'; text: string }>;

/**
 * 모든 도구 결과의 유니온.
 *
 * 주의: 모든 도구 결과는 에러/거부 시 `string`일 수 있음.
 * 항상 `typeof toolUseResult === 'string'`을 먼저 체크.
 *
 * 에러 패턴: `"Error: ..."` (실행 에러), `"User rejected tool use"` (거부),
 * `"Sibling tool call errored"` (병렬 호출 실패)
 */
export type ToolUseResult =
  | string
  | BashToolResult
  | ReadToolResult
  | WriteToolResult
  | EditToolResult
  | GlobToolResult
  | GrepToolResult
  | TaskToolResult
  | AsyncTaskToolResult
  | TaskOutputToolResult
  | TaskStopToolResult
  | WebSearchToolResult
  | WebFetchToolResult
  | AskUserQuestionToolResult
  | EnterPlanModeToolResult
  | ExitPlanModeToolResult
  | TodoWriteToolResult
  | McpToolResult;

/** 빌트인 도구 이름 → 결과 타입 매핑 (에러 시 string 포함). */
export interface BuiltinToolResultMap {
  Bash: BashToolResult | string;
  Read: ReadToolResult | string;
  Write: WriteToolResult | string;
  Edit: EditToolResult | string;
  Glob: GlobToolResult | string;
  Grep: GrepToolResult | string;
  Task: TaskToolResult | string;
  TaskOutput: TaskOutputToolResult | string;
  TaskStop: TaskStopToolResult | string;
  WebSearch: WebSearchToolResult | string;
  WebFetch: WebFetchToolResult | string;
  AskUserQuestion: AskUserQuestionToolResult | string;
  EnterPlanMode: EnterPlanModeToolResult | string;
  ExitPlanMode: ExitPlanModeToolResult | string;
  TodoWrite: TodoWriteToolResult | string;
}

// =============================================================================
// PART 7: 최상위 JSONL 줄 유니온
// =============================================================================

/** JSONL 파일의 한 줄을 파싱한 결과. */
export type CliJsonlEntry =
  | AssistantMessage
  | UserMessage
  | ProgressMessage
  | SystemMessage
  | FileHistorySnapshot
  | QueueOperation
  | CustomTitle;
