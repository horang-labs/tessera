const CONFLICT_KEYS: ReadonlySet<string> = new Set([
  '$mod+t', '$mod+w', '$mod+n', '$mod+r', '$mod+l', '$mod+j', '$mod+h',
  '$mod+b', '$mod+,',
  '$mod+1', '$mod+2', '$mod+3', '$mod+4', '$mod+5',
  '$mod+6', '$mod+7', '$mod+8', '$mod+9',
  '$mod+shift+t', '$mod+shift+w', '$mod+shift+n', '$mod+shift+d',
]);

function normalize(key: string): string {
  return key.toLowerCase();
}

export function isBrowserConflict(key: string): boolean {
  if (!key) return false;
  return CONFLICT_KEYS.has(normalize(key));
}
