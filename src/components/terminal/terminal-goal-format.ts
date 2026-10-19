/** Display helpers shared by the goal banner and its history. */

export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const compactFormatters = new Map<string, Intl.NumberFormat>();

/** Token counts follow the app language, not the OS locale ("5.9K", not "5.9천"). */
export function formatCompact(value: number, language: string): string {
  let formatter = compactFormatters.get(language);
  if (!formatter) {
    formatter = new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 });
    compactFormatters.set(language, formatter);
  }
  return formatter.format(value);
}


const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/** When a goal ended, in the app language: "Oct 19, 14:02". */
export function formatGoalTime(epochMs: number, language: string): string {
  let formatter = timeFormatters.get(language);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(language, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    timeFormatters.set(language, formatter);
  }
  return formatter.format(epochMs);
}
