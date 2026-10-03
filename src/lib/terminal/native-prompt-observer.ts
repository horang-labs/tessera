import type { NativeInteraction, NativeRuntimeIdentity } from '@/lib/automation/activation-contracts';
import type { NativePromptFrame } from './terminal-headless-model';

export function observeNativePrompt(identity: NativeRuntimeIdentity, version: string, frame: NativePromptFrame): NativeInteraction {
  const unknown: NativeInteraction = { kind: 'unknown', reason: 'native-prompt-unverified' };
  if (frame.pending || !supportsNativeInteraction(identity.provider, version)) return unknown;
  const { row, column } = frame.cursor;
  const cells = frame.cursorLineCells;
  const claude = identity.provider === 'claude-code';
  if (cells[0]?.chars !== (claude ? '❯' : '›') || (!claude && !cells[0].bold) || cells[0].dim
    || cells[1]?.chars.trim()) return unknown;
  const text = cells.slice(2).filter(cell => cell.chars.trim());
  if (text.some(cell => !cell.dim)) return { kind: 'draft', identity };
  const chrome = claude
    ? /^─{8,}$/.test(frame.lines[row - 1]?.trim() ?? '') && /^─{8,}$/.test(frame.lines[row + 1]?.trim() ?? '')
    : text.length > 0 && frame.lines.slice(row + 1).some(line => line.includes('? for shortcuts'));
  if (column !== 2 || !chrome) return unknown;
  return { kind: 'ready', identity, proofVersion: `${identity.provider}/${version}/empty-composer-v1`, empty: true };
}

/** Only native versions whose prompt/hook shape has been pinned. Unknown upgrades wait. */
export function supportsNativeInteraction(provider: string, version: string): boolean {
  return provider === 'codex' ? version === '0.159.2' : provider === 'claude-code' && version === '2.1.284';
}

/** Confirm only this transaction's paste in the native input block, excluding transcript/history. */
export function observesNativePaste(provider: NativeRuntimeIdentity['provider'], prompt: string, frame: NativePromptFrame): boolean {
  if (frame.pending) return false;
  const glyph = provider === 'codex' ? '›' : '❯';
  let start = frame.cursor.row;
  while (start >= 0 && frame.prefixes[start]?.[0]?.chars !== glyph) start--;
  const prefix = frame.prefixes[start]?.[0];
  if (!prefix || prefix.dim || (provider === 'codex' && !prefix.bold)) return false;
  const text = frame.lines.slice(start, frame.cursor.row + 1).map(line => line.slice(2).trim()).join('');
  // Codex stores large bracketed pastes behind this exact native element label (0.159.2 source).
  if (provider === 'codex' && text === `[Pasted Content ${Array.from(prompt).length} chars]`) return true;
  return text.replace(/\s/g, '') === prompt.replace(/\s/g, '');
}
