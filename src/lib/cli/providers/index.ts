/**
 * CLI Providers — Barrel Export
 *
 * Single import point for all CLI provider abstractions and the registry.
 * Adding a new CLI provider requires:
 *   1. Export its adapter from this file (e.g. `export * from './gemini/adapter'`)
 *   2. Register it in bootstrap.ts (imported by server startup)
 */

export type {
  CliProvider,
  SpawnOptions,
  SpawnResult,
  ParsedMessage,
  ParsedMessageSideEffect,
  ProviderMeta,
  GeneratedTitle,
} from './types';

export {
  CliProviderRegistry,
  isBinaryAvailable,
  cliProviderRegistry,
} from './registry';

export { ClaudeCodeAdapter, claudeCodeAdapter } from './claude-code/adapter';
export { CodexAdapter, codexAdapter } from './codex/adapter';
