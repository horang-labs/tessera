import fs from 'node:fs';
import { getDb } from '../db/database';
import { getSession, extractSessionKind } from '../db/sessions';
import { getWorktree } from '../db/worktrees';
import { isGitCheckoutPath } from '../db/worktree-identity';
import { getProviderSessionOptions } from '../cli/provider-session-options';
import { SettingsManager } from '../settings/manager';
import { normalizeUserSettings } from '../settings/provider-defaults';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import { getTesseraDataPath, resolveConfiguredPath } from '../tessera-data-dir';
import { resolveServerDefaultUserId } from '../server-default-user';
import { isElectronRuntime } from '../electron-runtime';
import logger from '../logger';
import type { ProviderLaunchRequest } from '../terminal/provider-launch-module';
import { AutomationEngine } from './engine';
import { AutomationRepository } from './repository';
import { AutomationService, fail, type Inspection } from './service';
import { getAutomationRuntime, installAutomationAuthority } from './runtime-bridge';
import { sameSessionSelection, type SessionSelectionSnapshot, type Target } from './contracts';

const key = Symbol.for('tessera.automation.host.v1');
type Host = { service: AutomationService; engine: AutomationEngine; close(): Promise<void> };
const globals = globalThis as typeof globalThis & { [key]?: Host };

function currentOwner(): string | undefined {
  if (isElectronRuntime()) return 'electron-local-user';
  const filename = process.env.USERS_FILE_PATH ? resolveConfiguredPath(process.env.USERS_FILE_PATH) : getTesseraDataPath('users.json');
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')).users?.[0]?.id; }
  catch { return undefined; }
}
function currentEnvironment(userId: string): 'native' | 'wsl' {
  try {
    return normalizeUserSettings(JSON.parse(fs.readFileSync(getTesseraDataPath('settings', `${userId}.json`), 'utf8'))).agentEnvironment;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_SETTINGS.agentEnvironment;
    return fail('OWNER_UNAVAILABLE', 'Owner settings are unavailable.');
  }
}
function inspectTarget(target: Target): { selection: SessionSelectionSnapshot; canonicalWorktreeId: string | null } {
  if (target.kind === 'wake-session') {
    const row = getSession(target.sessionId);
    if (!row || row.deleted || row.archived || row.worktree_deleted_at || extractSessionKind(row.provider_state) !== 'terminal') fail('NOT_FOUND');
    if (row.task_id && !getDb().prepare('SELECT 1 FROM tasks WHERE id=? AND archived=0 AND worktree_deleted_at IS NULL').get(row.task_id)) fail('NOT_FOUND');
    if (!['claude-code', 'codex'].includes(row.provider)) fail('UNSUPPORTED_SELECTION');
    return { selection: { provider: row.provider as SessionSelectionSnapshot['provider'], model: row.model, reasoningEffort: row.reasoning_effort,
      serviceTier: row.service_tier as SessionSelectionSnapshot['serviceTier'], settings: { permissionPolicy: 'inherit-cli', allowPreparationFailure: false } }, canonicalWorktreeId: null };
  }
  const worktree = getWorktree(target.worktreeId);
  if (!worktree?.filesystemPath || !isGitCheckoutPath(worktree.filesystemPath)) fail('NOT_FOUND', 'A live Worktree is required.');
  if (!getDb().prepare(`SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id
    WHERE t.public_worktree_id=? AND t.archived=0 AND t.worktree_deleted_at IS NULL`).get(target.worktreeId)) fail('NOT_FOUND');
  return { selection: target.selection, canonicalWorktreeId: worktree.id };
}
export async function inspectAutomationTarget(userId: string, target: Target, environment: 'native' | 'wsl'): Promise<Inspection> {
  const inspected = inspectTarget(target);
  if (target.kind === 'create-session') {
    const options = await getProviderSessionOptions(target.selection.provider, userId, environment);
    const model = options.modelOptions.find(m => m.value === target.selection.model);
    if (!model || !model.supportedReasoningEfforts.some(e => e.value === target.selection.reasoningEffort) ||
      (target.selection.provider === 'codex' && !model.serviceTiers?.some(t => t.value === target.selection.serviceTier))) fail('UNSUPPORTED_SELECTION');
  }
  return { ...inspected, assertCurrent: () => {
    if (currentOwner() !== userId || currentEnvironment(userId) !== environment) fail('OWNER_UNAVAILABLE');
    const current = inspectTarget(target);
    if (!sameSessionSelection(current.selection, inspected.selection) || current.canonicalWorktreeId !== inspected.canonicalWorktreeId) fail('UNSUPPORTED_SELECTION');
  } };
}

export function getAutomationService(): AutomationService {
  return globals[key]?.service ?? fail('OWNER_UNAVAILABLE', 'Automation engine is unavailable.');
}
/** Called after DB/auth readiness and WS sender binding, with the shared manager already initialized. */
export async function startAutomationHost(): Promise<Host> {
  if (globals[key]) return globals[key];
  const { broadcastAutomationMutation } = await import('./broadcaster');
  const service = new AutomationService(new AutomationRepository(getDb()), {
    now: Date.now, runtime: getAutomationRuntime,
    owner: async () => {
      const userId = await resolveServerDefaultUserId();
      if (!userId || currentOwner() !== userId) fail('OWNER_UNAVAILABLE');
      const settings = await SettingsManager.load(userId, { silent: true, strict: true });
      return { userId, agentEnvironment: settings.agentEnvironment };
    },
    inspect: inspectAutomationTarget, publish: broadcastAutomationMutation,
  });
  const engine = new AutomationEngine(service);
  const release = installAutomationAuthority(engine);
  let closing = false;
  const runTick = () => { void engine.tick().catch(() => logger.error('Automation reconciliation failed')); };
  const interval = setInterval(() => {
    try { engine.heartbeat(); runTick(); } catch { logger.error('Automation lease renewal failed'); }
  }, 5000);
  interval.unref();
  const host: Host = { service, engine, close: async () => {
    if (closing) return; closing = true; clearInterval(interval);
    await engine.stop(); release(); if (globals[key] === host) delete globals[key];
  } };
  globals[key] = host;
  try { await engine.tick(); } catch (error) { await host.close(); throw error; }
  return host;
}

export async function stopAutomationHost(): Promise<void> { await globals[key]?.close(); }

/** A-owned gate works with both the existing and B's additive restore signatures. */
export function createAutomationRecoveryGate(
  launch: (request: ProviderLaunchRequest) => Promise<unknown>,
  repository = getAutomationService().repo,
): (request: ProviderLaunchRequest) => Promise<unknown> {
  return async request => {
    if (repository.recoverySessionIds().has(request.sessionId)) return;
    return launch(request);
  };
}
