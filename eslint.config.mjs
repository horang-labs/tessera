import { dirname } from "path";
import { fileURLToPath } from "url";
import nextConfig from "eslint-config-next";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** @type {import('eslint').Linter.Config[]} */
const config = [
  ...nextConfig,
  {
    settings: {
      next: {
        rootDir: __dirname,
      },
    },
    rules: {
      // Warn instead of error for unescaped entities; easily fixable but not critical.
      "react/no-unescaped-entities": "warn",
    },
  },
];

export default config;
