/**
 * PTY 상태 훅이 서버(/__tessera/hook)로 POST할 때 쓰는 커맨드 문자열.
 *
 * 스타일은 "훅을 실행하는 런타임"을 따른다 (스폰 플랫폼이 아니라):
 *  - posix       : macOS / Linux 서버 / WSL 게스트. CLI가 훅을 /bin/sh -c 로 실행.
 *  - windows-cmd : win32 네이티브 PTY. CLI가 훅을 cmd /c 로 실행 — POSIX 문법이
 *                  동작하지 않아 %VAR% 확장 + System32\curl.exe 를 쓴다(orca와 동일:
 *                  경로를 풀로 적어 repo-local curl.exe 하이재킹도 차단).
 *
 * posix 커맨드는 이중 시도다(orca hook-service 미러):
 *  1. 게스트/로컬 curl → 127.0.0.1. macOS/Linux 서버·mirrored WSL에서 즉시 성공.
 *  2. 실패 시 WSL 런타임이면 curl.exe(Windows interop)로 재시도 — WSL2 기본 NAT에서
 *     게스트 127.0.0.1은 게스트 자신의 loopback이라 Windows 호스트 리스너에 닿지
 *     않는다. curl.exe는 Windows 프로세스라 그쪽 127.0.0.1이 호스트 loopback이다.
 *     interop PATH가 꺼진 환경을 위해 /mnt/c 절대경로도 폴백으로 둔다.
 *
 * --fail은 그 폴백의 전제("게스트 포트가 비어 연결 거부로 실패한다")를 지키는 장치다.
 * npm CLI(bin/tessera.mjs)와 Electron의 기본 포트가 둘 다 32123이고 win32/WSL은 네트워크
 * 스택이 분리돼 서로의 포트 스캔이 상대를 못 보므로, 게스트에 tessera를 띄우면 같은 포트에
 * 리스너가 생긴다. 그러면 1차 curl이 연결에 성공해 폴백이 죽는데, 그 서버는 pane token을
 * 모르니 401/403을 준다 — --fail이 없으면 curl이 exit 0이라 훅이 통째로 유실된다
 * (인디케이터 정지 + history 미기록으로 resume까지 깨짐). --fail은 4xx/5xx를 exit 22로
 * 바꿔 폴백을 살린다. 토큰 레지스트리는 in-memory라 남의 인스턴스가 204를 줄 수 없어,
 * "204 = 이 훅의 주인"이 항상 성립한다(정상 수신은 204라 --fail에 걸리지 않는다).
 *
 * stdin(훅 페이로드 JSON)은 한 번만 읽을 수 있으므로 변수에 담아 재시도에 재사용한다.
 * $TESSERA_HOOK_PORT / $TESSERA_SESSION_ID / $TESSERA_PANE_TOKEN 은 훅 셸의
 * env(=PTY env)에서 확장된다. 셸 인젝션 표면 없음: 값은 전부 서버가 주입한 env 참조뿐.
 * 항상 성공 종료(|| true / exit /b 0)하는 순수 lifecycle observer다.
 */

export type HookCommandStyle = 'posix' | 'windows-cmd';

const POSIX_HOOK_URL =
  '"http://127.0.0.1:$TESSERA_HOOK_PORT/__tessera/hook?session=$TESSERA_SESSION_ID"';

// 인자: $1=curl 바이너리, $2=connect-timeout, $3=max-time.
// 게스트 curl은 짧게(연결 거부는 즉시 실패), curl.exe는 부하 내성 있게(orca의 3/5초).
const POSIX_HOOK_POST_FN =
  'tessera_hook_post() { printf \'%s\' "$payload" | "$1" -sS --fail --connect-timeout "$2" --max-time "$3" '
  + '--noproxy 127.0.0.1 -X POST '
  + POSIX_HOOK_URL
  + ' -H "X-Tessera-Pane-Token: $TESSERA_PANE_TOKEN" --data-binary @- >/dev/null 2>&1; }';

const POSIX_IS_WSL =
  '{ [ -n "$WSL_DISTRO_NAME" ] || grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; }';

const POSIX_HOOK_COMMAND =
  'payload=$(cat); '
  + '[ -n "$TESSERA_HOOK_PORT" ] && [ -n "$TESSERA_SESSION_ID" ] && [ -n "$TESSERA_PANE_TOKEN" ] || exit 0; '
  + POSIX_HOOK_POST_FN
  + '; tessera_hook_post curl 0.5 2'
  + ' || { '
  + POSIX_IS_WSL
  + ' && { tessera_hook_post curl.exe 3 5 || tessera_hook_post /mnt/c/Windows/System32/curl.exe 3 5; }; }'
  + ' || true';

// cmd에는 함수/재시도가 없다: curl.exe 하나로 충분(네이티브에선 loopback이 곧 서버).
// `& exit /b 0` 로 curl 실패와 무관하게 성공 종료.
const WINDOWS_CMD_HOOK_COMMAND =
  'if not defined TESSERA_HOOK_PORT (more >nul & exit /b 0) & '
  + 'if not defined TESSERA_SESSION_ID (more >nul & exit /b 0) & '
  + 'if not defined TESSERA_PANE_TOKEN (more >nul & exit /b 0) & '
  + '"%SystemRoot%\\System32\\curl.exe" -sS --connect-timeout 1 --max-time 3 '
  + '--noproxy 127.0.0.1 -X POST '
  + '"http://127.0.0.1:%TESSERA_HOOK_PORT%/__tessera/hook?session=%TESSERA_SESSION_ID%" '
  + '-H "X-Tessera-Pane-Token: %TESSERA_PANE_TOKEN%" '
  + '--data-binary @- >nul 2>&1 & exit /b 0';

export function buildHookCommand(style: HookCommandStyle): string {
  return style === 'windows-cmd' ? WINDOWS_CMD_HOOK_COMMAND : POSIX_HOOK_COMMAND;
}
