/**
 * Claude Code CLI Adapter
 *
 * Implements the CliProvider interface for the Claude Code CLI.
 * Encapsulates all Claude Code-specific logic:
 *  - CLI argument construction
 *  - Process spawning with environment sanitization
 *  - stdin message protocol (stream-json format)
 *  - stdout parsing via ClaudeCodeProtocolParser
 *  - AI title generation via Claude CLI -p flag
 */

import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';
import type {
  CliProvider,
  CheckStatusOptions,
  CliStatusResult,
  SpawnOptions,
  SpawnResult,
  ParsedMessage,
  GeneratedTitle,
} from '../types';
import type { ContentBlock } from '@/lib/ws/message-types';
import { claudeCodeProtocolParser } from './protocol-parser';
import { isBinaryAvailable } from '../registry';
import { getAgentEnvironment, spawnCli } from '../../spawn-cli';
import { execCli, parseVersion, probeBinaryAvailable } from '../../cli-exec';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import logger from '@/lib/logger';

const CLI_TIMEOUT_MS = 120_000;
const STATUS_CHECK_TIMEOUT_MS = 5_000;

// =============================================================================
// ClaudeCodeAdapter
// =============================================================================

export class ClaudeCodeAdapter implements CliProvider {
  /**
   * Returns the unique machine-readable identifier for this provider.
   */
  getProviderId(): string {
    return 'claude-code';
  }

  /**
   * Returns the human-readable display name for this provider.
   */
  getDisplayName(): string {
    return 'Claude Code';
  }

  /**
   * Checks whether the Claude Code CLI binary is available.
   * When an environment is provided, probes that environment (native vs. WSL);
   * otherwise falls back to a same-host `which` check.
   */
  async isAvailable(environment?: 'native' | 'wsl'): Promise<boolean> {
    if (environment) {
      return probeBinaryAvailable('claude', environment);
    }
    return isBinaryAvailable('claude');
  }

  /**
   * Checks whether Claude Code is installed and the user is logged in.
   * Runs version/auth probes in parallel so slow Windows-native CLI startup
   * does not make provider pickers wait for both commands serially.
   */
  async checkStatus(options: CheckStatusOptions): Promise<CliStatusResult> {
    const [versionResult, authResult] = await Promise.all([
      execCli(
        'claude',
        ['--version'],
        options.environment,
        STATUS_CHECK_TIMEOUT_MS,
      ),
      execCli(
        'claude',
        ['auth', 'status'],
        options.environment,
        STATUS_CHECK_TIMEOUT_MS,
      ),
    ]);

    if (!versionResult.ok) {
      return { status: 'not_installed' };
    }

    const version = parseVersion(versionResult.stdout);

    return {
      status: authResult.ok ? 'connected' : 'needs_login',
      ...(version ? { version } : {}),
    };
  }

  /**
   * Returns the CLI arguments for spawning Claude Code.
   * Handles new session vs. resume session based on options.sessionId.
   *
   * For new sessions: --print --verbose --output-format stream-json
   *   --input-format stream-json --include-partial-messages
   *   --permission-prompt-tool stdio --session-id <id>
   *   [--permission-mode <mode>] [--model <model>]
   *
   * For resume sessions: --resume <id> + all of the above except --session-id
   */
  getCliArgs(options: SpawnOptions): string[] {
    const { sessionId, resume, permissionMode, model, reasoningEffort } = options;

    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--allow-dangerously-skip-permissions',
      '--append-system-prompt', '',
    ];

    if (sessionId && resume) {
      args.push('--resume', sessionId);
    } else if (sessionId) {
      args.push('--session-id', sessionId);
    }

    if (permissionMode && permissionMode !== 'default') {
      args.push('--permission-mode', permissionMode);
    }

    if (model) {
      args.push('--model', model);
    }

    // 'auto' or null → don't pass --effort, let CLI use its own default
    if (reasoningEffort && reasoningEffort !== 'auto') {
      args.push('--effort', reasoningEffort);
    }

