import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createAutorunProviderPort } from '../src/lib/cli/providers/autorun-provider';
import type { SettlementDependencies } from '../src/lib/cli/providers/autorun-settlement';
import { registerSupervisorInvocation, closeSupervisorInvocation } from '../src/lib/cli/providers/autorun-settlement';
const exec = promisify(execFile);
const request = { version: 1 as const, userId: 'recovery-owner', agentEnvironment: 'wsl' as const, invocationId: 'call-1' };
async function fixture(clock?: () => number) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'autorun-recovery-'));
  const deps: SettlementDependencies = { resolveGuestHome: async () => home,
    execute: async (_request, command, args) => {
      if (clock) { args = [...args]; const index = args.indexOf('-e'); if (index >= 0) args[index + 1] = `Date.now=()=>${clock()};\n` + args[index + 1]; }
      try { const result = await exec(command, args, { timeout: 5000, maxBuffer: 16_384 }); return { ok: true, ...result }; }
      catch (error) { return { ok: false, stdout: '', stderr: String((error as { stderr?: string }).stderr ?? '') }; }
    } };
  return { home, deps, port: createAutorunProviderPort('codex', deps) };
}
test('public recovery query keeps missing ownership proof unknown and starts no inference', async () => {
  const f = await fixture();
  try {
    assert.equal(typeof f.port.observeSupervisorSettlement, 'function');
    const result = await f.port.observeSupervisorSettlement!(request);
    assert.equal(result.kind, 'unknown');
    if (result.kind === 'unknown') assert.equal(result.reason, 'missing');
    assert.deepEqual(await fs.readdir(f.home), []);
  } finally { await fs.rm(f.home, { recursive: true }); }
});
test('lost backend output pipes do not destroy guest deadline and durable settlement evidence', async () => {
  const f = await fixture();
  try {
    const recovery = await registerSupervisorInvocation({ ...request, provider: 'codex', deadlineAt: Date.now() + 10_000 }, f.home, f.deps);
    const attempt = await createSupervisorAttempt(recovery), workspace = f.home + '/dropped-backend';
    await fs.mkdir(workspace); await fs.mkdir(workspace + '/empty'); await fs.writeFile(workspace + '/group.cjs', AUTORUN_GROUP_WRAPPER);
    await fs.writeFile(workspace + '/launch.json', JSON.stringify({ command: process.execPath,
      args: ['-e', 'setInterval(()=>process.stdout.write("owned output\\n"),25);setTimeout(()=>process.exit(0),1500)'], environment: {}, deadlineAt: Date.now() + 500 }));
    const guest = spawn(process.execPath, ['-e', AUTORUN_RECOVERY_BRIDGE, JSON.stringify({ ledgerRoot: recovery.guestRoot, workspace, attempt: attempt.guestRoot })], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>(resolve => guest.stdout.once('data', () => resolve()));
    guest.kill('SIGTERM'); // Exact owned I/O relay; the execution guardian retains its own kernel lock.
    await new Promise<void>((resolve, reject) => { guest.on('close', () => resolve()); guest.on('error', reject); });
    let closed = await closeSupervisorInvocation(recovery);
    for (let n = 0; n < 20 && closed.kind !== 'quiescent'; n++) {
      await new Promise(resolve => setTimeout(resolve, 50)); closed = await closeSupervisorInvocation(recovery);
    }
    assert.equal(closed.kind, 'quiescent');
    assert.equal((await createAutorunProviderPort('codex', { ...f.deps }).observeSupervisorSettlement!(request)).kind, 'quiescent');
  } finally { await fs.rm(f.home, { recursive: true }); }
});
test('restart seals expired prelaunch authorization and blocks an already queued guest wrapper', async () => {
  let now = 1800000000000;
  const f = await fixture(() => now);
  try {
    const recovery = await registerSupervisorInvocation({ ...request, provider: 'codex', deadlineAt: now + 1000 }, f.home, f.deps);
    const attempt = await createSupervisorAttempt(recovery);
    assert.equal((await f.port.observeSupervisorSettlement!(request)).kind, 'unknown');
    now += 2000;
    assert.equal((await createAutorunProviderPort('codex', { ...f.deps }).observeSupervisorSettlement!(request)).kind, 'quiescent');
    const workspace = f.home + '/delayed';
    await fs.mkdir(workspace); await fs.mkdir(workspace + '/empty'); await fs.writeFile(workspace + '/group.cjs', AUTORUN_GROUP_WRAPPER);
    await fs.writeFile(workspace + '/launch.json', JSON.stringify({ command: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(workspace + '/unauthorized-launch')},'started')`], environment: {}, deadlineAt: Date.now() + 60_000 }));
    const delayed = await f.deps.execute(request, 'flock', ['--no-fork', '-n', recovery.guestRoot + '/lock', 'node', workspace + '/group.cjs', workspace, attempt.guestRoot]);
    assert.equal(delayed.ok, false);
    await assert.rejects(fs.access(workspace + '/unauthorized-launch'));
    assert.equal((await f.port.observeSupervisorSettlement!(request)).kind, 'quiescent');
  } finally { await fs.rm(f.home, { recursive: true }); }
});
import { createSupervisorAttempt } from '../src/lib/cli/providers/autorun-settlement';
import { AUTORUN_GROUP_WRAPPER, AUTORUN_RECOVERY_BRIDGE, runOwnedSupervisor } from '../src/lib/cli/providers/autorun-process';
test('owned process receipt survives host restart and closed authorization denies late launches', async () => {
  const f = await fixture();
  try {
    const recovery = await registerSupervisorInvocation({ ...request, provider: 'codex', deadlineAt: Date.now() + 60_000 }, f.home, f.deps);
    const workspace = path.join(f.home, 'scratch');
    await fs.mkdir(workspace); await fs.mkdir(workspace + '/empty');
    await fs.writeFile(workspace + '/group.cjs', AUTORUN_GROUP_WRAPPER);
    await fs.writeFile(workspace + '/launch.json', JSON.stringify({ command: process.execPath, args: ['-e', 'process.stdout.write("owned output")'], environment: {}, deadlineAt: Date.now() + 5000 }));
    const result = await runOwnedSupervisor({ ...request, root: workspace, guestRoot: workspace, recovery,
      signal: new AbortController().signal, deadlineAt: Date.now() + 5000, stdin: '' });
    assert.equal(result.quiescent, true);
    assert.equal(result.exitCode, 0);
    await closeSupervisorInvocation(recovery);
    const restarted = createAutorunProviderPort('codex', { ...f.deps });
    const observed = await restarted.observeSupervisorSettlement!(request);
    assert.equal(observed.kind, 'quiescent');
    assert.ok(!('stdout' in observed) && !('decision' in observed));
    const manifest = JSON.parse(await fs.readFile(recovery.root + '/invocation.json', 'utf8'));
    const file = recovery.root + '/attempts/' + manifest.attemptIds[0] + '/state.json';
    const saved = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(saved), launchId: 'foreign-generation' }));
    assert.equal((await restarted.observeSupervisorSettlement!(request)).kind, 'unknown');
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(saved), padding: 'x'.repeat(40_000) }));
    assert.equal((await restarted.observeSupervisorSettlement!(request)).kind, 'unknown');
    await fs.writeFile(file, saved);
    const failedTransport = createAutorunProviderPort('codex', { ...f.deps, execute: async () => ({ ok: false, stdout: '', stderr: '' }) });
    assert.equal((await failedTransport.observeSupervisorSettlement!(request)).kind, 'unknown');
    await assert.rejects(createSupervisorAttempt(recovery));
  } finally { await fs.rm(f.home, { recursive: true }); }
});
test('restart query validates exact prelaunch scope and cannot release open launch authorization', async () => {
  const f = await fixture();
  try {
    const recovery = await registerSupervisorInvocation({ ...request, provider: 'codex', deadlineAt: Date.now() + 60_000 }, f.home, f.deps);
    const restarted = createAutorunProviderPort('codex', { ...f.deps });
    assert.equal((await restarted.observeSupervisorSettlement!(request)).kind, 'unknown');
    for (const wrong of [{ ...request, userId: 'other' }, { ...request, agentEnvironment: 'native' as const }, { ...request, invocationId: 'other' }]) {
      assert.equal((await restarted.observeSupervisorSettlement!(wrong)).kind, 'unknown');
    }
    assert.equal((await createAutorunProviderPort('claude-code', f.deps).observeSupervisorSettlement!(request)).kind, 'unknown');
    await closeSupervisorInvocation(recovery);
    const result = await restarted.observeSupervisorSettlement!(request);
    assert.equal(result.kind, 'quiescent');
    if (result.kind === 'quiescent') assert.equal(result.proof.launchId, recovery.launchId);
    assert.equal((await restarted.observeSupervisorSettlement!(request)).kind, 'quiescent');
  } finally { await fs.rm(f.home, { recursive: true }); }
});
test('missing or started-without-receipt attempts remain quarantined regardless of PID absence', async () => {
  const f = await fixture();
  try {
    const recovery = await registerSupervisorInvocation({ ...request, provider: 'codex', deadlineAt: Date.now() + 60_000 }, f.home, f.deps);
    const attempt = await createSupervisorAttempt(recovery);
    const state = JSON.parse(await fs.readFile(attempt.root + '/state.json', 'utf8'));
    await fs.writeFile(attempt.root + '/state.json', JSON.stringify({ ...state, phase: 'running', child: { pid: 2147483647, start: 'old-pid' } }));
    assert.equal((await closeSupervisorInvocation(recovery)).kind, 'unknown');
    assert.equal((await f.port.observeSupervisorSettlement!(request)).kind, 'unknown');
    await fs.rm(attempt.root + '/state.json');
    assert.equal((await f.port.observeSupervisorSettlement!(request)).kind, 'unknown');
  } finally { await fs.rm(f.home, { recursive: true }); }
});
test('sealed affirmative prelaunch intent reconciles without ever starting a process', async () => {
  const f = await fixture();
  try {
    const recovery = await registerSupervisorInvocation({ ...request, provider: 'codex', deadlineAt: Date.now() + 60_000 }, f.home, f.deps);
    await createSupervisorAttempt(recovery);
    assert.equal((await f.port.observeSupervisorSettlement!(request)).kind, 'unknown');
    assert.equal((await closeSupervisorInvocation(recovery)).kind, 'quiescent');
    assert.equal((await f.port.observeSupervisorSettlement!(request)).kind, 'quiescent');
    await assert.rejects(registerSupervisorInvocation({ ...request, provider: 'codex', deadlineAt: Date.now() + 60_000 }, f.home, f.deps));
  } finally { await fs.rm(f.home, { recursive: true }); }
});
import { generateSupervisorDecision, defaultSupervisorDependencies } from '../src/lib/cli/providers/autorun-supervisor';
import { SUPERVISOR_DECISION_JSON_SCHEMA } from '../src/lib/automation/autorun-contracts';
import { contextSnapshot, supervisorFinalFixture } from './fixtures/autorun-contracts';
test('real generate wiring preserves all probe/inference receipts after workspace cleanup', async () => {
  const f = await fixture();
  try {
    const selection = { provider: 'claude-code' as const, model: 'claude-sonnet-5-5', reasoningEffort: 'high', serviceTier: null };
    const init = JSON.parse(await fs.readFile('tests/fixtures/autorun-proof/capability-observations.json', 'utf8')).claudeInit;
    const final = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', structured_output: supervisorFinalFixture().decision };
    const command = f.home + '/fixture-cli.cjs', workspace = f.home + '/scratch';
    await fs.writeFile(command, '#!/usr/bin/env node\n' + `const args=process.argv.slice(2);process.stdout.write(args.includes('--version')?'2.1.284\\n':args.includes('--help')?'--safe-mode --restricted --tools --strict-mcp-config --permission-prompts\\n':${JSON.stringify(JSON.stringify({ type: 'system', subtype: 'init', ...init }) + '\n' + JSON.stringify(final) + '\n')});`, { mode: 0o700 });
    await fs.mkdir(workspace); await fs.mkdir(workspace + '/empty'); await fs.writeFile(workspace + '/group.cjs', AUTORUN_GROUP_WRAPPER);
    const deadlineAt = Date.now() + 15_000;
    const recovery = await registerSupervisorInvocation({ ...request, provider: 'claude-code', deadlineAt }, f.home, f.deps);
    const result = await generateSupervisorDecision({ ...request, selection, deadlineAt, signal: new AbortController().signal,
      trustedInstructions: 'Judge supplied fixture.', outputSchema: SUPERVISOR_DECISION_JSON_SCHEMA,
      packet: { version: 1, objective: { kind: 'explicit', text: 'Fix login.', revision: 1 }, criteria: [{ id: 'goal', text: 'Test passes.' }],
        criterionOrigin: 'explicit', constraints: [], context: contextSnapshot(), priorDecisions: [] } }, {
      ...defaultSupervisorDependencies, prepare: async () => ({ root: workspace, guestRoot: workspace, command, environment: {}, recovery,
        cleanup: () => fs.rm(workspace, { recursive: true }) }), claudeModelAvailable: async () => true,
    });
    assert.equal(result.kind, 'ok');
    const restarted = createAutorunProviderPort('claude-code', { ...f.deps });
    assert.equal((await restarted.observeSupervisorSettlement!(request)).kind, 'quiescent');
    // Destroying one historical probe receipt invalidates the entire invocation, even though the final exited.
    const manifest = JSON.parse(await fs.readFile(recovery.root + '/invocation.json', 'utf8'));
    await fs.rm(recovery.root + '/attempts/' + manifest.attemptIds[0] + '/state.json');
    assert.equal((await restarted.observeSupervisorSettlement!(request)).kind, 'unknown');
  } finally { await fs.rm(f.home, { recursive: true }); }
});
