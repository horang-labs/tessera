export interface AvatarPreset {
  id: string;
  dataUrl: string;
}

export const DEFAULT_PROFILE_DISPLAY_NAME = 'User';

function svgAvatarDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const PROFILE_AVATAR_PRESETS = [
  {
    id: 'ember',
    dataUrl: svgAvatarDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
        <defs><linearGradient id="g" x1="18" y1="16" x2="140" y2="146" gradientUnits="userSpaceOnUse"><stop stop-color="#F97316"/><stop offset="1" stop-color="#7C2D12"/></linearGradient></defs>
        <rect width="160" height="160" rx="34" fill="url(#g)"/><circle cx="116" cy="38" r="24" fill="#FED7AA" opacity=".28"/><circle cx="72" cy="72" r="36" fill="#FFF7ED" opacity=".92"/><path d="M31 132c7-26 25-42 49-42s43 16 49 42" fill="#431407" opacity=".42"/><path d="M49 59c10-19 45-23 63-3-8-5-20-7-35-6-13 1-23 4-28 9Z" fill="#431407" opacity=".32"/>
      </svg>
    `),
  },
  {
    id: 'marine',
    dataUrl: svgAvatarDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
        <defs><linearGradient id="g" x1="18" y1="142" x2="144" y2="18" gradientUnits="userSpaceOnUse"><stop stop-color="#0F766E"/><stop offset="1" stop-color="#38BDF8"/></linearGradient></defs>
        <rect width="160" height="160" rx="34" fill="url(#g)"/><path d="M20 111c31-23 67-25 120-8v57H20Z" fill="#082F49" opacity=".35"/><circle cx="79" cy="68" r="34" fill="#ECFEFF" opacity=".94"/><path d="M34 130c7-24 25-38 46-38s38 14 46 38" fill="#042F2E" opacity=".42"/><path d="M49 69c8-28 47-39 68-12-13-6-36-6-68 12Z" fill="#155E75" opacity=".35"/>
      </svg>
    `),
  },
  {
    id: 'violet',
    dataUrl: svgAvatarDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
        <defs><linearGradient id="g" x1="24" y1="18" x2="130" y2="144" gradientUnits="userSpaceOnUse"><stop stop-color="#A78BFA"/><stop offset="1" stop-color="#4C1D95"/></linearGradient></defs>
        <rect width="160" height="160" rx="34" fill="url(#g)"/><rect x="25" y="24" width="110" height="110" rx="28" fill="#F5F3FF" opacity=".16"/><circle cx="80" cy="68" r="33" fill="#FAF5FF" opacity=".94"/><path d="M32 130c8-25 26-39 48-39s40 14 48 39" fill="#2E1065" opacity=".45"/><path d="M53 49c17-15 39-15 55 0 1 19-8 29-28 29S52 68 53 49Z" fill="#2E1065" opacity=".26"/>
      </svg>
    `),
  },
  {
    id: 'slate',
    dataUrl: svgAvatarDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
        <defs><linearGradient id="g" x1="18" y1="18" x2="142" y2="142" gradientUnits="userSpaceOnUse"><stop stop-color="#64748B"/><stop offset="1" stop-color="#111827"/></linearGradient></defs>
        <rect width="160" height="160" rx="34" fill="url(#g)"/><path d="M26 42h108v84H26z" fill="#F8FAFC" opacity=".08"/><circle cx="80" cy="68" r="34" fill="#F8FAFC" opacity=".92"/><path d="M35 132c8-26 25-41 45-41s37 15 45 41" fill="#020617" opacity=".48"/><path d="M51 60c13-17 45-20 59 1-13-6-34-7-59-1Z" fill="#020617" opacity=".25"/>
      </svg>
    `),
  },
  {
    id: 'rose',
    dataUrl: svgAvatarDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
        <defs><linearGradient id="g" x1="24" y1="140" x2="140" y2="22" gradientUnits="userSpaceOnUse"><stop stop-color="#BE123C"/><stop offset="1" stop-color="#F9A8D4"/></linearGradient></defs>
        <rect width="160" height="160" rx="34" fill="url(#g)"/><circle cx="41" cy="42" r="20" fill="#FFE4E6" opacity=".25"/><circle cx="80" cy="70" r="34" fill="#FFF1F2" opacity=".94"/><path d="M33 132c9-27 26-42 47-42s38 15 47 42" fill="#4C0519" opacity=".44"/><path d="M52 57c14-21 42-20 58 1-11 6-22 9-34 8-10 0-18-3-24-9Z" fill="#4C0519" opacity=".25"/>
      </svg>
    `),
  },
] as const satisfies readonly AvatarPreset[];

export const DEFAULT_PROFILE_AVATAR_DATA_URL = PROFILE_AVATAR_PRESETS[0]?.dataUrl ?? '';
