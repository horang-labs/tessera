'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { useBoardStore } from '@/stores/board-store';
import { useLoadedProjectViews } from '@/hooks/use-project-view-workspace-state';
import { useSettingsStore } from '@/stores/settings-store';
import { resolvePreparationProject } from '@/lib/projects/preparation-project-selection';
import type { PreparationPhase } from '@/lib/projects/preparation-status-policy';
import IgnoredFileChecklist from './ignored-file-checklist';
import {
  settingsTelemetryClickAttributes,
} from '@/lib/telemetry/ui-click';

/** Typing pause after which the draft is written back to the project. */
const SAVE_DELAY_MS = 600;

/** What the editor is currently doing with the selected project's scripts. */
type EditorStatus = 'idle' | 'loading' | 'saving' | 'saved' | 'saveFailed' | 'loadFailed';

/** Both stages' drafts, keyed the way the run names them. */
type Drafts = Record<PreparationPhase, string>;

const EMPTY_DRAFTS: Drafts = { before: '', after: '' };
const SCRIPT_TELEMETRY_CONTROLS = {
  before: 'settings.project.before_script',
  after: 'settings.project.after_script',
} as const;

async function saveScript(
  projectId: string,
  script: string,
  phase: PreparationPhase,
): Promise<void> {
  const response = await fetch('/api/projects/preparation-script', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, preparationScript: script, phase }),
  });
  if (!response.ok) throw new Error(`Save failed with ${response.status}`);
}

