export type Platform = 'mac' | 'win' | 'linux';

const ARROW_MAP: Record<string, string> = {
  ArrowRight: '→',
  ArrowLeft:  '←',
  ArrowUp:    '↑',
  ArrowDown:  '↓',
};

export function formatShortcut(key: string, platform: Platform): string {
  if (!key) return '';

  const isMac = platform === 'mac';
  const parts = key.split('+');
  const out: string[] = [];

  for (const raw of parts) {
    if (raw === '$mod')        out.push(isMac ? '⌘' : 'Ctrl');
    else if (raw === 'Alt')    out.push(isMac ? '⌥' : 'Alt');
    else if (raw === 'Shift')  out.push(isMac ? '⇧' : 'Shift');
    else if (raw === 'Meta')   out.push(isMac ? '⌘' : 'Meta');
    else if (raw === 'Control') out.push(isMac ? '⌃' : 'Ctrl');
    else if (ARROW_MAP[raw])   out.push(ARROW_MAP[raw]);
    else if (raw.length === 1) out.push(raw.toUpperCase());
    else                       out.push(raw);
  }

  return isMac ? out.join('') : out.join('+');
}

/** Detect platform from navigator. SSR-safe (returns 'win' on server). */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'win';
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad|iPod/.test(ua)) return 'mac';
  if (/Linux/.test(ua)) return 'linux';
  return 'win';
}
