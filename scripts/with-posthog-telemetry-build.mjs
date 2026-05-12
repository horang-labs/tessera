#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';

const ENV_FILES = ['.env', '.env.local', '.env.production.local'];
const DEFAULT_POSTHOG_HOST = 'https://us.posthog.com';

function loadEnvFiles() {
  for (const filePath of ENV_FILES) {
    if (!fs.existsSync(filePath)) continue;

    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) continue;

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = stripEnvQuotes(trimmed.slice(separatorIndex + 1).trim());
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

function stripEnvQuotes(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return value.slice(1, -1);
  }
  return value;
}

async function resolvePostHogProjectToken() {
  if (process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) {
    return {
      token: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
      source: 'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN',
    };
  }

  const personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  if (!personalApiKey || !projectId) {
    throw new Error(
      'Telemetry build requires NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN, or POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID.',
    );
  }

  const host = (process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_UI_HOST || DEFAULT_POSTHOG_HOST)
    .replace(/\/$/, '');
  const response = await fetch(`${host}/api/projects/${projectId}/`, {
    headers: { Authorization: `Bearer ${personalApiKey}` },
  });

  if (!response.ok) {
    throw new Error(`Could not resolve PostHog project token (${response.status}).`);
  }

  const project = await response.json();
  if (typeof project.api_token !== 'string' || !project.api_token) {
    throw new Error('PostHog project response did not include api_token.');
  }

  return {
    token: project.api_token,
    source: 'PostHog project api_token',
  };
}

function runCommand(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.on('close', (code, signal) => {
      if (signal) {
        resolve(128);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main() {
  loadEnvFiles();

  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    throw new Error('Usage: node scripts/with-posthog-telemetry-build.mjs <command> [...args]');
  }

  const { token, source } = await resolvePostHogProjectToken();
  const env = {
    ...process.env,
    NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token,
    TESSERA_TELEMETRY_LOCAL: '1',
  };

  console.log(`[telemetry-build] enabled using ${source} (token length=${token.length})`);
  const exitCode = await runCommand(command, args, env);
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(`[telemetry-build] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
