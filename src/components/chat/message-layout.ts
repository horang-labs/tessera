// Desktop: row px-2 (8) + w-8 avatar (32) + gap-3 (12) = 52px = 3.25rem offset.
// Phone (max-sm): row px-1 (4) + w-4 avatar (16) + gap-1.5 (6) = 26px = 1.625rem.
// Tool calls, thinking blocks, etc. reuse this offset so their body starts
// exactly where the assistant text does; keep the two in step whenever either
// side of the calculation moves.
export const MESSAGE_BODY_MAX_WIDTH_CLASS = 'max-w-2xl';
export const MESSAGE_BODY_OFFSET_CLASS = 'ml-[3.25rem] max-sm:ml-[1.625rem] mr-2 max-sm:mr-1';
export const MESSAGE_BODY_SHELL_CLASS = `${MESSAGE_BODY_MAX_WIDTH_CLASS} ${MESSAGE_BODY_OFFSET_CLASS}`;
export const MESSAGE_ROW_SHELL_CLASS = 'mx-auto w-full max-w-[calc(42rem+3.25rem)]';
