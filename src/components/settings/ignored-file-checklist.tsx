'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import type { IgnoredFileCandidate } from '@/lib/projects/ignored-file-candidates';
import {
  buildIgnoredFileChecklist,
  type ChecklistEntry,
} from '@/lib/projects/ignored-file-checklist';
import { rewriteCopyBlock } from '@/lib/projects/preparation-copy-block';

/** How far the checklist has got with the project's ignored files. */
type ScanStatus = 'idle' | 'scanning' | 'ready' | 'failed';

interface IgnoredFileChecklistProps {
  projectId: string;
  /** The script as the editor currently holds it, block and all. */
  script: string;
  /**
   * True while the editor has yet to read the stored script. The scan waits for
   * it: ticking the defaults into a script the checklist has not seen would
   * write over what is stored, so nothing may be ticked before it arrives.
   */
  disabled: boolean;
  /** Hands back the script with its block rewritten from the ticks. */
  onScriptChange: (nextScript: string) => void;
}

/**
 * Fills the preparation script in from the files git ignores.
 *
 * It sits under the editor rather than opening on top of it: the settings
 * panel is a modal already, and inline means every tick can be watched landing
 * in the editor above. There is nothing to confirm — a tick writes its command
 * straight away, and unticking takes it straight back out, so what the list
 * shows and what the script says are never out of step.
 */
