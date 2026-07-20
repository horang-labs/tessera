export function normalizeExternalHttpUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null;

  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}
