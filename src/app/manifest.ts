import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Tessera',
    short_name: 'Tessera',
    description: 'Your private workspace for AI coding agents.',
    start_url: '/chat',
    scope: '/',
    display: 'standalone',
    background_color: '#0b1118',
    theme_color: '#0b1118',
    orientation: 'any',
    categories: ['developer', 'productivity'],
    icons: [
      {
        src: '/icons/tessera-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/tessera-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}
