'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useBoardStore } from '@/stores/board-store';
import { useSessionStore } from '@/stores/session-store';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import IgnoredFileChecklist from './ignored-file-checklist';

/** Typing pause after which the draft is written back to the project. */
const SAVE_DELAY_MS = 600;

/** What the editor is currently doing with the selected project's script. */
type EditorStatus = 'idle' | 'loading' | 'saving' | 'saved' | 'saveFailed' | 'loadFailed';

async function saveScript(projectId: string, script: string): Promise<void> {
  const response = await fetch('/api/projects/preparation-script', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, preparationScript: script }),
  });
  if (!response.ok) throw new Error(`Save failed with ${response.status}`);
}

export default function ProjectPreparationSettings() {
  const { t } = useI18n();
  const selectedProjectDir = useBoardStore((state) => state.selectedProjectDir);
  const projects = useSessionStore((state) => state.projects);

  const projectId =
    selectedProjectDir && selectedProjectDir !== ALL_PROJECTS_SENTINEL ? selectedProjectDir : null;
  const projectName = projects.find((project) => project.encodedDir === projectId)?.displayName ?? null;

  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<EditorStatus>('idle');

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ projectId: string; script: string } | null>(null);
  // Which project the editor is showing, so a reply for a project we have left
  // updates that project's script without touching the status now on screen.
  const shownProjectIdRef = useRef<string | null>(null);
  shownProjectIdRef.current = projectId;

  // The pending write carries its own project ID, so a save that lands after a
  // project switch still updates the project it was typed into.
  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    const reportIfStillShown = (next: EditorStatus) => {
      if (shownProjectIdRef.current === pending.projectId) setStatus(next);
    };
    void saveScript(pending.projectId, pending.script)
      .then(() => reportIfStillShown('saved'))
      .catch(() => {
        // Keep the write queued so blurring or typing again retries it.
        pendingRef.current ??= pending;
        reportIfStillShown('saveFailed');
      });
  }, []);

  // Only the newest load may write into the editor; a slower reply for the
  // project we just left must not overwrite the one now on screen.
  const loadRequestRef = useRef(0);
  const loadScript = useCallback(async (targetProjectId: string) => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    setDraft('');
    setStatus('loading');
    try {
      const response = await fetch(
        `/api/projects/preparation-script?projectId=${encodeURIComponent(targetProjectId)}`,
      );
      if (!response.ok) throw new Error(`Load failed with ${response.status}`);
      const data = await response.json() as { preparationScript: string | null };
      if (loadRequestRef.current !== requestId) return;
      setDraft(data.preparationScript ?? '');
      setStatus('idle');
    } catch {
      if (loadRequestRef.current !== requestId) return;
      setStatus('loadFailed');
    }
  }, []);

  useEffect(() => {
    // With no project selected there is nothing to load, and the editor is not
    // rendered, so the stale draft never reaches the screen.
    if (!projectId) return;
    void loadScript(projectId);
  }, [loadScript, projectId]);

  // Closing the panel or switching projects must not drop what was typed.
  useEffect(() => flushPendingSave, [flushPendingSave, projectId]);

  const handleChange = (value: string) => {
    setDraft(value);
    if (!projectId) return;

    pendingRef.current = { projectId, script: value };
    setStatus('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushPendingSave, SAVE_DELAY_MS);
  };

  const statusLabel = (() => {
    switch (status) {
      case 'loading':
        return t('settings.preparation.loading');
      case 'saving':
        return t('settings.preparation.saving');
      case 'saved':
        return t('settings.preparation.saved');
      case 'saveFailed':
        return t('settings.preparation.saveFailed');
      case 'loadFailed':
        return t('settings.preparation.loadFailed');
      default:
        return null;
    }
  })();
  const isErrorStatus = status === 'saveFailed' || status === 'loadFailed';

  return (
    <div className="space-y-4" data-testid="project-preparation-settings">
      <div className="flex flex-col gap-0.5">
        <h3 className="font-medium text-(--text-primary)">{t('settings.preparation.title')}</h3>
        <span className="text-[11px] text-(--text-tertiary)">
          {t('settings.preparation.description')}
        </span>
      </div>

      {projectId === null ? (
        <p className="text-sm text-(--text-muted)" data-testid="project-preparation-no-project">
          {t('settings.preparation.noProject')}
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <label htmlFor="projectPreparationScript" className="text-sm text-(--text-secondary)">
                {t('settings.preparation.scriptLabel')}
                {projectName ? <span className="text-(--text-muted)"> · {projectName}</span> : null}
              </label>
              <span className="text-[11px] text-(--text-tertiary)">
                {t('settings.preparation.scriptDesc')}
              </span>
            </div>
            {statusLabel ? (
              <span
                className={[
                  'shrink-0 text-[11px]',
                  isErrorStatus ? 'text-(--status-warning-text)' : 'text-(--text-muted)',
                ].join(' ')}
                data-testid="project-preparation-status"
              >
                {statusLabel}
              </span>
            ) : null}
          </div>
          <textarea
            id="projectPreparationScript"
            value={draft}
            onChange={(event) => handleChange(event.target.value)}
            onBlur={flushPendingSave}
            placeholder={t('settings.preparation.scriptPlaceholder')}
            rows={8}
            spellCheck={false}
            disabled={status === 'loading'}
            className="w-full resize-y rounded-md border border-(--input-border) bg-(--input-bg) px-3 py-2 font-mono text-sm text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent) disabled:opacity-60"
            data-testid="project-preparation-script"
          />
          <IgnoredFileChecklist
            projectId={projectId}
            script={draft}
            onScriptChange={handleChange}
          />
          <div className="space-y-1.5 border-t border-(--divider) pt-3">
            <p className="text-[11px] text-(--text-tertiary)">
              {t('settings.preparation.runsOnCreate')}
            </p>
            <dl className="space-y-1">
              {([
                ['TESSERA_PROJECT_DIR', 'settings.preparation.variables.projectDir'],
                ['TESSERA_WORKTREE_DIR', 'settings.preparation.variables.worktreeDir'],
                ['TESSERA_BRANCH_NAME', 'settings.preparation.variables.branchName'],
              ] as const).map(([name, description]) => (
                <div key={name} className="flex flex-wrap items-baseline gap-x-2">
                  <dt className="font-mono text-[11px] text-(--text-secondary)">{name}</dt>
                  <dd className="text-[11px] text-(--text-tertiary)">{t(description)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
