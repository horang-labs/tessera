import type { SpawnOptions } from 'child_process';
import { normalizeCwdForCliEnvironment, spawnCli } from '@/lib/cli/spawn-cli';
import type { AgentEnvironment } from '@/lib/settings/types';

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[]) => Promise<GitRunResult>;

export function createGitRunner(agentEnvironment: AgentEnvironment): GitRunner {
  return (args) => runGitCommand(normalizeGitPathArgs(args, agentEnvironment), agentEnvironment);
}

function normalizeGitPathArgs(args: string[], agentEnvironment: AgentEnvironment): string[] {
  return args.map((arg) => (
    looksLikeFilesystemPath(arg)
      ? normalizeCwdForCliEnvironment(arg, agentEnvironment)
      : arg
  ));
}

function looksLikeFilesystemPath(value: string): boolean {
  return (
    value.startsWith('/')
    || value.startsWith('\\\\')
    || value.startsWith('//')
    || /^[a-zA-Z]:[\\/]/.test(value)
    || /^[a-zA-Z]:$/.test(value)
  );
}

function runGitCommand(args: string[], agentEnvironment: AgentEnvironment): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const options: SpawnOptions = {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    };
    const child = spawnCli('git', args, options, agentEnvironment);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr || `git exited with code ${code}`));
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}
