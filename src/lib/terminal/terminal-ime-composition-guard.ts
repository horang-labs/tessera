// Keep terminal output from disturbing an in-flight IME composition.
//
// xterm resolves the text a composition commits through two setTimeout(0)
// hops: compositionupdate defers _compositionPosition.end, and
// _finalizeComposition defers the substring() that is actually sent. Both read
// a helper textarea whose screen position xterm re-derives from the CLI cursor
// on every onRender — and tessera forces a full-grid refresh for each PTY
// chunk, so an agentic CLI repainting its prompt drives
// updateCompositionElements dozens of times a second, each call rewriting the
// textarea and composition overlay styles underneath the OS IME.
//
// Hangul is what loses that race. Typing ㅏ after 저+ㄱ makes the IME migrate
// the trailing consonant (적 -> 저+가), and xterm's own comment in
// _finalizeComposition names that exact case as the reason the commit has to be
// deferred. Finalize mid-migration and the pre-migration syllable ships while
// the vowel arrives as a separate composition — "컴포저가" lands as "컴포적 ㅏ".
//
// Nothing reaches the PTY until the IME commits, so a repaint that arrives
// mid-composition can never describe the text being composed: pinning the
// composition anchor for the composition's lifetime costs no accuracy. The
// first placement (xterm syncs the textarea to the cursor on compositionstart)
// is kept, later ones are reverted, and the surface catches up with a single
// refresh once composition ends.

type CompositionElementsUpdater = (dontRecurse?: boolean) => void;

interface CompositionHelperLike {
  updateCompositionElements: CompositionElementsUpdater;
  /** Offsets into the helper textarea that bound the text a commit will send. */
  _compositionPosition?: { start: number; end: number };
}

interface CompositionAnchor {
  left: string;
  top: string;
}

export interface TerminalCompositionGuardOptions {
  /** Surface root the terminal was opened into; composition events are captured here. */
  root: HTMLElement;
  /**
   * The xterm Terminal. Typed loosely on purpose: the helper this guard wraps
   * hangs off a private core that no shared surface type describes, so the
   * narrowing (and the bail-out when a future xterm moves it) lives here rather
   * than leaking an internals-shaped `_core` into every caller's terminal type.
   */
  terminal: unknown;
  /** Invoked after a composition commits, so the surface can replay deferred repaints. */
  onCompositionSettled: () => void;
}

function readCompositionHelper(terminal: unknown): CompositionHelperLike | null {
  const helper = (terminal as { _core?: { _compositionHelper?: unknown } } | null)?._core
    ?._compositionHelper;
  if (
    !helper
    || typeof (helper as Partial<CompositionHelperLike>).updateCompositionElements !== 'function'
  ) {
    return null;
  }
  return helper as CompositionHelperLike;
}

export class TerminalCompositionGuard {
  private readonly root: HTMLElement;
  private readonly onCompositionSettled: () => void;
  private readonly helper: CompositionHelperLike | null;
  private readonly originalUpdate: CompositionElementsUpdater | null;
  private readonly startListener: () => void;
  private readonly endListener: () => void;
  private readonly focusOutListener: () => void;
  // Resolved once at construction — xterm builds both in open(), which the
  // surface calls before this guard exists, and the pin runs per rendered frame.
  private readonly textarea: HTMLTextAreaElement | null;
  private readonly overlay: HTMLElement | null;

  private composing = false;
  private anchor: CompositionAnchor | null = null;
  private disposed = false;

  constructor(options: TerminalCompositionGuardOptions) {
    this.root = options.root;
    this.onCompositionSettled = options.onCompositionSettled;
    this.helper = readCompositionHelper(options.terminal);
    this.originalUpdate = this.helper
      ? this.helper.updateCompositionElements.bind(this.helper)
      : null;
    this.textarea = this.root.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    this.overlay = this.root.querySelector<HTMLElement>('.composition-view');

    this.startListener = () => {
      this.composing = true;
      this.anchor = null;
    };
    this.endListener = () => this.endComposition();
    // A composition abandoned rather than committed (the window loses focus
    // mid-syllable) can skip compositionend entirely. Without this the guard
    // would hold the surface's forced repaints suppressed indefinitely.
    this.focusOutListener = () => this.endComposition();

    // Capture phase: xterm listens on the textarea itself, so these run first
    // and the pin is armed before xterm places the composition elements.
    this.root.addEventListener('compositionstart', this.startListener, true);
    this.root.addEventListener('compositionend', this.endListener, true);
    this.root.addEventListener('focusout', this.focusOutListener, true);

    if (this.helper && this.originalUpdate) {
      const originalUpdate = this.originalUpdate;
      this.helper.updateCompositionElements = (dontRecurse?: boolean) => {
        originalUpdate(dontRecurse);
        this.pinCompositionAnchor();
      };
    }
  }

  public isComposing(): boolean {
    return this.composing;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.composing = false;
    this.anchor = null;
    this.root.removeEventListener('compositionstart', this.startListener, true);
    this.root.removeEventListener('compositionend', this.endListener, true);
    this.root.removeEventListener('focusout', this.focusOutListener, true);
    if (this.helper && this.originalUpdate) {
      this.helper.updateCompositionElements = this.originalUpdate;
    }
  }

  /**
   * Bring xterm's deferred composition end offset forward.
   *
   * compositionupdate queues the `_compositionPosition.end` update on a
   * setTimeout(0) (CompositionHelper.ts:96-99). A non-composition key — space,
   * enter, backspace — landing before that timer runs makes
   * CompositionHelper.keydown() finalize against a stale end, so only the part
   * of the syllable the timer had caught up to is committed and the remainder
   * resurfaces as its own composition: "게" commits as "ㄱ" and leaves "ㅔ"
   * behind. Typing faster than the timer is enough on its own, and a busy event
   * loop (PTY output, full-grid repaints) widens the window further — which is
   * why it reads as random.
   *
   * This runs the identical computation xterm's own timer would, early enough
   * to be seen. Callers must invoke it before xterm inspects the key.
   */
  public syncCompositionEnd(): void {
    if (!this.composing || this.disposed) return;
    const position = this.helper?._compositionPosition;
    if (!position || !this.textarea) return;
    const end = this.textarea.selectionEnd ?? this.textarea.value.length;
    position.end = Math.max(position.start, end);
  }

  private endComposition(): void {
    if (!this.composing) return;
    this.composing = false;
    this.anchor = null;
    this.onCompositionSettled();
  }

  private pinCompositionAnchor(): void {
    if (!this.composing || this.disposed || !this.textarea) return;

    if (!this.anchor) {
      // Adopt the placement xterm just made for this composition. Skip until it
      // has one: with the cursor off-viewport updateCompositionElements is a
      // no-op and the styles are still empty.
      const { left, top } = this.textarea.style;
      if (left && top) this.anchor = { left, top };
      return;
    }

    for (const element of [this.textarea, this.overlay]) {
      if (!element) continue;
      // Compare before writing: an unchanged cursor makes this a no-op rather
      // than a fresh layout invalidation on every rendered frame.
      if (element.style.left !== this.anchor.left) element.style.left = this.anchor.left;
      if (element.style.top !== this.anchor.top) element.style.top = this.anchor.top;
    }
  }
}