    return args;
  }

  /**
   * Spawns the Claude Code CLI process.
   * Sanitizes environment variables (removes CLAUDECODE, NODE_ENV) and
   * sets MAX_THINKING_TOKENS=16000 if not already set.
   */
  async spawn(workDir: string, options: SpawnOptions): Promise<SpawnResult> {
    const args = this.getCliArgs(options);
    logger.info({ args, reasoningEffort: options.reasoningEffort }, 'Claude CLI spawn args');

    const spawnEnv: Record<string, string | undefined> = { ...process.env };
    delete spawnEnv.CLAUDECODE;
    delete spawnEnv.NODE_ENV;
    // Do NOT set MAX_THINKING_TOKENS — it forces legacy budget_tokens mode
    // and disables adaptive thinking, which breaks --effort on Opus/Sonnet 4.6.
    delete spawnEnv.MAX_THINKING_TOKENS;
    const agentEnv = await getAgentEnvironment(options.userId);

    const cliProcess = spawnCli('claude', args, {
      cwd: workDir,
      shell: false,
      env: spawnEnv as NodeJS.ProcessEnv,
      detached: getRuntimePlatform() !== 'win32',
    }, agentEnv);

    const spawnResult = await new Promise<{ ok: boolean; error?: Error }>((resolve) => {
      const onError = (err: Error) => {
        cliProcess.removeListener('spawn', onSpawn);
        resolve({ ok: false, error: err });
      };
      const onSpawn = () => {
        cliProcess.removeListener('error', onError);
        resolve({ ok: true });
      };
      cliProcess.once('error', onError);
      cliProcess.once('spawn', onSpawn);
    });

    return { process: cliProcess, ...spawnResult };
  }

  /**
   * Writes a user message to the CLI process stdin in stream-json format.
   * Format: JSON.stringify({type:'user', message:{role:'user', content}}) + '\n'
   */
  sendMessage(proc: ChildProcess, content: string | ContentBlock[]): boolean {
    const jsonMessage = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    });
    return proc.stdin?.write(jsonMessage + '\n') ?? false;
  }

  /**
   * Sends the legacy initialize control_request once the process is attached to
   * ProcessManager. This keeps Claude-specific startup protocol inside the
   * provider instead of requiring a provider-ID branch in ProcessManager.
   */
  onSessionReady(proc: ChildProcess, sessionId: string): boolean {
    const initializeRequest = {
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'initialize' },
    };

    const ok = proc.stdin?.write(JSON.stringify(initializeRequest) + '\n') ?? false;
    logger.debug('ClaudeCodeAdapter: sent initialize request', { sessionId, ok });
    return ok;
  }

  /**
   * Parses a single stdout line from the Claude Code CLI.
   * Delegates to ClaudeCodeProtocolParser and returns the first ParsedMessage
   * produced by the line, or null if the line is suppressed.
   */
  parseStdout(line: string): ParsedMessage | null {
    const messages = this.parseSessionStdout('__provider__', line);
    return messages.length > 0 ? messages[0] : null;
  }

  /**
   * Parses a stdout line using the real Tessera session ID so Claude parser state
   * stays inside the provider boundary instead of the legacy protocol adapter.
   */
  parseSessionStdout(sessionId: string, line: string): ParsedMessage[] {
    return claudeCodeProtocolParser.parseStdout(sessionId, line);
  }

  /**
   * Clears Claude parser state when the process exits and returns any exit
   * notifications for ProcessManager to dispatch.
   */
  handleSessionExit(sessionId: string, exitCode: number): ParsedMessage[] {
    return claudeCodeProtocolParser.handleProcessExit(sessionId, exitCode);
  }

  /**
   * Generates a semantic title for a session using the Claude CLI with -p flag.
   * Builds a prompt from the initial user message and parses the JSON response.
   *
   * Returns null if title generation fails or is unsupported.
   */
  async generateTitle(prompt: string, userId?: string): Promise<GeneratedTitle | null> {
    try {
      return await this._callCli(prompt, userId);
    } catch (err) {
      logger.warn('ClaudeCodeAdapter: generateTitle failed', {
        error: (err as Error).message,
      });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: CLI invocation for title generation
  // ---------------------------------------------------------------------------

  /**
   * Calls claude CLI with -p flag to generate a title from a conversation prompt.
   * Extracted from ai-title-generator.ts callCli function.
   */
  private async _callCli(prompt: string, userId?: string): Promise<GeneratedTitle> {
    const agentEnv = await getAgentEnvironment(userId);

    return new Promise((resolve, reject) => {
      // Remove Claude-related env vars to avoid "nested session" detection
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) =>
          k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')
        )
      ) as NodeJS.ProcessEnv;

      const child = spawnCli('claude', [
        '-p',
        '--output-format', 'json',
        '--no-session-persistence',
        '--effort', 'low',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: getRuntimePlatform() === 'win32' ? process.env.TEMP || process.cwd() : '/tmp',
        env: cleanEnv,
      }, agentEnv);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(
            `Claude CLI timed out after ${CLI_TIMEOUT_MS / 1000}s | ` +
            `stderr: ${stderr.slice(0, 200)} | stdout: ${stdout.slice(0, 200)}`
          ));
        }
      }, CLI_TIMEOUT_MS);

      child.stdout?.on('data', (data) => { stdout += data.toString(); });
      child.stderr?.on('data', (data) => { stderr += data.toString(); });

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
        }
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        if (code !== 0) {
          reject(new Error(`claude CLI exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          // CLI --output-format json wraps response in {"result": "..."}
          const cliOutput = JSON.parse(stdout);
          const resultText = cliOutput.result || cliOutput.text || stdout;
          const text = typeof resultText === 'string' ? resultText : JSON.stringify(resultText);

          // Extract {"title":"..."} from anywhere in the text
          const jsonMatch = text.match(/"title"\s*:\s*"([^"]+)"/);
          if (jsonMatch) {
            const [, title] = jsonMatch;
            resolve({ title: title.slice(0, 100) });
            return;
          }

          // Fallback: try parsing resultText directly as JSON
          try {
            const direct = JSON.parse(text);
            if (typeof direct.title === 'string') {
              resolve({ title: direct.title.slice(0, 100) });
              return;
            }
          } catch { /* not pure JSON, already tried regex */ }

          reject(new Error(`Invalid CLI response format: ${text.slice(0, 300)}`));
        } catch (err: any) {
          reject(new Error(`Failed to parse CLI response: ${err.message}`));
        }
      });

      child.stdin?.write(prompt);
      child.stdin?.end();
    });
  }
}

// =============================================================================
// Singleton
// =============================================================================

export const claudeCodeAdapter = new ClaudeCodeAdapter();
