import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import logger from '@/lib/logger';
import { getServerHostInfo } from '@/lib/system/server-host';
import { getTelemetryBootstrapInfo } from '@/lib/telemetry/server-state';

export const runtime = 'nodejs';

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_EMAIL_LENGTH = 320;
const CAPTURE_TIMEOUT_MS = 2_000;
const allowedSources = new Set(['project_strip', 'cli_error', 'setup', 'settings', 'project_import']);

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) {
      return auth.response;
    }

    const body = await request.json() as {
      message?: unknown;
      email?: unknown;
      source?: unknown;
    };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const source = typeof body.source === 'string' && allowedSources.has(body.source)
      ? body.source
      : 'unknown';

    if (!message) {
      return NextResponse.json(
        { error: 'Feedback message is required.' },
        { status: 400 },
      );
    }

    if (email && !isLikelyEmail(email)) {
      return NextResponse.json(
        { error: 'Enter a valid email address or leave it blank.' },
        { status: 400 },
      );
    }

    const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
    if (!projectToken) {
      return NextResponse.json(
        { error: 'Feedback is not configured.' },
        { status: 503 },
      );
    }

    const hostInfo = getServerHostInfo();
    const bootstrap = await getTelemetryBootstrapInfo(hostInfo);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);

    try {
      const response = await fetch(`${getPostHogCaptureHost()}/capture/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: projectToken,
          event: 'feedback_submitted',
          properties: {
            distinct_id: bootstrap.installId,
            install_id: bootstrap.installId,
            feedback_message: message.slice(0, MAX_MESSAGE_LENGTH),
            ...(email ? { feedback_email: email.slice(0, MAX_EMAIL_LENGTH) } : {}),
            source,
            app_version: hostInfo.appVersion,
            platform: hostInfo.platform,
            arch: hostInfo.arch,
            channel: hostInfo.channel,
            $geoip_disable: true,
            $process_person_profile: false,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'feedback capture failed');
        return NextResponse.json(
          { error: 'Failed to send feedback.' },
          { status: 502 },
        );
      }
    } finally {
      clearTimeout(timeout);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'POST /api/feedback error');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

function getPostHogCaptureHost(): string {
  const explicitHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (explicitHost) return explicitHost.replace(/\/$/, '');

  const apiHost = process.env.NEXT_PUBLIC_POSTHOG_API_HOST;
  if (apiHost && (apiHost.startsWith('http://') || apiHost.startsWith('https://'))) {
    return apiHost.replace(/\/$/, '');
  }

  return 'https://us.i.posthog.com';
}

function isLikelyEmail(value: string): boolean {
  if (value.length > MAX_EMAIL_LENGTH) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
