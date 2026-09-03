const XTERM_COMPOSITION_SESSION_START_EVENT = 'xterm-composition-session-start';
const XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT = 'xterm-composition-transaction-settled';

/** Keeps app-requested terminal repaints out of xterm's IME transaction window. */
export class TerminalCompositionRenderGate {
  private active = false;
  private readonly start = () => {
    this.active = true;
  };
  private readonly settle = () => {
    if (!this.active) return;
    this.active = false;
    this.onSettled();
  };

  constructor(
    private readonly target: EventTarget,
    private readonly onSettled: () => void,
  ) {
    target.addEventListener('compositionstart', this.start);
    target.addEventListener(XTERM_COMPOSITION_SESSION_START_EVENT, this.start);
    // The patched xterm emits this only after compositionend and its following
    // input event have been reconciled, which is later than native compositionend.
    target.addEventListener(XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT, this.settle);
    target.addEventListener('focusout', this.settle);
  }

  isActive(): boolean {
    return this.active;
  }

  dispose(): void {
    this.active = false;
    this.target.removeEventListener('compositionstart', this.start);
    this.target.removeEventListener(XTERM_COMPOSITION_SESSION_START_EVENT, this.start);
    this.target.removeEventListener(XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT, this.settle);
    this.target.removeEventListener('focusout', this.settle);
  }
}
