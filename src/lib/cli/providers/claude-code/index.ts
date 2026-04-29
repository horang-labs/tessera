/**
 * Claude Code Provider - Barrel Export
 *
 * Re-exports all public symbols from the Claude Code CLI provider:
 *  - ClaudeCodeAdapter / claudeCodeAdapter singleton
 *  - ClaudeCodeProtocolParser / claudeCodeProtocolParser singleton
 */

export { ClaudeCodeAdapter, claudeCodeAdapter } from './adapter';
export { ClaudeCodeProtocolParser, claudeCodeProtocolParser } from './protocol-parser';
