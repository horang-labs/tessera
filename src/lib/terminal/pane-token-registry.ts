import { randomBytes, timingSafeEqual } from 'crypto';

export interface PaneTokenEntry {
  terminalId: string;
  userId: string;
  sessionId: string | null;
  providerId: string; // invocation-scoped PTY provider id
}

// token(base64url) → entry. 서버 프로세스 수명과 함께 살아있는 in-memory 싱글턴.
const registry = new Map<string, PaneTokenEntry>();

export function mintPaneToken(entry: PaneTokenEntry): string {
  const token = randomBytes(32).toString('base64url');
  registry.set(token, entry);
  return token;
}

/**
 * 후보 토큰을 등록된 각 토큰과 상수시간 비교한다. Map.get()으로 바로 조회하지 않는 이유는
 * 토큰 존재 여부가 조회 시간에 노출되는 것을 막기 위함(타이밍 사이드채널 차단).
 */
export function resolvePaneToken(candidate: string): PaneTokenEntry | null {
  if (!candidate) return null;
  const candidateBuf = Buffer.from(candidate);
  for (const [token, entry] of registry) {
    const tokenBuf = Buffer.from(token);
    if (tokenBuf.length === candidateBuf.length && timingSafeEqual(tokenBuf, candidateBuf)) {
      return entry;
    }
  }
  return null;
}

export function revokePaneToken(token: string): void {
  registry.delete(token);
}

/** terminalId로 토큰을 폐기(터미널 종료/close 시). 발급 시 토큰 문자열을 몰라도 정리 가능. */
export function revokePaneTokensForTerminal(terminalId: string): void {
  for (const [token, entry] of registry) {
    if (entry.terminalId === terminalId) registry.delete(token);
  }
}
