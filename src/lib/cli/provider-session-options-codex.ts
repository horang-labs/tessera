import {
  buildCodexPermissionMappings,
  CODEX_ACCESS_OPTIONS,
  SHARED_MODE_OPTIONS,
} from './provider-session-option-definitions';
import { resolveProviderCliCommand } from './provider-command';
import { getAgentEnvironment, spawnCli } from './spawn-cli';
import type { AgentEnvironment } from '../settings/types';
import type {
  CodexModelEntry,
  CodexModelResponse,
  ProviderModelOption,
  ProviderReasoningEffortOption,
  ProviderServiceTierOption,
  ProviderSessionOptions,
} from './provider-session-option-types';

type CodexReasoningEffortEntry = CodexModelEntry['supportedReasoningEfforts'];
type CodexServiceTierEntry = CodexModelEntry['serviceTiers'];

export async function loadCodexSessionOptions(
  userId?: string,
  agentEnvironment?: AgentEnvironment,
): Promise<ProviderSessionOptions> {
  const result = await probeCodexModels(userId, agentEnvironment);

  return {
    providerId: 'codex',
    displayName: 'Codex',
    supportsReasoningEffort: true,
    runtimeEffortChange: true,
    runtimeAccessChange: true,
    modelOptions: buildCodexModelOptions(result),
    permissionMappings: buildCodexPermissionMappings(),
    permissionModeNote:
      'Codex maps the shared permission modes onto approvalPolicy + sandbox, so behavior is the closest available match rather than a strict 1:1 translation.',
    modeOptions: [...SHARED_MODE_OPTIONS],
    accessOptions: [...CODEX_ACCESS_OPTIONS],
    planLocksAccess: false,
  };
}

export function buildCodexModelOptions(result: CodexModelResponse): ProviderModelOption[] {
  const modelOptions: ProviderModelOption[] = [];

  for (const model of listCodexModelEntries(result)) {
    const value = String(model.id ?? model.model ?? '').trim();
    if (!value) {
      continue;
    }

    const reasoningEfforts = buildCodexReasoningEfforts(model.supportedReasoningEfforts);
    const serviceTiers = buildCodexServiceTiers(model.serviceTiers);
    modelOptions.push({
      value,
      label: String(model.displayName ?? value),
      description: String(model.description ?? '').trim() || undefined,
      isDefault: Boolean(model.isDefault),
      defaultReasoningEffort: model.defaultReasoningEffort ?? reasoningEfforts[0]?.value ?? null,
      supportedReasoningEfforts: reasoningEfforts,
      ...(serviceTiers.length > 0 && { serviceTiers }),
    });
  }

  return modelOptions;
}

function listCodexModelEntries(result: CodexModelResponse | undefined): CodexModelEntry[] {
  return result?.data ?? result?.models ?? [];
}

function buildCodexReasoningEfforts(
  efforts: CodexReasoningEffortEntry,
): ProviderReasoningEffortOption[] {
  const reasoningEfforts: ProviderReasoningEffortOption[] = [];

  for (const effort of efforts ?? []) {
    const value = String(effort.reasoningEffort ?? '').trim();
    if (!value) {
      continue;
    }

    reasoningEfforts.push({
      value,
      label: value,
      description: String(effort.description ?? '').trim(),
    });
  }

  return reasoningEfforts;
}

function buildCodexServiceTiers(
  tiers: CodexServiceTierEntry,
): ProviderServiceTierOption[] {
  const serviceTiers: ProviderServiceTierOption[] = [];

  for (const tier of tiers ?? []) {
    const value = String(tier.id ?? '').trim();
    if (!value) {
      continue;
    }

    serviceTiers.push({
      value,
      label: String(tier.name ?? value),
      description: String(tier.description ?? '').trim(),
    });
  }

  return serviceTiers;
}

async function probeCodexModels(
  userId?: string,
  agentEnvironment?: AgentEnvironment,
): Promise<CodexModelResponse> {
  const resolvedAgentEnvironment = agentEnvironment ?? await getAgentEnvironment(userId);
  const command = await resolveProviderCliCommand('codex', 'codex', resolvedAgentEnvironment, userId);

  return new Promise((resolve, reject) => {
    const proc = spawnCli(command, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env as NodeJS.ProcessEnv,
    }, resolvedAgentEnvironment);

    let buffer = '';
    let settled = false;
    let initializeModels: CodexModelResponse | null = null;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      proc.kill('SIGTERM');
      reject(new Error('Timed out while probing Codex models'));
    }, 10_000);

    const cleanup = () => {
      clearTimeout(timeout);
      proc.stdout?.removeListener('data', onStdout);
      proc.stderr?.removeListener('data', onStderr);
      proc.removeListener('error', onError);
      proc.removeListener('close', onClose);
    };

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };

    const send = (message: Record<string, unknown>) => {
      proc.stdin?.write(`${JSON.stringify(message)}\n`);
    };

    const onStdout = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let parsed: { id?: number; result?: CodexModelResponse; error?: { message?: string } };
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (parsed.id === 1) {
          if (listCodexModelEntries(parsed.result).length > 0) {
            initializeModels = parsed.result ?? null;
          }

          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'model/list',
            params: {
              limit: 50,
              includeHidden: false,
            },
          });
          continue;
        }

        if (parsed.id === 2) {
          finish(() => {
            proc.kill('SIGTERM');
            if (parsed.error) {
              if (initializeModels) {
                resolve(initializeModels);
                return;
              }

              reject(new Error(parsed.error.message || 'Codex model/list failed'));
              return;
            }

            const modelListResult = parsed.result ?? {};
            resolve(listCodexModelEntries(modelListResult).length > 0 || !initializeModels
              ? modelListResult
              : initializeModels);
          });
          return;
        }
      }
    };

    const onStderr = () => {
      // Codex occasionally emits non-fatal logs on stderr during startup.
    };

    const onError = (error: Error) => {
      finish(() => reject(error));
    };

    const onClose = (code: number | null) => {
      if (settled) {
        return;
      }

      finish(() => reject(new Error(`Codex app-server exited before model/list completed (code ${code})`)));
    };

    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    proc.once('error', onError);
    proc.once('close', onClose);

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-01-01',
        clientInfo: { name: 'tessera', version: '1.0.0' },
      },
    });
  });
}
