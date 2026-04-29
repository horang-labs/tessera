import { cliProviderRegistry } from './registry';
import { claudeCodeAdapter } from './claude-code/adapter';
import { codexAdapter } from './codex/adapter';

// Side-effect module imported by server startup to register built-in providers
// exactly once across hot reloads.
cliProviderRegistry.registerIfAbsent(claudeCodeAdapter.getProviderId(), () => claudeCodeAdapter);
cliProviderRegistry.registerIfAbsent(codexAdapter.getProviderId(), () => codexAdapter);
