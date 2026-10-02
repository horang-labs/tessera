import fs from 'node:fs/promises';
import path from 'node:path';
import { SettingsManager } from '@/lib/settings/manager';
import { resolveAgentHomeFilesystemPath, formatPathForAgentDisplay } from '@/lib/filesystem/path-environment';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import { resolveProviderCliCommand } from '../provider-command';
import { loadClaudeSessionOptions } from '../provider-session-options-claude';
import { isRunningInWsl, execCli } from '../cli-exec';
import { AUTORUN_BOUNDS, PROVEN_SUPERVISOR_COMBINATIONS, SUPERVISOR_PROOF_POLICY, sameSupervisorSelection, supervisorPacketSchema,
  type SupervisorCapabilityResult, type SupervisorResult } from '@/lib/automation/autorun-contracts';
import type { SupervisorCapabilityRequest, SupervisorDecisionRequest } from './session-types';
import { parseSupervisorResult, supervisorFailure } from '@/lib/automation/supervisor';
import { AUTORUN_GROUP_WRAPPER, runOwnedSupervisor, SupervisorProcessUncertain } from './autorun-process';
import controls from './codex/autorun-controls.json';
import catalog from './codex/autorun-catalog.json';
import { registerSupervisorInvocation, closeSupervisorInvocation, defaultSettlementDependencies, type SupervisorRecovery } from './autorun-settlement';

