import path from 'path';

/** @type {import('next').NextConfig} */
const localTelemetryEnabled = process.env.TESSERA_TELEMETRY_LOCAL === '1';
const shouldEmbedPosthogToken =
  process.env.NODE_ENV !== 'development' || localTelemetryEnabled;
const posthogProjectToken = shouldEmbedPosthogToken
  ? process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN || ''
  : '';
const posthogApiHost = process.env.NEXT_PUBLIC_POSTHOG_API_HOST || '/ingest';
const posthogUiHost = process.env.NEXT_PUBLIC_POSTHOG_UI_HOST || 'https://us.posthog.com';
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
const posthogAssetsHost = process.env.NEXT_PUBLIC_POSTHOG_ASSETS_HOST || 'https://us-assets.i.posthog.com';

// Set to 'debug' by the `electron:build:*:debug` scripts. Keeps the store invariant checks and
// WebSocket traces (see src/lib/debug-diagnostics.ts) in the bundle, which a release drops.
const tesseraLogLevel = process.env.NEXT_PUBLIC_TESSERA_LOG_LEVEL || '';

const nextConfig = {
  reactCompiler: true,
  allowedDevOrigins: ['**.*'],
  images: {
    unoptimized: true,
  },
  serverExternalPackages: ['pino', 'pino-pretty', 'sql.js', 'electron'],
  env: {
    NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: posthogProjectToken,
    NEXT_PUBLIC_POSTHOG_API_HOST: posthogApiHost,
    NEXT_PUBLIC_POSTHOG_UI_HOST: posthogUiHost,
    NEXT_PUBLIC_TESSERA_LOG_LEVEL: tesseraLogLevel,
  },
  webpack(config) {
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      '@': path.resolve(process.cwd(), 'src'),
    };
    // Next derives its webpack cache version from next.config keys and its own version only —
    // environment variables are not part of it. Without this, switching between a release and a
    // debug build replays cached modules that still carry the previous build's inlined value:
    // the debug build silently loses its traces, or worse, a release keeps them.
    if (config.cache && typeof config.cache === 'object' && 'version' in config.cache) {
      config.cache.version = `${config.cache.version}|tesseraLogLevel=${tesseraLogLevel}`;
    }
    return config;
  },
  async rewrites() {
    return [
      {
        source: '/ingest/static/:path*',
        destination: `${posthogAssetsHost}/static/:path*`,
      },
      {
        source: '/ingest/array/:path*',
        destination: `${posthogAssetsHost}/array/:path*`,
      },
      {
        source: '/ingest/:path*',
        destination: `${posthogHost}/:path*`,
      },
    ];
  },
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
