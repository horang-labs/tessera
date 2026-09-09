export const MIN_PANEL_WIDTH = 250;
export const MIN_PANEL_HEIGHT = 150;

export type PanelSplitDirection = 'horizontal' | 'vertical';
export type PanelSplitPosition = 'before' | 'after';
export type PanelSplitPlacement = 'left' | 'right' | 'up' | 'down';

export interface PanelSplitSpec {
  direction: PanelSplitDirection;
  position: PanelSplitPosition;
}

const PANEL_SPLIT_SPECS: Record<PanelSplitPlacement, PanelSplitSpec> = {
  left: { direction: 'horizontal', position: 'before' },
  right: { direction: 'horizontal', position: 'after' },
  up: { direction: 'vertical', position: 'before' },
  down: { direction: 'vertical', position: 'after' },
};

export function isPanelSplitPlacement(value: unknown): value is PanelSplitPlacement {
  return value === 'left' || value === 'right' || value === 'up' || value === 'down';
}

export function getPanelSplitSpec(placement: PanelSplitPlacement): PanelSplitSpec {
  return PANEL_SPLIT_SPECS[placement];
}

export function isPanelLargeEnoughToSplit(
  rect: Pick<DOMRect, 'width' | 'height'>,
  direction: PanelSplitDirection,
): boolean {
  return direction === 'horizontal'
    ? rect.width / 2 >= MIN_PANEL_WIDTH
    : rect.height / 2 >= MIN_PANEL_HEIGHT;
}