export default function ProjectPreparationSettings() {
  const { t } = useI18n();
  const selectedProjectDir = useBoardStore((state) => state.selectedProjectDir);
  const projects = useLoadedProjectViews();
  const requestedProjectId = useSettingsStore((state) => state.openRequest?.projectId);

  // A preparation script belongs to a project, not to whatever is on screen, so
  // the editor picks its own — starting where the user is, and free to move.
  // A new request beats an earlier choice: being sent here for one project and
  // shown another is worse than losing the pick.
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);
  const [answeredRequest, setAnsweredRequest] = useState(requestedProjectId);
  if (requestedProjectId !== answeredRequest) {
    setAnsweredRequest(requestedProjectId);
    setChosenProjectId(null);
  }
  const projectId = resolvePreparationProject({
    requested: chosenProjectId ?? requestedProjectId,
    boardSelection: selectedProjectDir,
    projects,
  });

  const selectedProject = projects.find((project) => project.encodedDir === projectId);

  const [drafts, setDrafts] = useState<Drafts>(EMPTY_DRAFTS);
  // Loading from the first render, not idle: the load is started by an effect,
  // so an idle first frame would say the empty draft is the project's script.
  // The checklist believes that and would fill a script it has never seen.
  const [status, setStatus] = useState<EditorStatus>('loading');

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keyed by project and stage: the two boxes are edited independently, and a
  // pending write for one must not be dropped by a keystroke in the other.
  const pendingRef = useRef(
    new Map<string, { projectId: string; phase: PreparationPhase; script: string }>(),
  );
  // Which project the editor is showing, so a reply for a project we have left
  // updates that project's script without touching the status now on screen.
  const shownProjectIdRef = useRef<string | null>(null);
  shownProjectIdRef.current = projectId;

  // Each pending write carries its own project ID, so a save that lands after a
  // project switch still updates the project it was typed into.
  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = [...pendingRef.current.values()];
    if (pending.length === 0) return;
    pendingRef.current.clear();

    for (const write of pending) {
      const reportIfStillShown = (next: EditorStatus) => {
        if (shownProjectIdRef.current === write.projectId) setStatus(next);
      };
      void saveScript(write.projectId, write.script, write.phase)
        .then(() => reportIfStillShown('saved'))
        .catch(() => {
          // Keep the write queued so blurring or typing again retries it — but
          // never over a newer one for the same box.
          const key = pendingKey(write.projectId, write.phase);
          if (!pendingRef.current.has(key)) pendingRef.current.set(key, write);
          reportIfStillShown('saveFailed');
        });
    }
  }, []);

  // Only the newest load may write into the editor; a slower reply for the
  // project we just left must not overwrite the one now on screen.
  const loadRequestRef = useRef(0);
  // Nor may a reply overwrite an edit made while it was still in flight. A tick
  // from the checklist is such an edit, and it is already on its way to the
  // project — putting the loaded script back would take it off the screen while
  // leaving it stored, and the next keystroke would then save it away.
  const editedSinceLoadRef = useRef(false);
  const loadScripts = useCallback(async (targetProjectId: string) => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    editedSinceLoadRef.current = false;
    setDrafts(EMPTY_DRAFTS);
    setStatus('loading');
    try {
      const response = await fetch(
        `/api/projects/preparation-script?projectId=${encodeURIComponent(targetProjectId)}`,
      );
      if (!response.ok) throw new Error(`Load failed with ${response.status}`);
      const data = await response.json() as {
        preparationScript: string | null;
        preparationAfterScript: string | null;
      };
      if (loadRequestRef.current !== requestId) return;
      if (editedSinceLoadRef.current) return;
      setDrafts({
        before: data.preparationScript ?? '',
        after: data.preparationAfterScript ?? '',
      });
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
    void loadScripts(projectId);
  }, [loadScripts, projectId]);

  // Closing the panel or switching projects must not drop what was typed.
  useEffect(() => flushPendingSave, [flushPendingSave, projectId]);

  const handleChange = useCallback((phase: PreparationPhase, value: string) => {
    editedSinceLoadRef.current = true;
    setDrafts((current) => ({ ...current, [phase]: value }));
    const target = shownProjectIdRef.current;
    if (!target) return;

    pendingRef.current.set(pendingKey(target, phase), { projectId: target, phase, script: value });
    setStatus('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushPendingSave, SAVE_DELAY_MS);
  }, [flushPendingSave]);

  const changeBefore = useCallback(
    (value: string) => handleChange('before', value),
    [handleChange],
  );
  const changeAfter = useCallback(
    (value: string) => handleChange('after', value),
    [handleChange],
  );

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
        <div className="space-y-4">
          {/* Which project is being edited, and the way to edit another. Every
              project's script is reachable from here rather than only the one
              the user happens to be looking at. */}
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor="projectPreparationProject"
              className="text-sm text-(--text-secondary)"
            >
              {t('settings.preparation.projectLabel')}
            </label>
            <select
              {...settingsTelemetryClickAttributes('settings.project.selector')}
              id="projectPreparationProject"
              value={projectId}
              onChange={(event) => {
                // What was typed for the project being left still has to land.
                flushPendingSave();
                setChosenProjectId(event.target.value);
              }}
              className="min-w-0 flex-1 rounded-md border border-(--input-border) bg-(--input-bg) px-2 py-1 text-sm text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent)"
              data-testid="project-preparation-project"
            >
              {projects.map((project) => (
                <option key={project.encodedDir} value={project.encodedDir}>
                  {project.displayName}
                </option>
              ))}
            </select>
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

          {/* Above the boxes, because a variable is only useful while writing
              the line that uses it — under them it is a footnote nobody scrolls
              to. The example values are what the selected project would
              actually produce, so the shape can be copied rather than guessed. */}
          <PreparationVariables projectPath={selectedProject?.displayPath
            ?? selectedProject?.decodedPath
            ?? null} />

          {/* The blocking stage leads, because it is the one with a cost: every
              line in it is time an agent spends waiting to start. */}
          <PreparationScriptField
            phase="before"
            value={drafts.before}
            disabled={status === 'loading'}
            onChange={changeBefore}
            onBlur={flushPendingSave}
          >
            <IgnoredFileChecklist
              projectId={projectId}
              script={drafts.before}
              disabled={status === 'loading'}
              onScriptChange={changeBefore}
            />
          </PreparationScriptField>

          <PreparationScriptField
            phase="after"
            value={drafts.after}
            disabled={status === 'loading'}
            onChange={changeAfter}
            onBlur={flushPendingSave}
          />

        </div>
      )}
    </div>
  );
}

