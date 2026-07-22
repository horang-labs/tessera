/**
 * A PTY chunk can end in the middle of an escape sequence. Those bytes live
 * only in xterm's parser state and are absent from SerializeAddon output. Keep
 * the incomplete tail so replay can re-arm the parser before live bytes resume.
 */

type ScanState =
  | 'ground'
  | 'esc'
  | 'escIntermediate'
  | 'csi'
  | 'osc'
  | 'oscEsc'
  | 'string'
  | 'stringEsc';

const ESC = 0x1b;
const CAN = 0x18;
const SUB = 0x1a;
const BEL = 0x07;

export const MAX_PARTIAL_ESCAPE_TAIL_LENGTH = 4_096;

function stateAfterEscByte(code: number): ScanState {
  if (code === 0x5b) return 'csi';
  if (code === 0x5d) return 'osc';
  // DCS, SOS, PM and APC are all terminated by ST.
  if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
    return 'string';
  }
  if (code >= 0x20 && code <= 0x2f) return 'escIntermediate';
  if (code < 0x20 || code === 0x7f) return 'esc';
  return 'ground';
}

export function extractPartialEscapeTail(stream: string): string {
  let state: ScanState = 'ground';
  let start = 0;

  for (let index = 0; index < stream.length; index += 1) {
    const code = stream.charCodeAt(index);
    if (state === 'ground') {
      if (code === ESC) {
        start = index;
        state = 'esc';
      }
      continue;
    }

    if (
      code === ESC
      && state !== 'osc'
      && state !== 'string'
      && state !== 'oscEsc'
      && state !== 'stringEsc'
    ) {
      start = index;
      state = 'esc';
      continue;
    }

    if (
      (code === CAN || code === SUB)
      && (state === 'esc' || state === 'escIntermediate')
    ) {
      state = 'ground';
      continue;
    }

    switch (state) {
      case 'esc':
        state = stateAfterEscByte(code);
        break;
      case 'escIntermediate':
        if (code >= 0x30 && code <= 0x7e) state = 'ground';
        break;
      case 'csi':
        if (code === CAN || code === SUB || (code >= 0x40 && code <= 0x7e)) {
          state = 'ground';
        }
        break;
      case 'osc':
        if (code === BEL || code === CAN || code === SUB) {
          state = 'ground';
        } else if (code === ESC) {
          state = 'oscEsc';
        }
        break;
      case 'oscEsc':
        if (code === 0x5c) {
          state = 'ground';
        } else {
          start = index - 1;
          state = code === ESC ? 'esc' : stateAfterEscByte(code);
        }
        break;
      case 'string':
        if (code === CAN || code === SUB) {
          state = 'ground';
        } else if (code === ESC) {
          state = 'stringEsc';
        }
        break;
      case 'stringEsc':
        if (code === 0x5c) {
          state = 'ground';
        } else {
          start = index - 1;
          state = code === ESC ? 'esc' : stateAfterEscByte(code);
        }
        break;
    }
  }

  return state === 'ground' ? '' : stream.slice(start);
}

export function advancePartialEscapeTail(pendingTail: string, chunk: string): string {
  const tail = extractPartialEscapeTail(pendingTail + chunk);
  return tail.length > MAX_PARTIAL_ESCAPE_TAIL_LENGTH ? '' : tail;
}
