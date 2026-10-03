import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunInput } from './fixtures/autorun-contracts';

test('selected native model metadata is adapted without replacing identity, effort range or tier', async () => {
  const { adaptSupervisorModel, selectionMetadataHash } = await import('../src/lib/cli/providers/supervisor-model-policy');
  const original = (await import('../src/lib/cli/providers/codex/autorun-catalog.json')).default.models[0];
  const native = { ...original, slug: 'gpt-6-astra', context_window: 180000, shell_type: 'unified_exec',
    apply_patch_tool_type: 'freeform', tool_mode: 'code_mode_only', supports_search_tool: true, node_repl_disabled: false };
  const selection = { ...autorunInput().autorun.supervisor, model: native.slug, reasoningEffort: 'xhigh', serviceTier: 'fast' as const };
  const adapted = adaptSupervisorModel(native, selection);
  assert.equal(adapted.slug, native.slug); assert.equal(adapted.context_window, 180000);
  assert.equal(adapted.shell_type, 'disabled'); assert.equal(adapted.apply_patch_tool_type, null);
  assert.equal(selectionMetadataHash(native, adapted, selection), selectionMetadataHash({ ...native }, { ...adapted }, selection));
  assert.notEqual(selectionMetadataHash(native, adapted, selection), selectionMetadataHash(native, adapted, { ...selection, reasoningEffort: 'high' }));
  assert.throws(() => adaptSupervisorModel(native, { ...selection, model: 'astra' }));
  assert.throws(() => adaptSupervisorModel({ ...native, tool_mode: 'unknown' }, selection));
});
