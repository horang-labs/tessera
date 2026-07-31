# OpenCode 대화 시작 전 skill/slash command 조회 조사

작성일: 2026-07-31
검증 대상: OpenCode `1.14.48`, Tessera 현재 워크트리

## 결론

가능하다. OpenCode의 ACP(`opencode acp`)를 임시로 시작하는 방식은 적합하지 않지만, 공식 headless HTTP server(`opencode serve`)에는 세션 ID 없이 호출할 수 있는 두 API가 있다.

| 목적 | 공식 API | 반환 범위 | Tessera 권장도 |
|---|---|---|---|
| 현재 ACP의 `available_commands_update`와 가장 비슷한 목록 | `GET /command?directory=<cwd>` | 기본 prompt command, 사용자 command, MCP prompt, skill | **권장** |
| skill만 조회 | `GET /skill?directory=<cwd>` | 발견된 skill | `/skills` 전용 화면 등에 적합 |

두 endpoint는 세션 경로(`/session/:id/...`)가 아니라 instance 경로이며, 요청 스키마에도 session ID가 없다. OpenCode `v1.14.48` 소스는 `/command`와 `/skill`을 각각 `command.list`, `app.skills` operation으로 선언하고 둘 다 `directory`가 포함된 workspace routing query를 받도록 정의한다. ([OpenCode v1.14.48 instance API source, lines 42–55 and 138–166](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts#L42-L55), [same file, lines 138–166](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts#L138-L166))

따라서 Tessera는 새 GUI 대화를 만들지 않고, 작업 디렉터리 기준의 일회성 OpenCode server를 띄워 목록만 읽은 뒤 종료할 수 있다.

## 공식 인터페이스

### 1. `opencode serve`

공식 문서는 `opencode serve`가 TUI 없이 OpenCode HTTP API를 노출하며, OpenAPI 3.1 문서를 `http://<host>:<port>/doc`에서 제공한다고 명시한다. 서버는 `--hostname`, `--port`, `--cors`를 지원한다. ([OpenCode Server documentation](https://opencode.ai/docs/server/))

`v1.14.48`의 CLI 구현도 `serve`를 ambient project instance 없이 시작하고 요청별 directory로 instance를 로드한다고 주석으로 명시한다. 서버가 준비되면 실제 host/port를 stdout의 `opencode server listening on ...`으로 출력한다. ([OpenCode v1.14.48 `serve` source, lines 7–24](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/cli/cmd/serve.ts#L7-L24))

인증은 `OPENCODE_SERVER_PASSWORD`가 설정되면 HTTP Basic Auth를 사용한다. 기본 username은 `opencode`이고 `OPENCODE_SERVER_USERNAME`으로 바꿀 수 있다. Tessera가 상속된 인증 환경을 유지한다면 이 값을 요청에 반영하되 로그에는 credential을 남기지 않아야 한다. ([OpenCode Server authentication](https://opencode.ai/docs/server/#authentication))

### 2. `GET /skill`

`GET /skill?directory=<cwd>`는 `Skill.Info[]`를 반환한다. `v1.14.48`의 `Skill.Info`는 `name`, optional `description`, `location`, `content`로 구성된다. ([OpenCode v1.14.48 Skill schema, lines 38–45](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/skill/index.ts#L38-L45), [instance API declaration](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts#L158-L166))

OpenCode는 cwd부터 git worktree까지 올라가며 project-local skills를 찾고, global OpenCode/Claude/Agents 호환 위치도 검색한다. 공식 문서에 나온 위치는 다음과 같다. ([OpenCode Agent Skills — discovery](https://opencode.ai/docs/skills/#understand-discovery))

- `.opencode/skills/<name>/SKILL.md`
- `~/.config/opencode/skills/<name>/SKILL.md`
- project/global `.claude/skills/<name>/SKILL.md`
- project/global `.agents/skills/<name>/SKILL.md`

`directory`를 생략하면 server process의 cwd가 기본값이 된다. `v1.14.48` workspace router는 query의 `directory`, `x-opencode-directory` header, `process.cwd()` 순서로 directory를 정한다. Tessera는 세션의 `work_dir`을 명시적으로 query에 넣어야 한다. ([OpenCode v1.14.48 workspace routing, lines 56–58](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts#L56-L58))

주의할 점은 이 endpoint가 metadata만 반환하지 않고 skill 본문 `content`까지 반환한다는 것이다. Tessera는 응답 직후 `{name, description}`만 투영하고 원문을 저장하거나 raw log에 남기지 않는 편이 안전하다. 또한 handler는 agent별 permission을 적용하는 `skill.available(agent)`가 아니라 `skill.all()`을 호출하므로, 이것은 “선택한 agent에게 허용된 skill”이 아니라 “해당 directory에서 등록된 skill” 목록이다. ([OpenCode v1.14.48 instance handler, lines 72–82](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts#L72-L82), [Skill service methods, lines 224–241](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/skill/index.ts#L224-L241))

### 3. `GET /command`

`GET /command?directory=<cwd>`의 응답은 `Command.Info[]`이다. 각 항목에는 `name`, optional `description`, optional `source`, `template`, `hints` 등이 있으며 `source`는 `command | mcp | skill`이다. ([OpenCode v1.14.48 Command schema, lines 32–47](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/command/index.ts#L32-L47))

OpenCode의 command registry는 다음을 하나로 합친다.

1. 기본 prompt command인 `init`, `review`
2. `opencode.json` 또는 command Markdown으로 정의한 사용자 command
3. MCP server가 제공하는 prompts
4. 발견된 skills

이 병합은 공식 `v1.14.48` command registry에 직접 구현되어 있다. Skill과 기존 command의 이름이 충돌하면 기존 command가 우선한다. ([OpenCode v1.14.48 Command registry, lines 78–158](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/command/index.ts#L78-L158))

따라서 `/command`는 Tessera가 현재 ACP 세션에서 받는 provider-reported command 목록과 가장 가깝다. 다만 TUI 자체 화면을 여는 `/help`, `/theme` 같은 모든 built-in UI command를 뜻하지는 않는다. 공식 command 문서도 custom command가 TUI built-ins에 “추가”되는 별도 범주라고 설명한다. ([OpenCode Commands documentation](https://opencode.ai/docs/commands/))

`/command`도 각 command/skill의 전체 `template`을 반환하므로 Tessera는 `{name, description}`만 유지하고 template을 로깅하지 않아야 한다. MCP prompts까지 합치기 위해 command registry가 `mcp.prompts()`를 호출하므로, 구성에 따라 `/skill`보다 느리거나 MCP 초기화/연결을 유발할 수 있다. ([OpenCode v1.14.48 Command registry, lines 118–145](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/command/index.ts#L118-L145))

### 4. `opencode debug skill`은 대안이지만 권장하지 않음

설치된 `1.14.48`의 공식 CLI에는 session 없이 실행할 수 있는 `opencode debug skill`도 있다. `--help`는 이 명령을 `list all available skills`로 설명하고, 공식 소스는 `skill.all()` 결과 전체를 pretty-printed JSON으로 stdout에 쓴다. Metadata-only/compact JSON option은 없다. ([OpenCode v1.14.48 debug skill source](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/cli/cmd/debug/skill.ts#L6-L14))

그러나 이 환경에서는 skill 본문이 많은 상태에서 다음 명령의 stdout이 정확히 `196608` bytes에서 끝났고 JSON의 중간에서 잘렸다.

```bash
opencode debug skill | wc -c
# 196608
```

따라서 skill 수가 적을 때는 작동하더라도 Tessera의 안정적인 discovery transport로 삼기 어렵다. 전체 `content`를 직렬화해 불필요하게 큰 응답을 만들고, slash commands/MCP prompts도 포함하지 않으며, 관찰된 설치본에서는 valid JSON을 보장하지 못했다. HTTP `/skill`도 본문을 반환하지만 HTTP response는 이 CLI stdout 잘림을 재현하지 않았고, `/command`는 ACP에 가까운 command catalog까지 제공하므로 transient server 방식이 더 안전하다.

## ACP로는 왜 해결하면 안 되는가

현재 Tessera의 OpenCode GUI adapter는 `opencode acp`를 시작한 뒤 `initialize`, 이어서 `session/new` 또는 `session/resume`을 보낸다. 즉 ACP 경로에서 command 목록을 얻으려면 이미 session 단계로 들어간다. ([Tessera OpenCode adapter](src/lib/cli/providers/opencode/adapter.ts#L475-L526))

OpenCode `v1.14.48`도 `newSession`에서 session manager의 `create()`를 먼저 호출하고 그 다음 session mode를 로드한다. ([OpenCode v1.14.48 ACP agent, lines 559–574](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/acp/agent.ts#L559-L574)) Session manager의 `create()`는 실제 SDK `session.create()`를 호출하므로 단순 메모리상의 임시 조회가 아니다. ([OpenCode v1.14.48 ACP session manager, lines 17–40](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/acp/session.ts#L17-L40))

ACP의 `available_commands_update`는 session mode를 로드하는 과정에서 `/command`와 같은 SDK `command.list({directory})` 결과를 읽고, `compact`가 없으면 추가한 뒤 session notification으로 보낸다. ([OpenCode v1.14.48 ACP agent, lines 1128–1146 and 1188–1196](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/acp/agent.ts#L1128-L1146), [same file, lines 1188–1196](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/acp/agent.ts#L1188-L1196))

즉 ACP에는 session 이전의 별도 `commands/list` JSON-RPC request가 확인되지 않는다. 목록 자체는 HTTP `GET /command`로 얻고, ACP는 실제 대화가 시작된 후의 live update에만 계속 사용하는 것이 맞다.

## 설치 버전 실증

현재 개발 환경의 `opencode --version`은 `1.14.48`이었다. 아래 순서로 검증했다.

```bash
opencode serve --hostname 127.0.0.1 --port 43123
curl 'http://127.0.0.1:43123/command?directory=<encoded-cwd>'
curl 'http://127.0.0.1:43123/skill?directory=<encoded-cwd>'
curl 'http://127.0.0.1:43123/doc'
opencode session list --format json
```

관찰 결과:

- `/doc`에 `/command` operation ID `command.list`와 `/skill` operation ID `app.skills`가 존재했다.
- `/command`는 `source: "command"`인 `init`, `review`와 다수의 `source: "skill"` 항목을 함께 반환했다.
- `/skill`은 `name`, `description`, `location`, `content` 구조의 skill 목록을 반환했다.
- `directory=/tmp`로 바꾸면 project-local 발견 범위가 바뀌었다.
- 두 GET 요청 전후 `opencode session list --format json | jq length` 값은 `66`으로 동일했다. HTTP 조회 자체는 conversation/session을 만들지 않았다.
- `opencode debug skill`도 session은 만들지 않지만, 이 환경에서는 stdout이 `196608` bytes에서 잘려 invalid JSON이 됐다.

이 실증은 공식 `v1.14.48` release tag에 맞춰 수행했다. ([OpenCode v1.14.48 release](https://github.com/anomalyco/opencode/releases/tag/v1.14.48))

## Tessera 구현

`listOpenCodeCommands()` 일회성 discovery client로 구현했다.

```text
세션의 provider command/opencode 환경과 work_dir 해석
  -> 빈 loopback 포트를 확보
  -> opencode serve --hostname 127.0.0.1 --port <확보한 포트> 시작
  -> stdout에서 실제 listening URL 확인
  -> GET /command?directory=<정규화한 work_dir>
  -> 응답을 name/description만으로 축소
  -> transient server 종료
  -> 기존 /api/sessions/:id/skills 응답으로 전달
```

구현 선택:

- 일반 `/` picker: `/command` 사용. 실행 중 ACP가 보고하는 목록과 맞추려면 누락 시 `compact`를 별도로 합친다. OpenCode ACP 자체도 같은 방식으로 `compact`를 추가한다. ([OpenCode v1.14.48 ACP agent](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/acp/agent.ts#L1128-L1146))
- 정말 skill만 보여주는 UI: `/skill` 또는 `/command`에서 `source === "skill"`만 필터링한다.
- request에는 반드시 session `work_dir`을 URL-encode한 `directory` query로 전달한다.
- process가 실행 중이면 지금처럼 ACP의 최신 `available_commands_update` cache를 우선하고, 멈춘 새 세션에서만 transient HTTP discovery를 사용한다.
- 설치된 `1.14.48`에서 `--port 0`은 OS가 배정하는 임의 포트가 아니라 기본 포트 `4096`으로 해석됐다. 기존 OpenCode 서버와 충돌하지 않도록 Tessera가 loopback의 빈 포트를 먼저 확보해 명시적으로 전달해야 한다.
- timeout, child-process 종료, stdout의 listening URL 파싱, Basic Auth 환경, native/WSL command/cwd 정규화를 기존 Claude/Codex discovery client와 같은 수준으로 처리한다.
- 응답의 `template`/`content`는 UI에 필요 없으므로 보관·로깅하지 않는다.

현재 Tessera는 실행 중인 OpenCode process가 있으면 기존 ACP command cache를 그대로 사용하고, process가 없는 새 GUI 세션이면 `listOpenCodeCommands()`로 같은 `/command` catalog를 조회한다. Client hook도 새 OpenCode 세션에서 `/`를 입력하면 기존 `/api/sessions/:id/skills` 경로를 호출하도록 변경했다. ([Tessera skills route](src/app/api/sessions/[id]/skills/route.ts), [Tessera skill picker](src/hooks/use-skill-picker.ts), [OpenCode discovery client](src/lib/cli/providers/opencode/command-discovery-client.ts))

실제 GUI 검증에서는 메시지 0개, `hasStarted: false`, `isRunning: false` 상태를 유지하면서 47개 항목을 표시했고 `/diagnosing-bugs`와 ACP가 보완하는 `/compact`도 포함했다. 검증용 세션과 transient server는 종료 후 모두 정리했다.

## 제약과 리스크

| 제약 | 영향/대응 |
|---|---|
| 확인된 버전 범위 | 이 조사는 설치본과 공식 tag `1.14.48`에서 검증했다. 더 오래된 OpenCode를 지원한다면 `/doc` 또는 version gate로 endpoint 존재 여부를 확인하고 빈 목록으로 안전하게 fallback해야 한다. |
| 응답 과다 | `/command.template`, `/skill.content`가 포함된다. 이름/설명만 즉시 추출하고 raw payload를 남기지 않는다. |
| `debug skill` stdout | full skill body를 stdout에 쓰며 설치본에서 196608-byte truncation이 재현됐다. HTTP endpoint를 사용한다. |
| MCP 초기화 | `/command`는 MCP prompts를 합치므로 구성에 따라 느리거나 외부 MCP 연결을 시작할 수 있다. skill만 필요하면 `/skill`이 더 좁다. |
| remote skill discovery | OpenCode skill 설정에 URL catalog가 있으면 discovery가 이를 pull할 수 있다. 모델 turn/session은 만들지 않지만 완전한 무네트워크 조회는 아니다. ([OpenCode v1.14.48 remote skill discovery, lines 174–180](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/skill/index.ts#L174-L180)) |
| permission 의미 | `/skill`과 `/command`는 agent별 `deny`가 적용된 model-facing 목록이 아니라 등록된 slash catalog에 가깝다. 선택 agent별 허용 목록이 필요하면 별도 정책 평가가 필요하다. |
| built-in TUI commands | `/command`는 TUI 전용 command 전체를 반환하지 않는다. Tessera 자체 registry와 provider-reported 목록을 지금처럼 별도 병합해야 한다. |
| server lifecycle | transient server는 반드시 loopback에만 bind하고, 성공·오류·timeout 모두에서 종료해야 한다. `--port 0`에 의존하지 말고 빈 loopback port를 확보해 명시적으로 넘긴 뒤 stdout의 listening URL과 일치하는지 확인한다. |

## 최종 판단

OpenCode도 Claude Code/Codex와 동일하게 “메시지 0개, 대화 세션 미생성” 상태에서 목록 조회를 지원할 수 있다. 가장 직접적인 공식 경로는 ACP가 아니라:

```text
opencode serve
  -> GET /command?directory=<session work_dir>
  -> name/description만 사용
  -> server 종료
```

이다. Skill만 필요할 때는 같은 방식으로 `GET /skill`을 사용하면 된다.
