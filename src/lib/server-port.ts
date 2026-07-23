/**
 * 서버가 바인딩하는 포트. server.ts와 PTY env 주입(TESSERA_HOOK_PORT)이
 * 반드시 같은 값을 써야 하므로 단일 헬퍼로 통일한다(드리프트 방지).
 */
export function getServerPort(): number {
  const dev = process.env.NODE_ENV !== 'production';
  return parseInt(process.env.PORT || (dev ? '3100' : '3000'), 10);
}