/** A branch Tessera would have generated, used to make the example paths real. */
const EXAMPLE_BRANCH = '0801-ab';

/**
 * What a script can refer to, with what each one holds.
 *
 * The value beside each name is the point: `$TESSERA_WORKTREE_DIR` says nothing
 * about what will be there at run time, and one look at the path it expands to
 * says all of it. The project's is its real path; the other two are what this
 * project's next worktree would look like.
 */
function PreparationVariables({ projectPath }: { projectPath: string | null }) {
  const { t } = useI18n();
  const separator = projectPath?.includes('\\') ? '\\' : '/';
  const projectName = projectPath?.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
  const projectDir = projectPath ?? `${separator}path${separator}to${separator}${projectName}`;
  const worktreeDir = [
    `~${separator}.tessera${separator}worktrees`,
    projectName,
    EXAMPLE_BRANCH,
  ].join(separator);

  return (
    <div className="space-y-1.5 rounded-md border border-(--divider) bg-(--bg-secondary) px-3 py-2.5">
      <span className="text-[11px] font-medium text-(--text-secondary)">
        {t('settings.preparation.variablesLabel')}
      </span>
      <dl className="space-y-1.5">
        {([
          ['TESSERA_PROJECT_DIR', 'settings.preparation.variables.projectDir', projectDir],
          ['TESSERA_WORKTREE_DIR', 'settings.preparation.variables.worktreeDir', worktreeDir],
          ['TESSERA_BRANCH_NAME', 'settings.preparation.variables.branchName', EXAMPLE_BRANCH],
        ] as const).map(([name, description, example]) => (
          <div key={name} className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="font-mono text-[11px] text-(--text-primary)">{name}</dt>
              <dd className="text-[11px] text-(--text-tertiary)">{t(description)}</dd>
            </div>
            <span
              className="truncate font-mono text-[10px] text-(--text-muted)"
              title={example}
              data-testid={`preparation-variable-example-${name}`}
            >
              {example}
            </span>
          </div>
        ))}
      </dl>
    </div>
  );
}

function pendingKey(projectId: string, phase: PreparationPhase): string {
  return `${projectId}:${phase}`;
}

/**
 * One stage's box.
 *
 * The two stages are the same field twice, and the label with the line under it
 * is what says which is which. Saying it there rather than in a manual is what
 * makes the split usable without one: the cost of a line — an agent waiting for
 * it, or not — is written next to the box it goes in.
 */
function PreparationScriptField({
  phase,
  value,
  disabled,
  onChange,
  onBlur,
  children,
}: {
  phase: PreparationPhase;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const fieldId = `projectPreparationScript-${phase}`;
  const telemetryControl = SCRIPT_TELEMETRY_CONTROLS[phase];

  return (
    <div className="space-y-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={fieldId} className="text-sm text-(--text-secondary)">
          {t(`settings.preparation.stage.${phase}.label`)}
        </label>
        <span className="text-[11px] text-(--text-tertiary)">
          {t(`settings.preparation.stage.${phase}.desc`)}
        </span>
      </div>
      <textarea
        {...settingsTelemetryClickAttributes(telemetryControl)}
        id={fieldId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        placeholder={t(`settings.preparation.stage.${phase}.placeholder`)}
        rows={phase === 'before' ? 8 : 4}
        spellCheck={false}
        disabled={disabled}
        className="w-full resize-y rounded-md border border-(--input-border) bg-(--input-bg) px-3 py-2 font-mono text-sm text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent) disabled:opacity-60"
        data-testid={`project-preparation-script-${phase}`}
      />
      {children}
    </div>
  );
}
