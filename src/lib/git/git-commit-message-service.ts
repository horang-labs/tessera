import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import { SettingsManager } from '@/lib/settings/manager';
import type { GitActionTarget } from './git-actions';
import {
  CommitMessageGenerationError,
  generateCommitMessage,
} from './commit-message-generator';

export function parseSelectedFiles(
  body: unknown,
): { files: string[] } | { message: string } {
  if (typeof body !== 'object' || body === null) {
    return { message: 'A list of file paths is required' };
  }
  const { files } = body as { files?: unknown };
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) {
    return { message: 'A list of file paths is required' };
  }
  return { files: files as string[] };
}

/** Generate through the user-wide Source Control AI defaults, Orca-style. */
export async function generateConfiguredCommitMessage(
  target: GitActionTarget,
  userId: string,
  files: string[],
  fallbackProviderId?: string,
): Promise<string> {
  const settings = await SettingsManager.load(userId, { silent: true });
  const { provider: providerId, model } = settings.gitConfig.sourceControlAi;
  return generateCommitMessage(target, files, async (prompt) => {
    const candidates = [
      { providerId, model: model || undefined },
      ...(fallbackProviderId && fallbackProviderId !== providerId
        ? [{ providerId: fallbackProviderId, model: undefined }]
        : []),
    ];
    for (const candidate of candidates) {
      if (!cliProviderRegistry.hasProvider(candidate.providerId)) continue;
      const provider = cliProviderRegistry.getProvider(candidate.providerId);
      const generateText = provider.generateText?.bind(provider);
      if (!generateText) continue;
      const result = await generateText(prompt, userId, candidate.model);
      if (result?.text?.trim()) return result.text;
    }
    throw new CommitMessageGenerationError(
      `Source Control AI provider '${providerId}' could not generate a commit message`,
    );
  });
}
