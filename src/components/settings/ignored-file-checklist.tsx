'use client';

import { useCallback, useRef, useState } from 'react';
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
  /** Hands back the script with its block rewritten from the ticks. */
  onConfirm: (nextScript: string) => void;
}

/**
 * Fills the preparation script in from the files git ignores.
 *
 * It expands under the editor rather than opening on top of it: the settings
 * panel is a modal already, and inline means the rewritten block is visible in
 * the editor the moment it is confirmed.
 */
export default function IgnoredFileChecklist({
  projectId,
  script,
  onConfirm,
}: IgnoredFileChecklistProps) {
  const { t } = useI18n();

  const [isOpen, setIsOpen] = useState(false);
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

      const checklist = buildIgnoredFileChecklist(scanned.candidates, scriptRef.current);
      setEntries(checklist.entries);
      setTickedPaths(new Set(checklist.tickedPaths));
      setScannedTotal(scanned.total);
      setTruncated(scanned.truncated);
      setStatus('ready');
    } catch {
      if (scanRequestRef.current !== requestId) return;
      setStatus('failed');
    }
  }, [projectId]);

  const toggleOpen = () => {
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    setIsOpen(true);
    // The scan runs on expanding, not on opening the settings panel: nobody
    // pays for reading a repository they were not asking about.
    void scan();
  };

  const toggleTick = (path: string) => {
    setTickedPaths((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };

  const confirm = () => {
    const ticked = entries.filter((entry) => tickedPaths.has(entry.path));
    onConfirm(rewriteCopyBlock(script, ticked.map(({ path, isDirectory }) => ({ path, isDirectory }))));
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
        className="text-[11px] text-(--accent) hover:underline"
        data-testid="ignored-file-checklist-toggle"
      >
        {isOpen ? t('settings.preparation.checklist.close') : t('settings.preparation.checklist.open')}
      </button>

      {isOpen ? (
        <div className="space-y-2 rounded-md border border-(--divider) bg-(--bg-secondary) p-3">
          <p className="text-[11px] text-(--text-tertiary)">
            {t('settings.preparation.checklist.description')}
          </p>

          {status === 'scanning' ? (
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
            <>
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

              <div className="flex items-center justify-between gap-3 pt-1">
                <span className="text-[11px] text-(--text-tertiary)">
                  {t('settings.preparation.checklist.selected', { count: tickedCount })}
                </span>
                <button
                  type="button"
                  onClick={confirm}
                  className="rounded-md bg-(--accent) px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-(--accent-hover)"
                  data-testid="ignored-file-checklist-confirm"
                >
                  {t('settings.preparation.checklist.confirm')}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

