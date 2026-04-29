import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * @-mention reference picker. Triggered by `@` at input start or right after whitespace.
 *
 * Sections (flat indexing across all of them):
 *  - files — project files from fs walk; confirm → insert `@path ` literal text
 *  - chats — user's independent chat sessions in the project (task_id IS NULL)
 *  - tasks — sessions that belong to a task (task_id IS NOT NULL)
 *
 * For chat/task selections the picker only strips the `@query` token from
 * the textarea; the caller wires selection to `useSessionRefs.addSessionRef`
 * which exports the session and inserts a `[📎 N]` placeholder at the cursor.
 */

export type ReferenceKind = 'file' | 'chat' | 'task';

export interface ReferenceMatch {
  kind: ReferenceKind;
  /** Display label in the picker row. For files it's the basename; for sessions it's the title. */
  label: string;
  /** Sub-label (parent dir for files, empty for sessions). */
  sublabel: string;
  /** For files: relative path. For sessions: sessionId. */
  value: string;
  score: number;
}

/** Export alias kept for backwards compatibility with the previous hook name. */
export type FilePickerMatch = ReferenceMatch;

interface ReferenceCache {
  files: string[];
  chats: Array<{ sessionId: string; title: string }>;
  tasks: Array<{ sessionId: string; title: string }>;
  loadedAt: number;
  truncated: boolean;
}

const CACHE_TTL_MS = 60_000;
const MAX_RESULTS_PER_SECTION = 10;
const MAX_QUERY_LEN = 256;

/**
 * Returns { start, query } if the caret sits inside an `@query` token, else null.
 *
 * The `@` is considered a trigger when preceded by the start of input or by any
 * non-word, non-`@` character. This allows triggering right after session
 * placeholders like `[📎 1]@foo` while still suppressing it inside email-like
 * patterns (`foo@bar` — the character before `@` is a word character).
 *
 * Whitespace inside the query is allowed (session titles often contain spaces),
 * but the first character after `@` must be non-whitespace — otherwise typing
 * `@` followed by a space would keep the picker open with an empty leading-space
 * query. The picker is closed by the caller when matches drop to zero.
 */
export function detectAtTrigger(value: string, cursor: number): { start: number; query: string } | null {
  if (cursor < 0 || cursor > value.length) return null;
  const before = value.slice(0, cursor);
  const m = before.match(/(^|[^\w@])@(\S[^@]{0,255})?$/u);
  if (!m) return null;
  const query = m[2] ?? '';
  const start = cursor - query.length - 1;
  return { start, query };
}

/** Subsequence fuzzy scorer: basename/prefix bias, short strings preferred. */
function scoreText(candidate: string, query: string): number | null {
  if (!query) return 0;
  const lowerC = candidate.toLowerCase();
  const lowerQ = query.toLowerCase();
  let qi = 0;
  let streak = 0;
  let streakBonus = 0;
  for (let i = 0; i < lowerC.length && qi < lowerQ.length; i++) {
    if (lowerC[i] === lowerQ[qi]) {
      qi++;
      streak++;
      streakBonus += streak;
    } else {
      streak = 0;
    }
  }
  if (qi < lowerQ.length) return null;

  let score = streakBonus;
  if (lowerC === lowerQ) score += 1000;
  else if (lowerC.startsWith(lowerQ)) score += 400;
  else if (lowerC.includes(lowerQ)) score += 200;
  score -= candidate.length * 0.1;
  return score;
}

