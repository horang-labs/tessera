import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbSessions from '@/lib/db/sessions';
import { processManager } from '@/lib/cli/process-manager';
import { listClaudeSkills } from '@/lib/cli/providers/claude-code/skill-discovery-client';
import { listCodexSkills } from '@/lib/cli/providers/codex/skill-discovery-client';
import { listOpenCodeCommands } from '@/lib/cli/providers/opencode/command-discovery-client';
import type { SkillInfo } from '@/lib/cli/providers/skill-types';
import { prependPendingTesseraCliSkill } from '@/lib/control/pending-tessera-cli-skill';
import { waitForPreparationBeforeSkillDiscovery } from '@/lib/projects/preparation-gate';
import { SettingsManager } from '@/lib/settings/manager';
import logger from '@/lib/logger';

/**
 * GET /api/sessions/[id]/skills
 *
 * Returns the list of skills available for the given session's CLI provider.
 * Active processes remain authoritative. Fresh GUI sessions use provider-native
 * discovery that does not start or resume a conversation. Temporary Codex
 * discovery failures remain retryable instead of becoming a valid empty list.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const auth = await requireAuthenticatedUserId(request, {
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    if ('response' in auth) {
      return auth.response;
    }

    const session = dbSessions.getSession(id);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const processInfo = processManager.getProcess(id);
    const providerId = session.provider?.trim();
    const workDir = dbSessions.getSessionWorktreeContext(id)?.workDir;

    if (!processInfo) {
      const preparation = await waitForPreparationBeforeSkillDiscovery({
        workDir,
      });
      if (!preparation.ready) {
        const code = preparation.reason === 'failed'
          ? 'preparation_failed'
          : 'preparation_timed_out';
        return NextResponse.json(
          {
            error: preparation.reason === 'failed'
              ? 'Worktree preparation failed before skill discovery.'
              : 'Worktree preparation did not finish before skill discovery.',
            code,
            retryable: true,
          },
          { status: 503 },
        );
      }
    }

    let skills: SkillInfo[] = [];

    if (providerId === 'codex') {
      try {
        skills = processInfo?.skillSource
          ? await processInfo.skillSource.listSkills()
          : await listCodexSkills({
              userId: auth.userId,
              workDir,
            });
      } catch (error) {
        logger.warn({
          sessionId: id,
          error: error instanceof Error ? error.message : String(error),
        }, 'Codex skill discovery temporarily failed');
        return NextResponse.json(
          { error: 'Skill discovery temporarily failed', retryable: true },
          { status: 503 },
        );
      }
    } else if (providerId === 'claude-code') {
      const reportedCommands = processManager.getCommands(id);
      if (reportedCommands.length > 0) {
        skills = reportedCommands;
      } else {
        skills = await listClaudeSkills({
          userId: auth.userId,
          workDir,
        });
      }
    } else if (providerId === 'opencode') {
      skills = processInfo
        ? processManager.getCommands(id)
        : await listOpenCodeCommands({
            userId: auth.userId,
            workDir,
          });
    }

    const tesseraCliEnabled = !processInfo
      ? (await SettingsManager.load(auth.userId, { silent: true })).tesseraCliEnabled
      : false;
    return NextResponse.json({
      skills: prependPendingTesseraCliSkill(skills, {
        providerId,
        enabled: tesseraCliEnabled,
        hasProcess: Boolean(processInfo),
      }),
    });
  } catch (error) {
    logger.warn({ sessionId: id, error }, 'Failed to discover session skills');
    return NextResponse.json({ skills: [] });
  }
}
