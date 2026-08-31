import type { ElectronTerminalClipboardApi } from './terminal-clipboard-paste';

/**
 * OSC 52 clipboard write support for the live terminal surface.
 *
 * Terminal TUIs (OpenCode's Ink UI, tmux, etc.) copy text by emitting the OSC
 * 52 escape sequence — `ESC ] 52 ; <selection> ; <base64> ST/BEL` — which the
 * terminal emulator is expected to turn into a system clipboard write. WezTerm,
 * Windows Terminal and others do this natively; xterm.js does not, so without
 * this handler the TUI reports "copied to clipboard" while nothing reaches the
 * desktop clipboard.
 *
 * Policy (mirrors WezTerm's `osc52 = "Clipboard"` write behaviour):
 * - Only writes to the system clipboard selection (`c`) are honoured.
 * - Read requests (payload `?`) are deliberately not answered, so a terminal
 *   program cannot silently exfiltrate the user's clipboard.
 * - Primary/secondary selections (`p`/`s`) have no Windows equivalent and are
 *   ignored.
 */

const OSC52_MAX_DECODED_BYTES = 4 * 1024 * 1024;

export interface TerminalOsc52Parser {
  registerOscHandler(
    ident: number,
    callback: (data: string) => boolean | Promise<boolean>,
  ): { dispose(): void };
}

export interface Osc52TerminalLike {
  parser: TerminalOsc52Parser;
}

/**
 * Installs an OSC 52 handler on the live xterm parser. Returns a disposable to
 * unregister it when the surface tears down.
 */
export function installTerminalOsc52Handler(terminal: Osc52TerminalLike): { dispose(): void } {
  return terminal.parser.registerOscHandler(52, (data) => {
    const pending = handleOsc52Payload(data);
    if (pending) {
      pending.catch((error: unknown) => {
        console.warn('[terminal] OSC 52 clipboard write failed', error);
      });
    }
    return true;
  });
}

function handleOsc52Payload(data: string): Promise<void> | null {
  const text = parseOsc52Payload(data);
  if (text === null) return null;
  return writeToClipboard(text);
}

/**
 * Parses an OSC 52 payload (`<selection>;<base64>` or `c;?` for a read
 * request) into the text to copy. Returns null when the payload is a read
 * request, targets a non-system selection, or is not valid base64.
 */
export function parseOsc52Payload(data: string): string | null {
  const separatorIndex = data.indexOf(';');
  if (separatorIndex === -1) return null;

  const selection = data.slice(0, separatorIndex);
  const payload = data.slice(separatorIndex + 1);

  // Only the system clipboard is meaningful on the desktop. Ignore primary and
  // secondary selections (and any other naming) rather than write garbage.
  if (selection !== 'c') return null;

  // A bare query requests clipboard contents — never answer it.
  if (payload === '' || payload === '?') return null;

  return decodeOsc52Base64(payload);
}

function decodeOsc52Base64(payload: string): string | null {
  try {
    const binary = atob(payload);
    if (binary.length > OSC52_MAX_DECODED_BYTES) return null;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

async function writeToClipboard(text: string): Promise<void> {
  const electronClipboard = (
    window as Window & { electronAPI?: Partial<ElectronTerminalClipboardApi> }
  ).electronAPI;
  if (typeof electronClipboard?.writeTerminalClipboardText === 'function') {
    await electronClipboard.writeTerminalClipboardText(text);
    return;
  }
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error('OSC 52 clipboard write: no clipboard backend available.');
}