function filterFiles(files: string[], query: string, limit: number): ReferenceMatch[] {
  if (!query) {
    return files.slice(0, limit).map((p) => {
      const slash = p.lastIndexOf('/');
      return {
        kind: 'file' as const,
        label: slash >= 0 ? p.slice(slash + 1) : p,
        sublabel: slash >= 0 ? p.slice(0, slash) : '',
        value: p,
        score: 0,
      };
    });
  }
  const scored: ReferenceMatch[] = [];
  for (const p of files) {
    const slash = p.lastIndexOf('/');
    const basename = slash >= 0 ? p.slice(slash + 1) : p;
    // Score against full path but bias if basename matches
    const pathScore = scoreText(p, query);
    if (pathScore == null) continue;
    const baseScore = scoreText(basename, query);
    const combined = pathScore + (baseScore ?? 0) * 2;
    scored.push({
      kind: 'file',
      label: basename,
      sublabel: slash >= 0 ? p.slice(0, slash) : '',
      value: p,
      score: combined,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return scored.slice(0, limit);
}

function filterSessions(
  kind: 'chat' | 'task',
  items: Array<{ sessionId: string; title: string }>,
  query: string,
  limit: number,
): ReferenceMatch[] {
  if (!query) {
    return items.slice(0, limit).map((s) => ({
      kind,
      label: s.title,
      sublabel: '',
      value: s.sessionId,
      score: 0,
    }));
  }
  const scored: ReferenceMatch[] = [];
  for (const s of items) {
    const score = scoreText(s.title, query);
    if (score == null) continue;
    scored.push({ kind, label: s.title, sublabel: '', value: s.sessionId, score });
  }
  scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return scored.slice(0, limit);
}

interface UseReferencePickerReturn {
  isOpen: boolean;
  isLoading: boolean;
  /** Flat list across sections, indexed for keyboard nav. */
  results: ReferenceMatch[];
  /** Section boundaries in `results`: [filesEnd, chatsEnd, tasksEnd]. */
  sectionBoundaries: { files: [number, number]; chats: [number, number]; tasks: [number, number] };
  selectedIndex: number;
  triggerStart: number | null;
  onInputChange: (value: string, cursor: number) => void;
  /**
   * Confirm selection. Returns the new textarea value/cursor with the
   * `@query` token stripped, plus the picked reference so the caller can
   * perform kind-specific follow-up (insert file path vs add session ref).
   */
  confirm: () => { newValue: string; newCursor: number; picked: ReferenceMatch } | null;
  selectAt: (index: number) => { newValue: string; newCursor: number; picked: ReferenceMatch } | null;
  navigateUp: () => void;
  navigateDown: () => void;
  close: () => void;
}

export function useReferencePicker(sessionId: string): UseReferencePickerReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [triggerStart, setTriggerStart] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [cache, setCache] = useState<ReferenceCache | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastValueRef = useRef('');

  useEffect(() => {
    setCache(null);
    setIsOpen(false);
    setTriggerStart(null);
    setQuery('');
  }, [sessionId]);

  const loadRefs = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    const now = Date.now();
    if (cache && now - cache.loadedAt < CACHE_TTL_MS) return;

    const task = (async () => {
      setIsLoading(true);
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files`);
        if (!res.ok) {
          setCache({ files: [], chats: [], tasks: [], loadedAt: Date.now(), truncated: false });
          return;
        }
        const data = (await res.json()) as {
          files?: string[];
          chats?: Array<{ sessionId: string; title: string }>;
          tasks?: Array<{ sessionId: string; title: string }>;
          truncated?: boolean;
        };
        setCache({
          files: Array.isArray(data.files) ? data.files : [],
          chats: Array.isArray(data.chats) ? data.chats : [],
          tasks: Array.isArray(data.tasks) ? data.tasks : [],
          loadedAt: Date.now(),
          truncated: !!data.truncated,
        });
      } catch {
        setCache({ files: [], chats: [], tasks: [], loadedAt: Date.now(), truncated: false });
      } finally {
        setIsLoading(false);
      }
    })();
    inFlightRef.current = task;
    try {
      await task;
    } finally {
      inFlightRef.current = null;
    }
  }, [sessionId, cache]);

  const { results, sectionBoundaries } = useMemo(() => {
    if (!cache) {
      return {
        results: [] as ReferenceMatch[],
        sectionBoundaries: {
          files: [0, 0] as [number, number],
          chats: [0, 0] as [number, number],
          tasks: [0, 0] as [number, number],
        },
      };
    }
    const files = filterFiles(cache.files, query, MAX_RESULTS_PER_SECTION);
    const chats = filterSessions('chat', cache.chats, query, MAX_RESULTS_PER_SECTION);
    const tasks = filterSessions('task', cache.tasks, query, MAX_RESULTS_PER_SECTION);
    const flat = [...files, ...chats, ...tasks];
    return {
      results: flat,
      sectionBoundaries: {
        files: [0, files.length] as [number, number],
        chats: [files.length, files.length + chats.length] as [number, number],
        tasks: [files.length + chats.length, flat.length] as [number, number],
      },
    };
  }, [cache, query]);

  const onInputChange = useCallback(
    (value: string, cursor: number) => {
      lastValueRef.current = value;
      const hit = detectAtTrigger(value, cursor);
      if (!hit) {
        if (isOpen) setIsOpen(false);
        setTriggerStart(null);
        return;
      }
      if (hit.query.length > MAX_QUERY_LEN) {
        setIsOpen(false);
        setTriggerStart(null);
        return;
      }
      setTriggerStart(hit.start);
      setQuery(hit.query);
      setSelectedIndex(0);
      setIsOpen(true);
      if (!cache) void loadRefs();
    },
    [cache, isOpen, loadRefs],
  );

  const stripTriggerToken = useCallback((): { newValue: string; newCursor: number } | null => {
    if (triggerStart == null) return null;
    const current = lastValueRef.current;
    const before = current.slice(0, triggerStart);
    const afterStart = triggerStart + 1 + query.length;
    const after = current.slice(afterStart);
    return { newValue: before + after, newCursor: before.length };
  }, [triggerStart, query]);

  const buildResult = useCallback(
    (picked: ReferenceMatch): { newValue: string; newCursor: number; picked: ReferenceMatch } | null => {
      if (picked.kind === 'file') {
        // File: replace @query with @path + trailing space
        if (triggerStart == null) return null;
        const current = lastValueRef.current;
        const before = current.slice(0, triggerStart);
        const afterStart = triggerStart + 1 + query.length;
        const after = current.slice(afterStart);
        const insertion = `@${picked.value} `;
        return {
          newValue: before + insertion + after,
          newCursor: (before + insertion).length,
          picked,
        };
      }
      // Session (chat/task): strip the @query token; caller adds session ref
      const stripped = stripTriggerToken();
      if (!stripped) return null;
      return { ...stripped, picked };
    },
    [triggerStart, query, stripTriggerToken],
  );

  const confirm = useCallback(() => {
    if (!isOpen || results.length === 0) return null;
    const picked = results[selectedIndex] ?? results[0];
    const r = buildResult(picked);
    if (r) {
      setIsOpen(false);
      setTriggerStart(null);
      setQuery('');
    }
    return r;
  }, [isOpen, results, selectedIndex, buildResult]);

  const selectAt = useCallback(
    (index: number) => {
      const picked = results[index];
      if (!picked) return null;
      const r = buildResult(picked);
      if (r) {
        setIsOpen(false);
        setTriggerStart(null);
        setQuery('');
      }
      return r;
    },
    [results, buildResult],
  );

  const navigateUp = useCallback(() => {
    setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
  }, []);
  const navigateDown = useCallback(() => {
    setSelectedIndex((prev) => (prev < results.length - 1 ? prev + 1 : prev));
  }, [results.length]);
  const close = useCallback(() => {
    setIsOpen(false);
    setTriggerStart(null);
  }, []);

  // Hide the picker when the user has typed a non-empty query that matches
  // nothing — that's the signal they've moved on from a mention into plain
  // text. Keep it open while loading or while the query is empty so the user
  // sees the full list right after typing `@`.
  const effectiveOpen = isOpen && (query.length === 0 || isLoading || results.length > 0);

  return {
    isOpen: effectiveOpen,
    isLoading,
    results,
    sectionBoundaries,
    selectedIndex,
    triggerStart,
    onInputChange,
    confirm,
    selectAt,
    navigateUp,
    navigateDown,
    close,
  };
}

// Backwards compatibility: expose the old hook name.
export const useFilePicker = useReferencePicker;
