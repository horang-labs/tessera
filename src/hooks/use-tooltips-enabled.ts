'use client';

import { useMediaQuery } from '@/hooks/use-media-query';
import { PHONE_VIEWPORT_MEDIA_QUERY } from '@/lib/viewport/phone-viewport';

/** Tooltips are desktop hints; phones and touch-only devices do not show them. */
export function useTooltipsEnabled(): boolean {
  return !useMediaQuery(`${PHONE_VIEWPORT_MEDIA_QUERY}, (hover: none)`);
}
