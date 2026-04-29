/**
 * Backwards-compatible barrel for provider contract and supporting types.
 *
 * Split by responsibility:
 * - provider-contract.ts: runtime provider interface
 * - session-types.ts: spawn/session/provider metadata
 * - message-types.ts: parser output + side effects
 * - skill-types.ts: skill discovery contracts
 */

export type {
  CliProvider,
  CliConnectionStatus,
  CliStatusResult,
  CheckStatusOptions,
} from './provider-contract';
export type { ParsedMessage, ParsedMessageSideEffect } from './message-types';
export type { GeneratedTitle, ProviderMeta, SpawnOptions, SpawnResult } from './session-types';
export type { SkillInfo, SkillSource } from './skill-types';
