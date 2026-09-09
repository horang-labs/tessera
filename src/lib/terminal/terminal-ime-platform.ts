/** Select by the input client's OS, never by the PTY/server's OS. */
export function shouldUseLinuxTerminalIme(userAgent: string, electronPlatform?: string): boolean {
  if (electronPlatform) return electronPlatform === 'linux';
  return /Linux/.test(userAgent) && !/Android/.test(userAgent);
}
