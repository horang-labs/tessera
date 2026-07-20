import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachTerminalMouseWheelMultiplier,
  shouldMultiplyTerminalMouseWheel,
} from '@/lib/terminal/terminal-mouse-wheel';

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;

class TestWheelEvent extends Event {
  readonly altKey: boolean;
  readonly button: number;
  readonly buttons: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly ctrlKey: boolean;
  readonly deltaMode: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaZ: number;
  readonly detail: number;
  readonly metaKey: boolean;
  readonly relatedTarget: EventTarget | null;
  readonly screenX: number;
  readonly screenY: number;
  readonly shiftKey: boolean;
  readonly view: Window | null;

  constructor(type: string, init: WheelEventInit = {}) {
    super(type, init);
    this.altKey = init.altKey ?? false;
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? 0;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.ctrlKey = init.ctrlKey ?? false;
    this.deltaMode = init.deltaMode ?? DOM_DELTA_PIXEL;
    this.deltaX = init.deltaX ?? 0;
    this.deltaY = init.deltaY ?? 0;
    this.deltaZ = init.deltaZ ?? 0;
    this.detail = init.detail ?? 0;
    this.metaKey = init.metaKey ?? false;
    this.relatedTarget = init.relatedTarget ?? null;
    this.screenX = init.screenX ?? 0;
    this.screenY = init.screenY ?? 0;
    this.shiftKey = init.shiftKey ?? false;
    this.view = init.view ?? null;
  }
}

test('normal terminal scrollback is left to xterm', () => {
  const element = {
    classList: {
      contains: () => false,
    },
  } as unknown as HTMLElement;
  const event = new TestWheelEvent('wheel', { deltaY: 12 }) as WheelEvent;

  assert.equal(shouldMultiplyTerminalMouseWheel(event, element), false);
});

test('Claude, Codex, and OpenCode mouse-reporting TUIs receive the full trackpad wheel distance', async () => {
  const originalWheelEvent = globalThis.WheelEvent;
  Object.defineProperty(globalThis, 'WheelEvent', {
    configurable: true,
    value: TestWheelEvent,
  });

  try {
    const handlers: Array<(event: WheelEvent) => boolean> = [];
    const target = Object.assign(new EventTarget(), {
      classList: {
        contains: (className: string) => className === 'enable-mouse-events',
      },
      querySelector: () => ({
        getBoundingClientRect: () => ({ height: 384 }),
      }),
    }) as unknown as EventTarget & HTMLElement;
    const replayed: WheelEvent[] = [];
    target.addEventListener('wheel', (event) => replayed.push(event as WheelEvent));

    attachTerminalMouseWheelMultiplier({
      attachCustomWheelEventHandler: (handler) => handlers.push(handler),
      element: target,
      rows: 24,
    });

    const event = new TestWheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: DOM_DELTA_PIXEL,
      deltaY: -16 * 12,
    }) as WheelEvent;

    assert.equal(handlers.length, 1);
    assert.equal(handlers[0]?.(event), false);
    await Promise.resolve();

    assert.equal(replayed.length, 12);
    assert.deepEqual(replayed.map((entry) => entry.deltaMode), Array(12).fill(DOM_DELTA_LINE));
    assert.deepEqual(replayed.map((entry) => entry.deltaY), Array(12).fill(-1));
  } finally {
    if (originalWheelEvent) {
      Object.defineProperty(globalThis, 'WheelEvent', {
        configurable: true,
        value: originalWheelEvent,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'WheelEvent');
    }
  }
});

test('scroll-intent tracking must not claim wheel events a mouse-reporting TUI owns', async () => {
  const { isTerminalTuiOwnedWheelEvent } = await import('@/lib/terminal/terminal-mouse-wheel');
  const reportingElement = {
    classList: { contains: (name: string) => name === 'enable-mouse-events' },
  } as unknown as HTMLElement;
  const plainElement = {
    classList: { contains: () => false },
  } as unknown as HTMLElement;
  const wheelUp = new TestWheelEvent('wheel', { deltaY: -12 }) as WheelEvent;
  const shiftWheelUp = new TestWheelEvent('wheel', { deltaY: -12, shiftKey: true }) as WheelEvent;

  // TUI(클코) mouse-reporting 중의 휠은 앱 소유 — 뷰포트 pin 금지.
  assert.equal(isTerminalTuiOwnedWheelEvent(wheelUp, reportingElement), true);
  // 일반 셸 스크롤백 휠은 추적 대상.
  assert.equal(isTerminalTuiOwnedWheelEvent(wheelUp, plainElement), false);
  // Shift+휠은 mouse mode에서도 xterm 스크롤백으로 우회하므로 추적 대상.
  assert.equal(isTerminalTuiOwnedWheelEvent(shiftWheelUp, reportingElement), false);
});

test('replayed wheel-report clones must never re-enter scroll-intent tracking', async () => {
  const { isTerminalTuiOwnedWheelEvent } = await import('@/lib/terminal/terminal-mouse-wheel');
  const originalWheelEvent = globalThis.WheelEvent;
  Object.defineProperty(globalThis, 'WheelEvent', {
    configurable: true,
    value: TestWheelEvent,
  });

  try {
    const handlers: Array<(event: WheelEvent) => boolean> = [];
    const target = Object.assign(new EventTarget(), {
      classList: {
        contains: (className: string) => className === 'enable-mouse-events',
      },
      querySelector: () => ({
        getBoundingClientRect: () => ({ height: 384 }),
      }),
    }) as unknown as EventTarget & HTMLElement;
    const replayed: WheelEvent[] = [];
    target.addEventListener('wheel', (event) => replayed.push(event as WheelEvent));

    attachTerminalMouseWheelMultiplier({
      attachCustomWheelEventHandler: (handler) => handlers.push(handler),
      element: target,
      rows: 24,
    });
    handlers[0]?.(new TestWheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: DOM_DELTA_PIXEL,
      deltaY: -16 * 4,
    }) as WheelEvent);
    await Promise.resolve();

    assert.ok(replayed.length > 1, 'multiplier must replay wheel report clones');
    for (const clone of replayed) {
      assert.equal(
        isTerminalTuiOwnedWheelEvent(clone, target),
        true,
        'a replayed clone bubbling through capture listeners must stay TUI-owned',
      );
    }
  } finally {
    if (originalWheelEvent) {
      Object.defineProperty(globalThis, 'WheelEvent', {
        configurable: true,
        value: originalWheelEvent,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'WheelEvent');
    }
  }
});
