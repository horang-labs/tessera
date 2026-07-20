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
