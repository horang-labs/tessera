import { normalizeFontScale } from '@/lib/settings/provider-defaults';

const WEB_UI_TEXT_SIZE_PX = 14;

export function getTerminalFontSize(fontScale: unknown): number {
  return WEB_UI_TEXT_SIZE_PX * normalizeFontScale(fontScale);
}
