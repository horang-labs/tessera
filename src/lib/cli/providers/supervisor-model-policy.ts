import { createHash } from 'node:crypto';
import { SUPERVISOR_PROOF_POLICY, SUPERVISOR_ISOLATION_PROFILES, type SupervisorSelection, type SupervisorCandidate } from '@/lib/automation/autorun-contracts';
export const PACKET_INSTRUCTIONS = 'Analyze only the supplied Session packet. No tools. Return the structured JSON decision.';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function selectionMetadataHash(native: unknown, adapted: unknown, selection: SupervisorSelection) {
  return createHash('sha256').update(canonical({ policy: SUPERVISOR_PROOF_POLICY,
    profile: SUPERVISOR_ISOLATION_PROFILES[selection.provider], native, adapted, selection })).digest('hex');
}
const efforts = new Set(['minimal','low','medium','high','xhigh','max','ultra']);
export function nativeModelCandidate(model: Record<string, unknown>): SupervisorCandidate {
  const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels as { effort?: string }[] : [];
  const supportedEfforts=levels.map(l=>l?.effort).filter((e):e is string=>typeof e==='string'&&efforts.has(e));
  const tiers = Array.isArray(model.service_tiers) ? model.service_tiers as { id?: string }[] : [];
  const fast = (Array.isArray(model.additional_speed_tiers) && model.additional_speed_tiers.includes('fast')) && tiers.some(t=>t.id==='priority'||t.id==='fast');
  return { provider: 'codex', model: String(model.slug ?? ''), label: String(model.display_name ?? model.slug ?? ''),
    reasoningEfforts:supportedEfforts,
    serviceTiers: fast ? ['default','fast'] : ['default'], source:'native',
    unavailableReason: !supportedEfforts.length ? 'metadata-unavailable' : model.supported_in_api!==true ? 'unsupported-selection' : null };
}
export function adaptSupervisorModel(native: Record<string, unknown>, selection: SupervisorSelection): Record<string, unknown> {
  const candidate = nativeModelCandidate(native);
  if (candidate.model !== selection.model || !candidate.reasoningEfforts.includes(selection.reasoningEffort)
    || !candidate.serviceTiers.includes(selection.serviceTier) || native.supported_in_api !== true
    || typeof native.context_window !== 'number' || !Number.isFinite(native.context_window) || native.context_window <= 0
    || !Array.isArray(native.service_tiers) || !Array.isArray(native.additional_speed_tiers)
    || typeof native.use_responses_lite !== 'boolean' || typeof native.supports_search_tool !== 'boolean'
    || typeof native.node_repl_disabled !== 'boolean' || !Array.isArray(native.experimental_supported_tools)
    || !['disabled','default','shell_command','unified_exec'].includes(String(native.shell_type))
    || ![undefined,null,'freeform','function'].includes(native.apply_patch_tool_type as string|null|undefined)
    || ![undefined,null,'direct','code_mode','code_mode_only'].includes(native.tool_mode as string|null|undefined)) throw new Error('unsupported model metadata');
  return { ...native, shell_type:'disabled', apply_patch_tool_type:null, experimental_supported_tools:[],
    tool_mode:null, supports_search_tool:false, node_repl_disabled:true, model_messages:null,
    base_instructions:PACKET_INSTRUCTIONS, include_skills_usage_instructions:false,
    include_plugin_usage_instructions:false, include_apps_usage_instructions:false };
}
