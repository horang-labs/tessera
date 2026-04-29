/** @type {import('next').NextConfig} */
const nextConfig = {
  reactCompiler: true,
  images: {
    unoptimized: true,
  },
  serverExternalPackages: ['pino', 'pino-pretty', 'sql.js', 'electron'],
};

export default nextConfig;
