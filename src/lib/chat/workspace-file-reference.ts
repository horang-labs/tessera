export function formatWorkspaceFileReference(filePath: string): string {
  return `@${filePath} `;
}

export function insertWorkspaceFileReferenceAtCursor(
  currentValue: string,
  cursorPos: number,
  filePath: string,
): { nextValue: string; nextCursorPos: number } {
  return insertWorkspaceFileReferencesAtCursor(currentValue, cursorPos, [filePath]);
}

export function insertWorkspaceFileReferencesAtCursor(
  currentValue: string,
  cursorPos: number,
  filePaths: string[],
): { nextValue: string; nextCursorPos: number } {
  const safeCursorPos = Math.max(0, Math.min(cursorPos, currentValue.length));
  const insertion = filePaths.map(formatWorkspaceFileReference).join('');
  return {
    nextValue: currentValue.slice(0, safeCursorPos) + insertion + currentValue.slice(safeCursorPos),
    nextCursorPos: safeCursorPos + insertion.length,
  };
}
