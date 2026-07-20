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
  'tessera_hook_post() { printf \'%s\' "$payload" | "$1" -sS --connect-timeout "$2" --max-time "$3" '
  + '--noproxy 127.0.0.1 -X POST '
  + POSIX_HOOK_URL
  + ' -H "X-Tessera-Pane-Token: $TESSERA_PANE_TOKEN" --data-binary @- >/dev/null 2>&1; }';

const POSIX_IS_WSL =
  '{ [ -n "$WSL_DISTRO_NAME" ] || grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; }';

const POSIX_HOOK_COMMAND =
  'payload=$(cat); '
  + POSIX_HOOK_POST_FN
  + '; tessera_hook_post curl 0.5 2'
  + ' || { '
  + POSIX_IS_WSL
  + ' && { tessera_hook_post curl.exe 3 5 || tessera_hook_post /mnt/c/Windows/System32/curl.exe 3 5; }; }'
  + ' || true';

// cmd에는 함수/재시도가 없다: curl.exe 하나로 충분(네이티브에선 loopback이 곧 서버).
// `& exit /b 0` 로 curl 실패와 무관하게 성공 종료.
const WINDOWS_CMD_HOOK_COMMAND =
  '"%SystemRoot%\\System32\\curl.exe" -sS --connect-timeout 1 --max-time 3 '
  + '--noproxy 127.0.0.1 -X POST '
  + '"http://127.0.0.1:%TESSERA_HOOK_PORT%/__tessera/hook?session=%TESSERA_SESSION_ID%" '
  + '-H "X-Tessera-Pane-Token: %TESSERA_PANE_TOKEN%" '
  + '--data-binary @- >nul 2>&1 & exit /b 0';

export function buildHookCommand(style: HookCommandStyle): string {
  return style === 'windows-cmd' ? WINDOWS_CMD_HOOK_COMMAND : POSIX_HOOK_COMMAND;
}
