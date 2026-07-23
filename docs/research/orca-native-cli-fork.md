# Orca native CLI fork detection research

2026-07-20 기준 공식 [`stablyai/orca`](https://github.com/stablyai/orca) 저장소의
커밋 [`b19dccd9b74328daa39bf20955a57fdfc7279c3e`](https://github.com/stablyai/orca/commit/b19dccd9b74328daa39bf20955a57fdfc7279c3e)와
공식 [`openai/codex`](https://github.com/openai/codex) 저장소의 커밋
[`3e2f79727a4e8ddfc8e3acb838d496b121094b9e`](https://github.com/openai/codex/commit/3e2f79727a4e8ddfc8e3acb838d496b121094b9e)을 확인했다.
로컬 설치 Orca는 v1.4.137이며, 그 태그에도 아래 AI Vault refresh, provider-session,
session-scanner, terminal context-fork 모듈이 포함되어 있다.

## 결론

Orca는 CLI 안에서 발생한 native fork를 **새 PTY나 새 terminal tab으로 만들지 않는다.**
같은 `paneKey`에 들어온 새 provider session ID로 현재 agent-status 행의 identity를
교체한다. 별도 세션은 workspace/sidebar 행이 아니라 **AI Vault(Agent Session History)**가
Claude/Codex의 새 JSONL transcript/rollout을 다시 스캔할 때 새 행으로 나타난다.

```text
Claude/Codex가 fork 수행 + 새 provider session ID/JSONL 생성
  -> 기존 PTY의 hook이 같은 paneKey + 새 session_id를 Orca에 POST
  -> 공통 AgentProviderSessionMetadata로 정규화
  -> agentStatusByPaneKey[같은 paneKey]를 새 ID로 교체 (새 tab 없음)
  -> AI Vault가 새 ID를 보고 강제 disk rescan
  -> 새 JSONL을 별도 AiVaultSession row로 추가
```

따라서 Tessera에서 원하는 “fork가 메뉴에 새 세션으로 추가”는 terminal tab 생성과
session-history 등록을 분리해 구현해야 한다. PTY는 그대로 유지하고, 메뉴용 세션 인덱스에
새 provider session artifact를 upsert하는 것이 Orca와 같은 구조다.

## 1. fork와 새 session ID의 주체

- Claude Code는 history를 복사한 새 session ID를 만들고 원본은 그대로 둔다. 현재 CLI의
  `/branch`는 현재 지점에서 새 대화 branch로 전환하며, 과거 지점은 `/rewind`로 선택한 뒤
  branch할 수 있다. 세션은 `~/.claude/projects/`의 JSONL로 저장된다.
  [공식 session 설명](https://code.claude.com/docs/en/how-claude-code-works#work-with-sessions),
  [공식 command 설명](https://code.claude.com/docs/en/commands#built-in-commands)
- Codex의 과거 prompt 편집은 선택한 prompt가 속한 turn을 찾고 `beforeTurnId`로
  `thread/fork`를 호출한다. app-server는 그 turn 직전까지 history를 자르고 새 thread를
  시작한다.
  [TUI backtrack dispatch](https://github.com/openai/codex/blob/3e2f79727a4e8ddfc8e3acb838d496b121094b9e/codex-rs/tui/src/app/event_dispatch.rs#L233-L275),
  [fork request](https://github.com/openai/codex/blob/3e2f79727a4e8ddfc8e3acb838d496b121094b9e/codex-rs/tui/src/app_server_session.rs#L576-L653),
  [history truncate와 new thread](https://github.com/openai/codex/blob/3e2f79727a4e8ddfc8e3acb838d496b121094b9e/codex-rs/app-server/src/request_processors/thread_processor.rs#L4004-L4129)
- Codex persistent fork는 자기 rollout을 즉시 만들고, 응답의 새 `thread.id`와
  `forkedFromId`로 lineage를 표현한다.
  [materialize와 response](https://github.com/openai/codex/blob/3e2f79727a4e8ddfc8e3acb838d496b121094b9e/codex-rs/app-server/src/request_processors/thread_processor.rs#L4195-L4253),
  [공식 app-server 계약](https://github.com/openai/codex/blob/3e2f79727a4e8ddfc8e3acb838d496b121094b9e/codex-rs/app-server/README.md#thread-fork)

Orca는 이 ID를 만들거나 native fork protocol을 호출하지 않는다. provider hook payload의
`session_id`를 읽을 뿐이다. Claude/Codex는 같은 공통 metadata shape으로 들어오고,
다른 provider의 필드명 차이만 이 switch에서 흡수한다.
[공통 타입·provider 추출](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/shared/agent-session-resume.ts#L20-L31),
[provider adapter switch](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/shared/agent-session-resume.ts#L171-L223)

## 2. 실행 중 PTY에서 새 ID를 감지하는 방법

Orca-launched PTY는 `ORCA_PANE_KEY`, tab/worktree metadata와 hook endpoint를 환경으로
받는다. Claude/Codex managed hook은 CLI가 준 raw payload를 기존 pane identity와 함께
loopback hook server에 보낸다. Codex는 `SessionStart`도 등록하지만 Claude의 현재 managed
event 목록에는 `SessionStart`가 없으므로, Claude branch는 보통 다음
`UserPromptSubmit`/tool lifecycle hook에서 새 ID가 관측된다.
[Codex hook events](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/main/codex/hook-service.ts#L70-L106),
[Claude hook events](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/main/claude/hook-settings.ts#L29-L61),
[hook payload 전송](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/main/codex/hook-service.ts#L798-L854)

공통 listener는 매 event에서 provider session을 추출해 status envelope에 싣고, main은
그 값을 `agentStatus:set` IPC로 renderer에 전달한다.
[listener normalization](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/shared/agent-hook-listener.ts#L3897-L3939),
[main IPC](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/main/index.ts#L1131-L1182),
[renderer 적용](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/renderer/src/hooks/useIpcEvents.ts#L3163-L3254)

## 3. 새 tab/sidebar row가 아니라 같은 pane 갱신

store는 기존 ID와 incoming ID를 비교해 `providerSessionChanged`를 계산하지만, 최종 write는
항상 `agentStatusByPaneKey[paneKey] = entry`다. 새 tab/worktree 생성 action은 호출하지 않는다.
[change detection](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/renderer/src/store/slices/agent-status.ts#L1714-L1774),
[same-key write](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/renderer/src/store/slices/agent-status.ts#L1951-L1984)

테스트도 같은 `tab-1:leaf-1`에 `codex-session-1` 다음 `codex-session-2`를 넣고, 같은 row의
ID가 `session-2`로 바뀌는 것을 검증한다.
[provider-session replacement test](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/renderer/src/store/slices/agent-status-quit-capture.test.ts#L363-L421)

## 4. AI Vault에 별도 세션 행이 생기는 경로

AI Vault panel은 live `agentStatusByPaneKey`의 provider session ID set을 구독한다. 보지 못한
ID가 나타나면 5초 최소 간격으로 cache를 우회한 강제 rescan을 요청한다. panel이 꺼져
있었다면 다음 mount/refocus에서 역시 강제 scan한다.
[refresh/throttle](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/renderer/src/components/right-sidebar/ai-vault-session-refresh.ts#L6-L22),
[new-ID subscription](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/renderer/src/components/right-sidebar/ai-vault-session-refresh.ts#L212-L242),
[behavior test](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/renderer/src/components/right-sidebar/ai-vault-session-refresh.test.ts#L327-L373)

scanner는 공통 pipeline 아래에서 provider별 저장소와 parser를 쓴다.

- Claude: `~/.claude/projects/**/*.jsonl`; record의 `sessionId`가 row session ID가 된다.
  [source discovery](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/main/ai-vault/session-scanner-source-discovery.ts#L86-L109),
  [Claude parser](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/main/ai-vault/session-scanner-primary-parsers.ts#L43-L79)
- Codex: `$CODEX_HOME/sessions/**/*.jsonl`; `session_meta.payload.id`가 row session ID가 된다.
  [source discovery](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/main/ai-vault/session-scanner-source-discovery.ts#L54-L82),
  [Codex parser](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/main/ai-vault/session-scanner-codex-parser.ts#L107-L143)

최종 row key는 `executionHostId + agent + sessionId + filePath`라서 fork가 만든 새 artifact는
별도 행이 된다. 이것이 workspace sidebar가 아니라 session-history 메뉴에 새 세션이 보이는
실제 경로다.
[AiVaultSession 모델](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/shared/ai-vault-types.ts#L76-L104),
[row identity](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/main/ai-vault/session-scanner-accumulator.ts#L75-L126)

이 방식은 filesystem watcher가 아니라 hook-triggered scan이다. 새 ID hook보다 JSONL flush가
늦으면 첫 scan에서 놓칠 수 있고, 이후 panel mount/refocus/manual refresh가 보정한다.

## 5. Orca의 별도 “Fork Agent Session” 기능

Orca terminal context menu의 fork는 위 native fork와 다르다. xterm scrollback 800줄을
정리·제한한 prompt로 만들고, 새 git worktree를 생성한 뒤 같은 agent를 새 tab에서 실행한다.
즉 정확한 provider history/turn 경계 복제가 아니라 **context copy**다.
[context capture](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/renderer/src/components/terminal-pane/terminal-agent-session-fork.ts#L129-L166),
[new worktree + tab](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/renderer/src/components/terminal-pane/terminal-agent-session-fork.ts#L215-L302),
[bounded prompt](https://github.com/stablyai/orca/blob/b19dccd9b74328daa39bf20955a57fdfc7279c3e/src/renderer/src/lib/agent-session-fork-context.ts#L1-L20)

## 6. 대화 리셋(`/clear`·`/new`)은 fork와 신호 타이밍이 다르다 — 2026-07-22 실측

같은 "새 provider 세션"이라도 리셋은 fork와 달리 **CLI가 즉시 알려주지 않는다.**
codex-cli 0.144.5와 opencode 1.14.48을 PTY로 띄워 훅/플러그인 이벤트를 직접 캡처한 결과:

| CLI | 리셋 직후 | 다음 프롬프트 제출 시 |
| --- | --- | --- |
| claude | `SessionStart(source=clear)` 새 session_id 즉시 (대화가 없어도 발화) | — |
| codex | 이벤트 없음 (rollout 파일도 안 생김) | `SessionStart(source=clear)` + 새 rollout |
| opencode | 이벤트 없음 (`session.created` 안 옴) | `session.created` → 플러그인 `SessionStart` |

codex/opencode는 새 대화를 lazy하게 만든다 — 리셋 시점엔 provider session id 자체가
존재하지 않는다. 그래서 hook만으로는 "다음 프롬프트까지 이전 Tessera 세션에 묶여 있는"
공백이 생긴다(수정 전 실측: `/clear` 후 사이드바 무변화, 다음 프롬프트에서야 fork 생성).

### 왜 hook·artifact로는 못 잡는가

- codex 훅 이벤트는 바이너리 기준 7종뿐이다: `session_start`, `user_prompt_submit`,
  `pre_tool_use`, `post_tool_use`, `permission_request`, `stop`, `compact`.
  세션 종료/전환 계열 이벤트가 아예 없어 `/clear` 시점에 발화시킬 훅이 없다.
- codex `remote-control`은 app-server 데몬 전용이라 PTY의 TUI 프로세스와 별개다.
- opencode 플러그인 훅은 `event`(서버 이벤트 버스)·`tool`·`auth`·`permission.ask`뿐이고,
  `/new`는 TUI 클라이언트의 로컬 상태 전환이라 서버 이벤트가 발생하지 않는다.

### 그래서 화면을 읽는다

리셋 순간 두 CLI가 확실히 하는 일은 화면 repaint뿐이다. 입력 방식(타이핑/탭 완성/
팝업 선택)과 무관하므로 Tessera는 여기서 신호를 얻는다
(`terminal-conversation-reset-screen.ts`, provider adapter의 `detectTerminalConversationReset`):

- codex: 방금 닫은 세션의 `To continue this session, run codex resume <uuid>`.
  uuid를 Tessera가 보유한 provider session id와 대조하므로 오탐이 사실상 없다.
- opencode: 빈 컴포저 홈 화면의 `Ask anything...` 문구(대화가 생기면 사라진다).

감지되면 provider 식별자 없이 세션을 먼저 분기해 두고(`terminalProviderSessionPending`),
뒤늦게 도착한 첫 식별자를 그 세션이 흡수한다. 감지가 틀렸다면 이전 식별자가 다시
관찰되므로 빈 대기 세션을 버리고 원래 세션으로 PTY를 되돌린다. 화면 문구가 바뀌어
감지에 실패해도 동작은 수정 전(다음 프롬프트에 fork)으로 degrade될 뿐이다.

## Tessera 적용 시사점

1. 공통 `ProviderSessionIdentity { provider, id, transcriptPath? }`를 PTY session/tab ID와
   분리한다. provider adapter는 hook field와 artifact path만 정규화한다.
2. PTY hook에서 같은 terminal의 provider ID가 바뀌면 terminal record를 교체하되, 메뉴용
   session index에는 `(executionHost, provider, providerSessionId, artifactPath)`로 새 행을
   upsert한다.
3. hook은 빠른 invalidation signal로 쓰고, artifact scanner를 source of truth로 둔다.
   scan miss를 막으려면 debounce/retry 또는 directory watcher를 추가한다.
4. Claude/Codex별 UI 분기를 만들지 말고 공통 session registry + provider adapter 구조를 쓴다.
5. 이 동작은 PTY mode adapter에서만 publish하고 GUI mode의 기존 session 생성 경로에는
   연결하지 않아야 한다. native fork 때문에 자동으로 새 terminal tab을 만들지 않는다.
