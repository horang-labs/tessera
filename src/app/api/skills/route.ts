import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getSkillList, resolveClaudeConfigDirForEnvironment } from '@/lib/skill/skill-loader';
import { probeBinaryAvailable, type CliEnvironment } from '@/lib/cli/cli-exec';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import logger from '@/lib/logger';

function getEnvironmentLabel(environment: CliEnvironment): string {
  if (environment === 'wsl') return 'WSL';
  if (process.platform === 'win32') return 'Windows native';
  if (process.platform === 'darwin') return 'macOS native';
  return process.platform;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) {
      return auth.response;
    }

    const projectDir = request.nextUrl.searchParams.get('projectDir') || undefined;
    const agentEnvironment = await getAgentEnvironment(auth.userId);
    const configDir = await resolveClaudeConfigDirForEnvironment(agentEnvironment);
    const claudeAvailable = await probeBinaryAvailable('claude', agentEnvironment);
    const skills = claudeAvailable ? getSkillList(projectDir, configDir) : [];

    return NextResponse.json({
      skills,
      meta: {
        providerId: 'claude-code',
        claudeAvailable,
        configDir,
        configSource: process.env.CLAUDE_CONFIG_DIR ? 'CLAUDE_CONFIG_DIR' : 'default',
        environment: getEnvironmentLabel(agentEnvironment),
      },
    });
  } catch (error) {
    logger.error({ error }, 'GET /api/skills error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
