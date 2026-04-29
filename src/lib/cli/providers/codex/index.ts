/**
 * Codex CLI Provider - Barrel Export
 *
 * Re-exports the public API for the Codex CLI provider:
 *  - CodexAdapter / codexAdapter (singleton): CliProvider implementation
 *  - CodexProtocolParser / codexProtocolParser (singleton): JSON-RPC 2.0 stdout parser
 */

// Adapter
export { CodexAdapter, codexAdapter } from './adapter';

// Protocol parser
export { CodexProtocolParser, codexProtocolParser } from './protocol-parser';
