import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSupervisorCapability, type SupervisorDependencies } from '../src/lib/cli/providers/autorun-supervisor';
import { autorunInput } from './fixtures/autorun-contracts';
import catalog from '../src/lib/cli/providers/codex/autorun-catalog.json';
import controls from '../src/lib/cli/providers/codex/autorun-controls.json';
function deps(drift: 'version' | 'tool' | 'template' | 'mcp' | null): SupervisorDependencies {
  return { prepare: async () => ({ root: '/owned', guestRoot: '/owned', command: 'codex', environment: {}, cleanup: async () => {} }),
    claudeModelAvailable: async () => true,
    probe: async (_r, _w, args) => {
      let stdout = '';
      if (args[0] === '--version') stdout = `codex-cli ${drift === 'version' ? '0.160.0' : '0.159.2'}`;
      else if (args.at(-1) === 'list') stdout = controls.filter((_,i) => i % 2).flatMap(s => {
        const m = s.match(/^features\.([a-z_]+)=(true|false)$/); return m ? [`${m[1]} stable ${drift === 'tool' && m[1] === 'shell_tool' ? 'true' : m[2]}`] : [];
      }).join('\n');
      else if (args.at(-1) === 'models') stdout = JSON.stringify({ models: [{ ...catalog.models[0], ...(args.length === 2 ? { shell_type: 'unified_exec', apply_patch_tool_type: 'freeform', tool_mode: 'code_mode_only', experimental_supported_tools: ['send_user_message_async', 'clock'], supports_search_tool: true, node_repl_disabled: false } : {}), ...(drift === 'template' ? { model_messages: { instructions_template: 'unexpected', permissions: 'execute' } } : {}) }] });
      else if (args.at(-1) === '--json') stdout = JSON.stringify(drift === 'mcp' ? [{ name: 'server' }] : []);
      else if (args[0] === '--tessera-config-attestation') {
        const effective: Record<string, any> = {};
        for (const c of controls.filter((_, i) => i % 2)) {
          const at = c.indexOf('='), keys = c.slice(0, at).split('.'); let target = effective;
          for (const key of keys.slice(0, -1)) target = target[key] ??= {};
          target[keys.at(-1)!] = JSON.parse(c.slice(at + 1).replace('<scratch>', '/owned'));
        }
        stdout = JSON.stringify({ config: effective, layers: [], origins: {} });
      }
      return { ok: true, stdout, stderr: '' };
    },
  };
}
test('fresh pinned capability accepts effective isolation and refuses version/tool/template/MCP drift without a model call', async () => {
  const request = { userId: 'owner', agentEnvironment: 'wsl' as const, selection: autorunInput().autorun.supervisor };
  assert.equal((await checkSupervisorCapability(request, deps(null))).kind, 'available');
  for (const drift of ['version', 'tool', 'template', 'mcp'] as const) assert.equal((await checkSupervisorCapability(request, deps(drift))).kind, 'unavailable');
});
