import { escapeShellPath } from './shell-path-escape';

export interface TerminalChatComposerEdit {
  nextCursorPos: number;
  nextValue: string;
}

/** Insert one or more terminal-safe paths at the textarea caret, matching PTY drop behavior. */
export function insertTerminalChatPathsAtCursor(
  value: string,
  cursorPos: number,
  paths: string[],
): TerminalChatComposerEdit {
  const insertion = paths
    .map(escapeShellPath)
    .filter((path): path is string => path !== null)
    .join(' ');
  const safeCursorPos = Math.max(0, Math.min(cursorPos, value.length));
  if (!insertion) return { nextValue: value, nextCursorPos: safeCursorPos };

  const insertedText = `${insertion} `;
  return {
    nextValue: `${value.slice(0, safeCursorPos)}${insertedText}${value.slice(safeCursorPos)}`,
    nextCursorPos: safeCursorPos + insertedText.length,
  };
}