const CONFIG_READER = String.raw`
const cp=require('node:child_process');const child=cp.spawn(process.argv[2],[...process.argv.slice(3),'app-server'],{stdio:'pipe'});
let buffer='',found=false;child.stderr.pipe(process.stderr);
child.stdout.on('data',b=>{buffer+=b;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{
 const r=JSON.parse(line);if(r.id===0){child.stdin.write(JSON.stringify({method:'initialized'})+'\n');child.stdin.write(JSON.stringify({id:1,method:'config/read',params:{includeLayers:true}})+'\n')}
 if(r.id===1){if(r.error)process.exitCode=1;else{process.stdout.write(JSON.stringify(r.result)+'\n');found=true}child.stdin.end()}
}catch{process.exitCode=1}}});
child.on('close',code=>{if(code!==0||!found)process.exitCode=1});
child.stdin.write(JSON.stringify({id:0,method:'initialize',params:{clientInfo:{name:'tessera-supervisor-capability',version:'1'}}})+'\n');
`;
const MODEL_READER = String.raw`
const cp=require('node:child_process');const child=cp.spawn(process.argv[2],['debug','models'],{stdio:['ignore','pipe','pipe']});
let bytes=0,output=[];child.stderr.pipe(process.stderr);
child.stdout.on('data',b=>{bytes+=b.length;if(bytes>2097152){child.kill('SIGTERM');process.exitCode=1}else output.push(b)});
child.on('error',()=>{process.exitCode=1});child.on('close',code=>{try{
 if(code!==0||process.exitCode)throw Error('native catalog unavailable');
 const models=JSON.parse(Buffer.concat(output).toString('utf8')).models.filter(m=>m.slug===process.argv[3]);
 if(models.length!==1)throw Error('model unavailable');process.stdout.write(JSON.stringify({models})+'\n');
}catch{process.exitCode=1}});
`;
export type SupervisorWorkspace = { root: string; guestRoot: string; command: string; environment: Record<string, string>; recovery?: SupervisorRecovery; cleanup(): Promise<void> };
export type SupervisorDependencies = {
  prepare(request: SupervisorCapabilityRequest): Promise<SupervisorWorkspace>;
  probe(request: SupervisorCapabilityRequest, workspace: SupervisorWorkspace, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  claudeModelAvailable(request: SupervisorCapabilityRequest): Promise<boolean>;
};
function nestedField(value: unknown, key: string): unknown {
  for (const part of key.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
  return value;
}
const clean = (r: { ok: boolean; stdout: string; stderr: string }) => r.ok && !r.stderr.trim();
const unsupported = (reason: Extract<SupervisorCapabilityResult, { kind: 'unavailable' }>['reason']): SupervisorCapabilityResult => ({ kind: 'unavailable', code: 'SUPERVISOR_UNSUPPORTED', reason });
// A capability endpoint has no uncertainty DTO. Keep its owned receipt and refuse further analysis
// for this owner/environment until that exact tree proves settlement. R2 persists decision holds.
const uncertainWorkspaces = new Map<string, Set<string>>();
const ownerKey = (request: SupervisorCapabilityRequest) => JSON.stringify([request.userId, request.agentEnvironment]);
async function requireSettled(request: SupervisorCapabilityRequest) {
  const roots = uncertainWorkspaces.get(ownerKey(request));
  if (!roots) return;
  for (const root of roots) {
    try {
      const receipt = JSON.parse(await fs.readFile(root + '/settled.json', 'utf8'));
      if (receipt.quiescent === true && receipt.containment?.kind === 'linux-subreaper-v1' && receipt.containment?.terminal === 'ECHILD') {
        roots.delete(root); await fs.rm(root, { recursive: true, force: true });
      }
    }
    catch { /* Retain the uncertainty hold and its ownership evidence. */ }
  }
  if (roots.size) throw new SupervisorProcessUncertain();
  uncertainWorkspaces.delete(ownerKey(request));
}
async function retainUncertain(request: SupervisorCapabilityRequest, workspace: SupervisorWorkspace) {
  if (workspace.recovery) { workspace.cleanup = async () => {}; return; }
  const key = ownerKey(request), roots = uncertainWorkspaces.get(key) ?? new Set<string>();
  roots.add(workspace.root); uncertainWorkspaces.set(key, roots); workspace.cleanup = async () => {};
  // Recover capability-only uncertainty after a backend restart, without stopping any other process.
  await fs.writeFile(workspace.root + '/uncertain.json', JSON.stringify({ ownerKey: key }), { mode: 0o600 }).catch(() => {});
}
async function recoverUncertain(request: SupervisorCapabilityRequest, home: string) {
  for (const name of (await fs.readdir(home)).filter(n => n.startsWith('.tessera-supervisor-'))) {
    const root = path.join(home, name);
    try {
      const receipt = JSON.parse(await fs.readFile(root + '/uncertain.json', 'utf8'));
      if (receipt.ownerKey === ownerKey(request)) {
        const roots = uncertainWorkspaces.get(receipt.ownerKey) ?? new Set<string>();
        roots.add(root); uncertainWorkspaces.set(receipt.ownerKey, roots);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await requireSettled(request);
}
export function codexSupervisorControls(guestRoot: string): string[] {
  return controls.map(s => s.replace('<scratch>', guestRoot));
}
export function supervisorArgs(request: SupervisorDecisionRequest, workspace: SupervisorWorkspace): string[] {
  const s = request.selection;
  if (s.provider === 'claude-code') return ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', s.model,
    '--effort', s.reasoningEffort, '--safe-mode', '--restricted', '--tools', '', '--disable-slash-commands', '--permission-prompts', 'none',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true,"enabledPlugins":{}}', '--json-schema', JSON.stringify(request.outputSchema)];
  return ['exec', '--json', '--strict-config', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-m', s.model, '--output-schema', workspace.guestRoot + '/schema.json', ...codexSupervisorControls(workspace.guestRoot), '-'];
}
export const defaultSupervisorDependencies: SupervisorDependencies = {
  async prepare(request) {
    await requireSettled(request);
    const settings = await SettingsManager.load(request.userId, { silent: true });
    if (!request.userId || settings.agentEnvironment !== request.agentEnvironment) throw new Error('environment mismatch');
    // The guest subreaper/pidfd proof requires Linux; unsupported native topologies fail closed.
    if (request.agentEnvironment === 'native' && (getRuntimePlatform() !== 'linux' || isRunningInWsl())) throw new Error('unproven process ownership');
    const policy = await execCli('node', ['-e', "const fs=require('fs');process.stdout.write(JSON.stringify(['/etc/claude-code/managed-settings.json','/etc/claude-code/managed-mcp.json','/etc/claude-code/managed-settings.d','/etc/codex/config.toml','/etc/codex/requirements.toml'].some(p=>fs.existsSync(p))))"], request.agentEnvironment, 5000);
    if (!policy.ok || policy.stdout.trim() !== 'false') throw new Error('unreviewed managed policy');
    const home = await resolveAgentHomeFilesystemPath(request.agentEnvironment);
    await recoverUncertain(request, home);
    const root = await fs.mkdtemp(path.join(home, '.tessera-supervisor-'));
    const guestRoot = formatPathForAgentDisplay(root, request.agentEnvironment);
    const command = await resolveProviderCliCommand(request.selection.provider, request.selection.provider === 'codex' ? 'codex' : 'claude', request.agentEnvironment, request.userId);
    try {
      const authDir = request.selection.provider === 'codex' ? '.codex' : '.claude';
      const authFile = request.selection.provider === 'codex' ? 'auth.json' : '.credentials.json';
      const target = await fs.realpath(path.join(home, authDir, authFile));
      await fs.mkdir(root + '/home', { mode: 0o700 }); await fs.mkdir(root + '/empty', { mode: 0o700 });
      // Link on the CLI side: Windows cannot create a Linux symlink in an overlay through UNC.
      const link = await execCli('node', ['-e', "require('fs').symlinkSync(process.argv[1],process.argv[2])", formatPathForAgentDisplay(target, request.agentEnvironment), guestRoot + '/home/' + authFile], request.agentEnvironment, 5000);
      if (!link.ok) throw new Error('auth bridge unavailable');
      await fs.writeFile(root + '/group.cjs', AUTORUN_GROUP_WRAPPER, { mode: 0o600 });
      await fs.writeFile(root + '/supervisor-catalog.json', JSON.stringify(catalog), { mode: 0o600 });
      const environment = { [request.selection.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: guestRoot + '/home' };
      const decision = request as Partial<SupervisorDecisionRequest>;
      let recovery: SupervisorRecovery | undefined;
      if (decision.invocationId && decision.deadlineAt) {
        const identity = { version: 1 as const, userId: request.userId, agentEnvironment: request.agentEnvironment, invocationId: decision.invocationId };
        recovery = await registerSupervisorInvocation({ ...identity, provider: request.selection.provider, deadlineAt: decision.deadlineAt },
          await defaultSettlementDependencies.resolveGuestHome(identity));
      }
      return { root, guestRoot, command, environment, recovery, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
    } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
  },
  async probe(request, workspace, args) {
    let command = workspace.command;
    if (args.length === 2 && args[0] === 'debug' && args[1] === 'models') {
      await fs.writeFile(workspace.root + '/models.cjs', MODEL_READER, { mode: 0o600 });
      args = [workspace.guestRoot + '/models.cjs', workspace.command, request.selection.model]; command = 'node';
    } else if (args[0] === '--tessera-config-attestation') {
      await fs.writeFile(workspace.root + '/config.cjs', CONFIG_READER, { mode: 0o600 });
      args = [workspace.guestRoot + '/config.cjs', workspace.command, ...args.slice(1)];
      command = 'node';
    }
    await fs.rm(workspace.root + '/settled.json', { force: true });
    const deadlineAt = Math.min((request as Partial<SupervisorDecisionRequest>).deadlineAt ?? Infinity, Date.now() + 10_000);
    await fs.writeFile(workspace.root + '/launch.json', JSON.stringify({ command, args, environment: workspace.environment, deadlineAt }), { mode: 0o600 });
    const result = await runOwnedSupervisor({ ...request, root: workspace.root, guestRoot: workspace.guestRoot, recovery: workspace.recovery,
      signal: (request as Partial<SupervisorDecisionRequest>).signal ?? new AbortController().signal, deadlineAt, stdin: '' });
    if (!result.quiescent) { await retainUncertain(request, workspace); throw new SupervisorProcessUncertain(); }
    return { ok: result.exitCode === 0 && result.quiescent && !result.timedOut && !result.overflow, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
  },
  async claudeModelAvailable(request) {
    const options = await loadClaudeSessionOptions(request.agentEnvironment);
    return options.modelOptions.some(m => m.value === request.selection.model && m.supportedReasoningEfforts?.some(e => e.value === request.selection.reasoningEffort));
  },
};

async function attest(request: SupervisorCapabilityRequest, workspace: SupervisorWorkspace, deps: SupervisorDependencies): Promise<SupervisorCapabilityResult> {
  const proof = PROVEN_SUPERVISOR_COMBINATIONS.find(p => sameSupervisorSelection(p.selection, request.selection));
  if (!proof) return unsupported('selection');
  const version = await deps.probe(request, workspace, ['--version']);
  if (!version.ok || version.stdout.match(/\d+\.\d+\.\d+/)?.[0] !== proof.cliVersion) return unsupported('version');
  // Managed files are never overridden. Unknown policy files are unavailable, even if a model could refuse tools.
  const policy = await deps.probe(request, workspace, ['--help']);
  if (!policy.ok) return unsupported('managed-policy');
  if (request.selection.provider === 'claude-code') {
    if (!['--safe-mode', '--restricted', '--tools', '--strict-mcp-config', '--permission-prompts'].every(flag => policy.stdout.includes(flag))) return unsupported('isolation');
    if (!await deps.claudeModelAvailable(request)) return unsupported('metadata-drift');
  } else {
    const c = codexSupervisorControls(workspace.guestRoot);
    const features = await deps.probe(request, workspace, [...c, 'features', 'list']);
    if (!clean(features)) return unsupported('isolation');
    for (let i = 1; i < c.length; i += 2) {
      const m = c[i].match(/^features\.([a-z_]+)=(true|false)$/);
      if (m && !features.stdout.split('\n').some(line => line.split(/\s+/)[0] === m[1] && line.trim().endsWith(m[2]))) return unsupported('isolation');
    }
    const native = await deps.probe(request, workspace, ['debug', 'models']);
    if (!clean(native)) return unsupported('metadata-drift');
    try {
      const model = (JSON.parse(native.stdout).models as Record<string, unknown>[]).find(m => m.slug === request.selection.model);
      const expected = catalog.models[0];
      for (const key of ['slug', 'context_window', 'max_context_window', 'supported_reasoning_levels', 'service_tiers', 'use_responses_lite']) {
        if (JSON.stringify(model?.[key]) !== JSON.stringify(expected[key as keyof typeof expected])) return unsupported('metadata-drift');
      }
      const registrations = { shell_type: 'unified_exec', apply_patch_tool_type: 'freeform', tool_mode: 'code_mode_only',
        experimental_supported_tools: ['send_user_message_async', 'clock'], supports_search_tool: true, node_repl_disabled: false };
      if (Object.entries(registrations).some(([key, value]) => JSON.stringify(model?.[key]) !== JSON.stringify(value))) return unsupported('metadata-drift');
    } catch { return unsupported('metadata-drift'); }
    const metadata = await deps.probe(request, workspace, [...c, 'debug', 'models']);
    const mcp = await deps.probe(request, workspace, [...c, 'mcp', 'list', '--json']);
    const config = await deps.probe(request, workspace, ['--tessera-config-attestation', ...c]);
    if (![metadata, mcp, config].every(clean)) return unsupported('metadata-drift');
    try {
      if (JSON.stringify(JSON.parse(mcp.stdout)) !== '[]') return unsupported('isolation');
      const expected = catalog.models[0];
      const selected = (JSON.parse(metadata.stdout).models as Record<string, unknown>[]).find(m => m.slug === request.selection.model);
      for (const key of ['slug', 'shell_type', 'apply_patch_tool_type', 'tool_mode', 'experimental_supported_tools', 'supports_search_tool', 'node_repl_disabled',
        'context_window', 'max_context_window', 'supported_reasoning_levels', 'service_tiers', 'base_instructions', 'include_skills_usage_instructions', 'include_plugin_usage_instructions', 'include_apps_usage_instructions']) {
        const value = expected[key as keyof typeof expected];
        if (JSON.stringify(value === null ? selected?.[key] ?? null : selected?.[key]) !== JSON.stringify(value)) return unsupported('metadata-drift');
      }
      const modelMessages = selected?.model_messages as Record<string, unknown> | null | undefined;
      if (modelMessages && (modelMessages.instructions_template !== expected.base_instructions ||
          Object.entries(modelMessages).some(([key, value]) => key !== 'instructions_template' && value !== null))) return unsupported('metadata-drift');
      const read = JSON.parse(config.stdout);
      const effective = read.config;
      // debug config's effective scalar/nested fields are checked, not the requested argv alone.
      for (let i = 1; i < c.length; i += 2) {
        const [key, value] = c[i].split(/=(.*)/s);
        if (key.startsWith('features.')) continue;
        const projected = nestedField(effective, key);
        // v2 Config.tools intentionally projects only web_search. The raw CLI layer retains these two controls.
        const raw = key.startsWith('tools.') ? read.layers?.filter((layer: { disabledReason?: string; name: { type?: string } }) => !layer.disabledReason && layer.name.type === 'sessionFlags')
          .map((layer: { config: Record<string, unknown> }) => nestedField(layer.config, key))[0] : undefined;
        const actual = projected ?? (read.origins?.[key]?.name?.type === 'sessionFlags' ? raw : undefined);
        if (JSON.stringify(actual) !== JSON.stringify(JSON.parse(value))) return unsupported('isolation');
      }
    } catch { return unsupported('metadata-drift'); }
  }
  return { kind: 'available', capability: { version: 1, selection: request.selection, cliVersion: proof.cliVersion, proofId: proof.proofId,
    isolationPolicyVersion: SUPERVISOR_PROOF_POLICY, available: true, checkedAt: Date.now() } };
}
export async function checkSupervisorCapability(request: SupervisorCapabilityRequest, deps = defaultSupervisorDependencies): Promise<SupervisorCapabilityResult> {
  let workspace: SupervisorWorkspace | undefined;
  try { workspace = await deps.prepare(request); return await attest(request, workspace, deps); }
  catch { return unsupported('isolation'); }
  finally { await workspace?.cleanup(); }
}
export async function generateSupervisorDecision(request: SupervisorDecisionRequest, deps = defaultSupervisorDependencies): Promise<SupervisorResult> {
  const base = { invocationId: request.invocationId, quiescent: true, exitCode: null };
  if (request.signal.aborted) return supervisorFailure(base, 'cancelled');
  if (request.deadlineAt <= Date.now()) return supervisorFailure(base, 'timeout');
  const stdin = request.trustedInstructions + '\n\n<worker-evidence-json>\n' + JSON.stringify(request.packet) + '\n</worker-evidence-json>';
  if (!supervisorPacketSchema.safeParse(request.packet).success || Buffer.byteLength(stdin) > AUTORUN_BOUNDS.packetBytes) return supervisorFailure(base, 'invalid-output');
  let workspace: SupervisorWorkspace | undefined, quiescent = true;
  const finish = async (result: SupervisorResult) => {
    if (workspace?.recovery) {
      const observation = await closeSupervisorInvocation(workspace.recovery);
      if (observation.kind !== 'quiescent') {
        quiescent = false; await retainUncertain(request, workspace);
        return supervisorFailure({ ...base, quiescent: false }, 'provider-error');
      }
    }
    return result;
  };
  try {
    workspace = await deps.prepare(request);
    const capability = await attest(request, workspace, deps);
    if (request.signal.aborted) return await finish(supervisorFailure(base, 'cancelled'));
    if (request.deadlineAt <= Date.now()) return await finish(supervisorFailure(base, 'timeout'));
    if (capability.kind !== 'available') return await finish(supervisorFailure(base, 'unsupported'));
    await fs.rm(workspace.root + '/settled.json', { force: true });
    await fs.writeFile(workspace.root + '/schema.json', JSON.stringify(request.outputSchema), { mode: 0o600 });
    await fs.writeFile(workspace.root + '/launch.json', JSON.stringify({ command: workspace.command, args: supervisorArgs(request, workspace), environment: workspace.environment, deadlineAt: request.deadlineAt }), { mode: 0o600 });
    const result = await runOwnedSupervisor({ ...request, ...workspace, stdin });
    quiescent = result.quiescent;
    if (!quiescent) await retainUncertain(request, workspace);
    return await finish(parseSupervisorResult({ ...result, selection: request.selection, cliVersion: capability.capability.cliVersion, invocationId: request.invocationId, packet: request.packet }));
  } catch (error) {
    if (error instanceof SupervisorProcessUncertain) {
      quiescent = false;
      if (workspace) await retainUncertain(request, workspace);
    }
    return await finish(supervisorFailure({ ...base, quiescent }, 'provider-error'));
  }
  finally { if (quiescent) await workspace?.cleanup(); }
}
