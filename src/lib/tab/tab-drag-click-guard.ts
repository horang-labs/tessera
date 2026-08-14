export type TabClickSuppressionEvent =
  | 'click'
  | 'drag-start'
  | 'pointer-down'
  | 'reset';

export interface TabClickSuppressionTransition {
  suppressed: boolean;
  shouldActivate: boolean;
}

/**
 * A browser emits a click after some native drag gestures. Suppress that click,
 * but let the next deliberate pointer interaction recover even when Electron
 * fails to deliver dragend (for example after the dragged tab is re-rendered).
 */
export function transitionTabClickSuppression(
  suppressed: boolean,
  event: TabClickSuppressionEvent,
): TabClickSuppressionTransition {
  if (event === 'drag-start') {
    return { suppressed: true, shouldActivate: false };
  }
  if (event === 'click') {
    return { suppressed: false, shouldActivate: !suppressed };
  }
  return { suppressed: false, shouldActivate: false };
}