export default function IgnoredFileChecklist({
  projectId,
  script,
  disabled,
  onScriptChange,
}: IgnoredFileChecklistProps) {
  const { t } = useI18n();

  // Open from the start. The list is the point of this editor for most people —
  // a script is usually a handful of copies and an install — and a list nobody
  // expands is a list that may as well not be there.
  const [isOpen, setIsOpen] = useState(true);
  const [status, setStatus] = useState<ScanStatus>('idle');
  const [entries, setEntries] = useState<ChecklistEntry[]>([]);
  /** How many ignored entries the checkout has, before any were dropped. */
  const [scannedTotal, setScannedTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [tickedPaths, setTickedPaths] = useState<ReadonlySet<string>>(new Set());

  // The script keeps changing under the checklist as the user types, and the
  // ticks are read from whatever it holds when the scan lands.
  const scriptRef = useRef(script);
  scriptRef.current = script;

  // Only the newest scan may fill the list; an earlier one landing late would
  // otherwise put back the ticks the user has since changed.
  const scanRequestRef = useRef(0);

  /** Put the block in the script, as the ticks now stand. */
  const writeTicks = useCallback((
    currentScript: string,
    currentEntries: ChecklistEntry[],
    ticked: ReadonlySet<string>,
  ) => {
    onScriptChange(rewriteCopyBlock(
      currentScript,
      currentEntries
        .filter((entry) => ticked.has(entry.path))
        .map(({ path, isDirectory }) => ({ path, isDirectory })),
    ));
  }, [onScriptChange]);

  const scan = useCallback(async () => {
    const requestId = scanRequestRef.current + 1;
    scanRequestRef.current = requestId;
    setStatus('scanning');

    try {
      const response = await fetch(
        `/api/projects/ignored-files?projectId=${encodeURIComponent(projectId)}`,
      );
      if (!response.ok) throw new Error(`Scan failed with ${response.status}`);
      const scanned = await response.json() as {
        candidates: IgnoredFileCandidate[];
        truncated: boolean;
        total: number;
      };
      if (scanRequestRef.current !== requestId) return;

      const current = scriptRef.current;
      const checklist = buildIgnoredFileChecklist(scanned.candidates, current);
      setEntries(checklist.entries);
      setTickedPaths(new Set(checklist.tickedPaths));
      setScannedTotal(scanned.total);
      setTruncated(scanned.truncated);
      setStatus('ready');

      // An empty script gets the defaults written into it, which is what makes
      // opening the editor enough to start from something — unticking is how
      // they are refused.
      //
      // Only an empty one. The list opens by itself now, so anything written
      // here happens to someone who has merely looked: filling a script that
      // was blank is a beginning, but adding to a script somebody wrote is
      // editing their work behind their back.
      if (current.trim() === '' && checklist.tickedPaths.length > 0) {
        writeTicks(current, checklist.entries, new Set(checklist.tickedPaths));
      }
    } catch {
      if (scanRequestRef.current !== requestId) return;
      setStatus('failed');
    }
  }, [projectId, writeTicks]);

  /**
   * Which project the list on screen belongs to.
   *
   * A ref rather than state: it guards the scan below, and a render of its own
   * would only re-run the guard it just satisfied.
   */
  const scannedProjectRef = useRef<string | null>(null);

  // Scan once the editor knows what script it holds — reading a repository is
  // cheap, but ticking the defaults into a script nobody has read yet would
  // write over it. A different project is a different list, so it scans again.
  useEffect(() => {
    if (disabled || !isOpen) return;
    if (scannedProjectRef.current === projectId) return;
    scannedProjectRef.current = projectId;
    void scan();
  }, [disabled, isOpen, projectId, scan]);

  const toggleOpen = () => setIsOpen(!isOpen);

  const toggleTick = (path: string) => {
    const next = new Set(tickedPaths);
    if (!next.delete(path)) next.add(path);
    setTickedPaths(next);
    writeTicks(script, entries, next);
  };

  const tickedCount = entries.reduce(
    (count, entry) => (tickedPaths.has(entry.path) ? count + 1 : count),
    0,
  );

  return (
    <div className="space-y-2" data-testid="ignored-file-checklist">
      <button
        type="button"
        onClick={toggleOpen}
        disabled={disabled}
        className="text-[11px] text-(--accent) hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
        data-testid="ignored-file-checklist-toggle"
      >
        {isOpen ? t('settings.preparation.checklist.close') : t('settings.preparation.checklist.open')}
      </button>

      {isOpen ? (
        <div
          className="space-y-2 rounded-md border border-(--divider) bg-(--bg-secondary) p-3"
          data-testid="ignored-file-checklist-body"
        >
          <p className="text-[11px] text-(--text-tertiary)">
            {t('settings.preparation.checklist.description')}
          </p>

          {/* `idle` is the wait before the scan may start, which to a reader is
              the same wait as the scan itself. */}
          {status === 'idle' || status === 'scanning' ? (
            <p className="text-sm text-(--text-muted)">
              {t('settings.preparation.checklist.scanning')}
            </p>
          ) : null}

          {status === 'failed' ? (
            <p className="text-sm text-(--status-warning-text)" data-testid="ignored-file-checklist-error">
              {t('settings.preparation.checklist.scanFailed')}
            </p>
          ) : null}

          {status === 'ready' && entries.length === 0 ? (
            <p className="text-sm text-(--text-muted)" data-testid="ignored-file-checklist-empty">
              {t('settings.preparation.checklist.empty')}
            </p>
          ) : null}

          {status === 'ready' && entries.length > 0 ? (
            <div className="space-y-2" data-testid="ignored-file-checklist-list">
              <ul className="max-h-64 space-y-0.5 overflow-y-auto">
                {entries.map((entry) => (
                  <li key={entry.path}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-(--sidebar-hover)">
                      <input
                        type="checkbox"
                        checked={tickedPaths.has(entry.path)}
                        onChange={() => toggleTick(entry.path)}
                        className="shrink-0 accent-(--accent)"
                        data-testid={`ignored-file-tick-${entry.path}`}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-(--text-primary)">
                        {entry.isDirectory ? `${entry.path}/` : entry.path}
                      </span>
                      <span className="shrink-0 text-[10px] text-(--text-tertiary)">
                        {entry.inScriptOnly
                          ? t('settings.preparation.checklist.inScriptOnly')
                          : t(`settings.preparation.checklist.kind.${entry.kind}`)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>

              {truncated ? (
                <p className="text-[11px] text-(--text-tertiary)">
                  {t('settings.preparation.checklist.truncated', {
                    count: entries.length,
                    total: scannedTotal,
                  })}
                </p>
              ) : null}

              <span className="block text-[11px] text-(--text-tertiary)">
                {t('settings.preparation.checklist.selected', { count: tickedCount })}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

