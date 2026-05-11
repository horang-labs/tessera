export function formatWorkspaceFileReference(filePath: string): string {
  return `@${filePath} `;
}

export function insertWorkspaceFileReferenceAtCursor(
  currentValue: string,
  cursorPos: number,
  filePath: string,
): { nextValue: string; nextCursorPos: number } {
  const safeCursorPos = Math.max(0, Math.min(cursorPos, currentValue.length));
  const insertion = formatWorkspaceFileReference(filePath);
  return {
    nextValue: currentValue.slice(0, safeCursorPos) + insertion + currentValue.slice(safeCursorPos),
    nextCursorPos: safeCursorPos + insertion.length,
  };
}
