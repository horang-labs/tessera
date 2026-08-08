'use client';

import { useMediaQuery } from '@/hooks/use-media-query';
import { PHONE_VIEWPORT_MEDIA_QUERY } from '@/lib/viewport/phone-viewport';

/**
 * Whether the viewport is a Phone viewport (<640px).
 *
 * Desktop non-regression is the point of `useMediaQuery`'s `false` fallbacks:
 * without a window, without `matchMedia`, and on the server, this is not a
 * phone, so a desktop tree is what renders.
 */
export function usePhoneViewport(): boolean {
  return useMediaQuery(PHONE_VIEWPORT_MEDIA_QUERY);
}
