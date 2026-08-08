import { dirname } from "path";
import { fileURLToPath } from "url";
import nextConfig from "eslint-config-next";
import reactPlugin from "eslint-plugin-react";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    ignores: [
      ".electron-runtime/**",
      ".next/**",
      "dist-electron/**",
      "dist-server/**",
      "release/**",
    ],
  },
  ...nextConfig,
  {
    plugins: {
      react: reactPlugin,
    },
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
  {
    // The CLI may run on a different filesystem than this server (the bridged
    // Windows-server/WSL-agent setup the packaged app ships). There, the
    // server's own home and environment describe the WRONG side, so anything
    // reaching for a CLI-owned file must resolve the agent's home instead.
    // This mistake is invisible in development — a plain `npm run dev` inside
    // WSL shares one filesystem, so the wrong code passes every local check and
    // breaks only in the installed app. It has shipped five times (d8dcdd9,
    // 67d74f4, d647b1f, 3e78e57, and the `/fork` job lookup). Hence a lint gate
    // rather than another line of guidance.
    files: ["src/**/*.ts", "src/**/*.tsx", "electron/**/*.ts"],
    ignores: [
      // The helpers themselves, and the probes that already branch on the
      // agent environment before touching either side.
      "src/lib/filesystem/path-environment.ts",
      "src/lib/skill/skill-loader.ts",
      "src/lib/rate-limit/fetcher.ts",
      "src/lib/cli/providers/claude-code/transcript-path.ts",
      "src/lib/cli/providers/claude-code/terminal-session-observer.ts",
      "src/lib/cli/providers/codex/transcript-path.ts",
      "src/lib/cli/providers/opencode/transcript-source.ts",
      "src/lib/memory/codex-memory.ts",
      // Take the home/env as injected options; their callers own the choice.
      "src/lib/codex-home.ts",
      "src/lib/cli/providers/opencode/native-transcript.ts",
      // Describe this server's own storage and processes, not the CLI's files.
      "src/lib/tessera-data-dir.ts",
      "src/lib/skill/skill-analysis-service.ts",
      "src/lib/terminal/windows-conpty-warmup.ts",
      "src/lib/projects/worktree-preparation.ts",
      // Build the environment a PTY is spawned with, where these vars are the
      // value being set rather than a location being read.
      "src/lib/terminal/terminal-resolver.ts",
      "src/lib/terminal/terminal-manager.ts",
      "src/lib/cli/spawn-cli-runtime.ts",
      "src/app/api/skills/route.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='homedir']",
          message:
            "os.homedir() is this server's home, which across a bridge is the wrong filesystem. Use resolveAgentHomeFilesystemPath(environment) from @/lib/filesystem/path-environment, and thread userId through to getAgentEnvironment(userId). See CLAUDE.md.",
        },
        {
          selector: "CallExpression[callee.property.name='homedir']",
          message:
            "os.homedir() is this server's home, which across a bridge is the wrong filesystem. Use resolveAgentHomeFilesystemPath(environment) from @/lib/filesystem/path-environment, and thread userId through to getAgentEnvironment(userId). See CLAUDE.md.",
        },
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/^(CLAUDE_CONFIG_DIR|CODEX_HOME|XDG_DATA_HOME)$/]",
          message:
            "This var describes this server's environment; across a bridge the CLI never saw it. Ignore it when isBridgedAgentEnvironment(environment) is true. See CLAUDE.md.",
        },
      ],
    },
  },
];

export default config;
