// xterm's WriteBuffer._innerWrite invokes write-completion callbacks with no
// try/catch; a synchronous throw skips the loop's tail re-schedule, and
// write() only re-arms processing when the buffer is empty — which a stalled
// buffer never is again. One escaping throw therefore permanently freezes the
// surface: output stops rendering and the shell keeps eating keystrokes.
// Guard each completion step individually so an earlier step's failure (e.g.
// a WebGL refresh during viewport settle) cannot starve a later step.

const MAX_REPORTS_PER_CONTEXT = 5;
const reportCountsByContext = new Map<string, number>();

export function runGuardedWriteCompletionStep(context: string, step: () => void): void {
  try {
    step();
  } catch (error: unknown) {
    const reported = reportCountsByContext.get(context) ?? 0;
    if (reported >= MAX_REPORTS_PER_CONTEXT) return;
    reportCountsByContext.set(context, reported + 1);
    console.error(`[terminal] write-completion step "${context}" threw`, error);
  }
}
