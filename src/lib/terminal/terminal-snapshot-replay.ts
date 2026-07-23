export interface TerminalSnapshotReplayPayload {
  data: string;
  alternateScreen?: boolean;
  scrollbackAnsi?: string;
  pendingEscapeTailAnsi?: string;
}

/** Build one ordered replay stream. A partial escape tail must be last. */
export function buildTerminalSnapshotReplay(
  snapshot: TerminalSnapshotReplayPayload,
): string {
  let preamble: string;
  if (!snapshot.alternateScreen) {
    preamble = '\x1b[?1049l\x1b[2J\x1b[3J\x1b[H';
  } else if (snapshot.scrollbackAnsi !== undefined) {
    preamble = [
      '\x1b[?1049l\x1b[2J\x1b[3J\x1b[H',
      snapshot.scrollbackAnsi,
      '\x1b[0m\x1b[?1049h\x1b[2J\x1b[H',
    ].join('');
  } else {
    preamble = '\x1b[0m\x1b[?1049h\x1b[2J\x1b[H';
  }

  return `${preamble}${snapshot.data}${snapshot.pendingEscapeTailAnsi ?? ''}`;
}
