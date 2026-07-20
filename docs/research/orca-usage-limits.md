# Orca Claude Code / Codex usage-limit research

공식 [`stablyai/orca`](https://github.com/stablyai/orca) v1.4.137 태그 커밋
[`6013055491943336660e12e5dec93c9ece4575bb`](https://github.com/stablyai/orca/commit/6013055491943336660e12e5dec93c9ece4575bb)을
2026-07-14에 확인했다. 로컬에 설치된 `/Applications/Orca.app`도 v1.4.137이며,
`app.asar`의 main/renderer 번들에 아래 OAuth endpoint, Codex RPC method, 15분 poller,
status-bar UI가 포함된 것을 대조했다.

## 결론

Orca는 사용량을 **현재 보이는 터미널 세션의 출력에서 읽어 그 세션 안에 표시하지 않는다.**
Claude와 Codex 사용량을 가져오는 별도의 전역 `RateLimitService`가 있고, 그 결과를 현재
탭이나 PTY/GUI 실행 형태와 무관한 **앱 최하단 24px 전역 상태바의 왼쪽 묶음**에 표시한다.
따라서 PTY/TUI가 화면을 전부 차지해도 5시간 및 주간 리밋이 계속 보인다.

```text
Claude: Keychain / credentials file -> Anthropic OAuth usage API
                                      -> 실패/보충 시 숨은 Claude PTY /usage

Codex:  CODEX_HOME/auth.json 존재 확인
        -> WSL이면 ChatGPT backend usage API
        -> 그 외에는 숨은 Codex app-server account/rateLimits/read
        -> 실패하면 숨은 Codex PTY /status

각 결과 -> RateLimitService -> Electron IPC push -> renderer global store
        -> 앱 최하단 status bar 왼쪽의 Claude/Codex meter
```

공통 모델은 `usedPercent`, 300분/10,080분 window, reset timestamp/description으로
정규화하며, provider마다 `session`과 `weekly` 슬롯을 공유한다.
[공통 타입](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/shared/rate-limit-types.ts#L1-L10),
[provider snapshot](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/shared/rate-limit-types.ts#L46-L85)

## 1. Claude Code 조회

### 기본 경로: OAuth usage API

Orca는 먼저 Claude Code OAuth bearer token을 읽는다.

- macOS에서는 `Claude Code-credentials` Keychain item을 읽고, Claude Code 2.1+의
  `CLAUDE_CONFIG_DIR`별 hash suffix가 붙은 scoped service를 먼저 시도한 뒤 legacy
  service로 fallback한다.
  [Keychain service와 scoped 이름](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/claude-accounts/keychain.ts#L4-L6),
  [Keychain read](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/claude-accounts/keychain.ts#L13-L29),
  [scoped service 계산](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/claude-accounts/keychain.ts#L81-L100)
- 그 다음 `<CLAUDE_CONFIG_DIR 또는 ~/.claude>/.credentials.json`을 시도한다.
  환경변수 `ANTHROPIC_AUTH_TOKEN`이나 `ANTHROPIC_API_KEY`는 이 endpoint용 OAuth
  token이 아니므로 의도적으로 읽지 않는다.
  [credential source 순서](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/claude-fetcher.ts#L146-L247)

token이 있으면 Electron `net.fetch`로 다음 요청을 보낸다.

```http
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <claudeAiOauth.accessToken>
anthropic-beta: oauth-2025-04-20
User-Agent: claude-code/2.1.0
```

[endpoint와 header 상수](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/claude-fetcher.ts#L47-L50),
[요청](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/claude-fetcher.ts#L425-L458)

응답의 `five_hour`를 300분 `session`, `seven_day`를 10,080분 `weekly`로 바꾼다.
사용률은 `utilization` 또는 `used_percentage`, reset은 `resets_at`에서 읽고 0~100으로
clamp한다. 추가로 Claude의 scoped Fable 주간 limit도 별도 window로 받을 수 있다.
[응답 shape와 정규화](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/claude-fetcher.ts#L297-L423),
[5h/weekly mapping](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/claude-fetcher.ts#L425-L471)

### fallback: 숨은 `claude` PTY의 `/usage`

OAuth credential이 없거나 OAuth 요청 오류가 CLI fallback 가능한 종류이면 Orca는
사용자가 보고 있는 PTY가 아니라 **별도의 숨은 PTY**를 만든다. `claude`를 실행하고
초기화 후 `/usage`를 입력한 다음 TUI 결과를 파싱한다.
[OAuth 우선 및 fallback 분기](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/claude-fetcher.ts#L762-L868),
[credential 부재 시 CLI 경로](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/claude-fetcher.ts#L870-L973)

parser는 `Current session`과 `Current week`/`Weekly limits`/`7-day` label 주변의
`N% used|consumed|left|remaining|available`을 찾는다. `left/remaining/available`은
`100 - N`으로 사용률로 환산하고 각각 300분과 10,080분 window로 만든다.
[label/percent parser](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/claude-pty.ts#L17-L147)

숨은 PTY는 안전한 임시 cwd에서 실행되고, 2초 후 `/usage`를 보내며, 렌더가 끝났다고
판단한 뒤 결과를 정리한다. 전체 timeout은 25초다.
[PTY spawn](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/claude-pty.ts#L215-L300),
[timeout/finalize](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/claude-pty.ts#L345-L428),
[`/usage` 전송과 완료 감지](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/claude-pty.ts#L431-L490)

## 2. Codex 조회

### 인증과 조회 순서

먼저 `CODEX_HOME/auth.json`의 존재를 확인한다. 명시적인 managed-account home,
`CODEX_HOME`, `~/.codex` 순으로 home을 결정하며, 로그인하지 않은 사용자의 Codex를
백그라운드에서 불필요하게 실행하지 않기 위한 gate다.
[auth presence gate](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/codex-auth-presence.ts#L51-L81)

공개 entry point의 fallback 순서는 다음과 같다.

1. WSL account이면 backend usage API
2. host 및 WSL fallback이면 Codex app-server JSON-RPC
3. RPC 실패 시 interactive Codex `/status` hidden PTY

[전체 분기 순서](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/codex-fetcher.ts#L1020-L1142)

### WSL 기본 경로: ChatGPT backend API

`CODEX_HOME/auth.json`의 `tokens.access_token`과 선택적인 `account_id`로 다음 header를
만든다.

```http
Authorization: Bearer <access_token>
User-Agent: codex-cli
OpenAI-Beta: codex-1
originator: Codex Desktop
ChatGPT-Account-Id: <account_id, 있으면>
```

[auth.json shape와 header 구성](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/codex-fetcher.ts#L96-L140),
[credential read](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/codex-fetcher.ts#L303-L360)

그 header로 `GET https://chatgpt.com/backend-api/wham/usage`를 호출한다.
`rate_limit.primary_window`는 session, `secondary_window`는 weekly가 되며,
`limit_window_seconds`가 없으면 각각 300/10,080분을 fallback으로 쓴다.
[backend response mapping과 요청](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/codex-fetcher.ts#L494-L557)

이 direct backend 경로는 WSL의 정기 조회에서 login shell과 hidden app-server를 매번
띄우지 않기 위한 최적화다. host에서는 Codex 자체의 token refresh/custom CA 동작을
보존하기 위해 app-server가 우선이다.
[WSL/host 선택 이유](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/codex-fetcher.ts#L1059-L1083)

### host 기본 경로: 숨은 Codex app-server RPC

Orca는 다음 process를 별도로 spawn한다.

```sh
codex -s read-only -a untrusted app-server
```

stdin/stdout newline-delimited JSON-RPC로 `initialize` request -> `initialized` notification
-> `account/rateLimits/read` request 순서를 수행한다. 응답
`result.rateLimits.primary`는 300분 session, `secondary`는 10,080분 weekly로
정규화한다.
[process spawn](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/codex-fetcher.ts#L559-L602),
[RPC handshake와 rate-limit mapping](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/codex-fetcher.ts#L656-L745)

### fallback: 숨은 interactive Codex PTY의 `/status`

app-server가 실패하면 별도 Codex PTY를 열어 prompt가 나타난 뒤 `/status`를 입력한다.
`5h limit: N%`와 `Weekly limit: N%` 정규식 결과를 각각 300분/10,080분 window로
만든다.
[parser](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/codex-fetcher.ts#L795-L837),
[hidden PTY spawn과 `/status` 전송](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/codex-fetcher.ts#L839-L975)

## 3. polling과 renderer data flow

`RateLimitService`는 Claude/Codex를 특정 session에 귀속시키지 않고 provider별 전역
snapshot으로 보관한다. 기본 poll 주기는 15분이며, 최소 설정값은 30초다. quota API의
429를 피하기 위해 informational snapshot을 비교적 느리게 갱신한다.
[poll 상수와 전역 state](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/service.ts#L72-L103),
[service state](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/service.ts#L128-L194)

앱은 첫 paint와 경쟁하지 않도록 window에 service를 attach한 후 첫 refresh를 1초
defer한다. 이후 window가 visible/focused일 때만 background poll하며, focus/show/restore
때 stale/error 상태를 다시 조회한다.
[window attach와 deferred start](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/index.ts#L970-L974),
[시작과 timer](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/service.ts#L278-L298),
[15분 timer와 1초 deferred refresh](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/service.ts#L673-L728)

한 fetch cycle에서 기존 값을 유지한 채 `fetching`으로 표시하고 Claude/Codex fetcher를
동시에 호출한다. account 전환과 in-flight 결과가 충돌하지 않도록 generation/provenance를
검증한 뒤 새 snapshot을 반영한다.
[동시 fetch](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/service.ts#L1317-L1372),
[결과 적용 guard](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/service.ts#L1468-L1509)

state 변경은 `rateLimits:update` Electron IPC로 renderer에 push된다. renderer는 push를
먼저 subscribe하고 초기 `get()`을 fallback으로 호출해 startup race를 피하며, Zustand의
전역 `rateLimits` slice에 저장한다. 수동 refresh 및 host/WSL/account target별 refresh도
같은 service를 거친다.
[main push](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/rate-limits/service.ts#L1764-L1782),
[IPC handlers](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/main/ipc/rate-limits.ts#L5-L27),
[renderer 초기 subscribe/get](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/renderer/src/hooks/useIpcEvents.ts#L2554-L2572),
[Zustand slice](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/renderer/src/store/slices/rate-limits.ts#L5-L50)

## 4. 실제 표시 위치와 UI

Orca는 왼쪽 navigation rail에 넣지 않았다. main workspace와 floating terminal panel
아래, modal host 앞에 `StatusBar`를 mount한다. fallback shell까지 높이 `h-6`, 최소
24px로 명시되어 있다.
[전역 mount 위치](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/renderer/src/App.tsx#L2494-L2535)

상태바 내부에서는 Claude와 Codex meter가 **가장 왼쪽 cluster**에 있고, 그 뒤에 수동
refresh icon이 온다. `flex-1` spacer 이후 오른쪽에는 update/resource/port/SSH 같은
operational control이 배치된다. 바 자체도 24px다.
[왼쪽 provider cluster와 refresh](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/renderer/src/components/status-bar/StatusBar.tsx#L2062-L2193)

각 provider segment는 icon, 작은 progress bar, `N% 5h · N% wk` 형태로 표시한다.
300분을 `5h`, 10,080분을 `wk`로 label한다. stale/error/fetching도 같은 위치에서
표현한다.
[provider segment](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/renderer/src/components/status-bar/StatusBar.tsx#L1093-L1233),
[window label](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/renderer/src/lib/window-label-formatter.ts#L1-L29)

provider를 클릭하면 위쪽으로 260px dropdown이 열리고 Session/Weekly별 progress bar,
사용률, reset countdown, 마지막 업데이트 시각, 오류를 보여준다. Codex reset credit이나
account switcher도 이 상세 메뉴에 붙는다.
[dropdown trigger/panel](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/renderer/src/components/status-bar/StatusBar.tsx#L1740-L1847),
[상세 window와 reset 표시](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/renderer/src/components/status-bar/tooltip.tsx#L149-L184),
[progress/reset/update UI](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/renderer/src/components/status-bar/tooltip.tsx#L214-L345)

폭이 900px 미만이면 compact, 500px 미만이면 icon-only로 줄어든다. 설치된 CLI만
노출하고, Claude/Codex meter는 기본 status-bar item이지만 우클릭 메뉴에서 각각 끌 수
있다.
[responsive 및 visibility gating](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/renderer/src/components/status-bar/StatusBar.tsx#L1855-L2055),
[기본 item](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/shared/status-bar-defaults.ts#L1-L15),
[Claude/Codex toggle](https://github.com/stablyai/orca/blob/6013055491943336660e12e5dec93c9ece4575bb/src/renderer/src/components/status-bar/StatusBar.tsx#L2239-L2271)

## 5. Tessera에 대한 시사점

변경 전 Tessera도 provider rate-limit snapshot과 WebSocket store는 전역 형태지만, 화면은
`ContextStatusBar` 하나뿐이고 `MessageInput` 아래에만 mount된다.
[`ContextStatusBar`](../../src/components/chat/context-status-bar.tsx#L100-L219),
[`MessageInput` mount](../../src/components/chat/message-input.tsx#L1780-L1790)
`TerminalPanel`에는 같은 consumer가 없으므로 PTY 화면에서는 안 보이는 것이 현재 구조상
자연스럽다.

또한 조회 계층은 provider별로 차이가 있다.

- Claude는 server-level poller가 Anthropic OAuth usage API를 호출하고 전역
  WebSocket update를 보낸다.
  [Claude poller](../../src/lib/rate-limit/poller.ts#L7-L70),
  [Claude fetcher](../../src/lib/rate-limit/fetcher.ts#L207-L275)
- Codex는 chat-mode Codex app-server adapter가 시작될 때
  `account/rateLimits/read`를 요청하고 parser가 update를 만든다. 즉 PTY-only 사용자가
  Codex chat adapter를 한 번도 띄우지 않았다면 UI 위치만 옮겨도 Codex snapshot이
  아직 없을 수 있다.
  [Codex request](../../src/lib/cli/providers/codex/adapter.ts#L548-L567),
  [Codex response parser](../../src/lib/cli/providers/codex/protocol-parser.ts#L409-L413)

### 적용 결정

Tessera는 새 하단 bar가 차지하는 세로 공간과 tab 수에 따라 줄어드는 상단 공간을 피하기
위해 **가장 왼쪽 rail의 footer**를 사용한다.

- Claude Code와 Codex를 항상 함께 노출한다.
- 각 provider에 `5h`, `W` 사용률을 숫자로 표시하고 데이터가 오기 전에는 `--`로 자리를
  유지한다.
- 경고/위험 구간만 색으로 강조하고 평상시에는 기존 rail과 같은 낮은 시각 강도를 쓴다.
- provider 타일을 클릭하면 rail 오른쪽 popover에서 두 window의 progress bar, 사용률,
  reset countdown을 함께 보여준다.
- sidebar 본문이 접혀도 44px project rail 자체는 남겨 PTY, GUI chat, Kanban 등 어느
  화면에서도 같은 위치를 유지한다.

구현은 이미 존재하는 provider별 `rate-limit-store` snapshot을 그대로 소비한다. 조회
수명도 rail의 전역 범위와 맞췄다.

- 서버가 시작되면 Claude Code와 Codex를 즉시 병렬 조회하고 이후 1분마다 갱신한다.
- Codex는 세션 없는 짧은 app-server process에서 `account/rateLimits/read`를 호출한다.
- 최신 snapshot은 poller에 캐시하고, 나중에 연결한 renderer에도 WebSocket으로 replay한다.

따라서 GUI chat 또는 PTY session의 생성 여부와 관계없이 두 provider 사용량이 전역 rail에
표시된다.
