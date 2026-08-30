'use client';

import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { usePhoneViewport } from '@/hooks/use-phone-viewport';
import { useI18n } from '@/lib/i18n';
import { TESSERA_REPOSITORY_URL } from '@/lib/github/repository-star';
import { openExternalHttpUrl } from '@/lib/terminal/terminal-external-link';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { toast } from '@/stores/notification-store';

type StarButtonState = 'checking' | 'ready' | 'fallback' | 'starring' | 'starred' | 'hidden';
const STATUS_CHECK_TIMEOUT_MS = 3_000;
const STAR_REQUEST_TIMEOUT_MS = 5_000;

export function GitHubStarButton() {
  const { t } = useI18n();
  const isPhone = usePhoneViewport();
  const [state, setState] = useState<StarButtonState>('checking');

  useEffect(function checkCurrentStar() {
    if (isPhone) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      controller.abort();
      setState('fallback');
    }, STATUS_CHECK_TIMEOUT_MS);

    async function checkStar(): Promise<void> {
      try {
        const response = await fetch('/api/github/star', { signal: controller.signal });
        if (!response.ok) {
          setState('fallback');
          return;
        }

        const body = await response.json() as { status?: unknown };
        if (body.status === 'starred') {
          setState('hidden');
        } else if (body.status === 'unstarred') {
          setState('ready');
        } else {
          setState('fallback');
        }
      } catch (error) {
        if (!controller.signal.aborted) setState('fallback');
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void checkStar();
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [isPhone]);

  useEffect(function hideAfterSuccess() {
    if (state !== 'starred') return;
    const timeout = window.setTimeout(() => setState('hidden'), 1_000);
    return () => window.clearTimeout(timeout);
  }, [state]);

  if (isPhone || state === 'hidden') return null;

  async function handleStar(): Promise<void> {
    if (state === 'fallback') {
      openExternalHttpUrl(TESSERA_REPOSITORY_URL);
      return;
    }
    if (state !== 'ready') return;

    setState('starring');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), STAR_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch('/api/github/star', {
        method: 'PUT',
        signal: controller.signal,
      });
      const body = response.ok
        ? await response.json() as { starred?: unknown }
        : null;
      if (body?.starred === true) {
        setState('starred');
        toast.success(t('projectStrip.githubStarSuccess'));
        return;
      }
    } catch {
      // A direct second click keeps the web fallback inside user activation,
      // so browsers do not block the new tab as a delayed popup.
    } finally {
      window.clearTimeout(timeout);
    }

    setState('fallback');
    toast.info(t('projectStrip.githubStarFallback'));
  }

  const label = t('projectStrip.githubStar');
  const isPending = state === 'checking' || state === 'starring';
  const didStar = state === 'starred';

  return (
    <Tooltip content={label} delay={300}>
      <Button
        {...telemetryClickAttributes('sidebar.github_star', 'sidebar')}
        variant="ghost"
        size="icon-lg"
        className="rounded-none max-sm:hidden"
        onClick={() => void handleStar()}
        disabled={isPending || didStar}
        aria-label={label}
        title={label}
        data-testid="project-strip-github-star"
      >
        <Star
          className={didStar
            ? 'h-5 w-5 fill-amber-400 text-amber-400'
            : `h-5 w-5 ${isPending ? 'animate-pulse' : ''}`}
        />
      </Button>
    </Tooltip>
  );
}
