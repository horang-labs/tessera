import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useCommandStore, type CommandInfo } from '@/stores/command-store';
import { wsClient } from '@/lib/ws/client';
import {
  CODEX_FAST_BUILTIN_COMMAND,
  CODEX_FAST_COMMAND_DESCRIPTION,
  CODEX_FAST_COMMAND_NAME,
} from '@/lib/chat/codex-fast-command';

export type SkillInfo = CommandInfo & {
  builtinCommand?: typeof CODEX_FAST_BUILTIN_COMMAND;
};

interface UseSkillPickerReturn {
  isOpen: boolean;
  isLoading: boolean;
  isInactive: boolean;
  filteredSkills: SkillInfo[];
  selectedIndex: number;
  selectedSkill: SkillInfo | null;
  onInputChange: (value: string) => void;
  /** Confirm the currently highlighted skill. Returns the selected skill when one was selected. */
  confirm: () => SkillInfo | null;
  /** Programmatically select a skill (e.g. on click). */
  selectSkill: (skill: SkillInfo) => void;
  clearSkill: () => void;
  navigateUp: () => void;
  navigateDown: () => void;
  close: () => void;
  /** Parse input on send: returns { skillName, content } using selectedSkill or manual /prefix */
  parseForSend: (input: string) => { skillName: string; content: string } | null;
}

export function useSkillPicker(
  sessionId?: string,
  providerId?: string,
  isSessionRunning?: boolean,
): UseSkillPickerReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [filteredSkills, setFilteredSkills] = useState<SkillInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedSkill, setSelectedSkill] = useState<SkillInfo | null>(null);
  const setCommands = useCommandStore((s) => s.setCommands);

  // Reactive subscription to command store
  const commands = useCommandStore(
    (s) => (sessionId ? s.commands[sessionId] : undefined),
  );
  const builtInCommands = useMemo<SkillInfo[]>(
    () => providerId === 'codex'
      ? [{
          name: CODEX_FAST_COMMAND_NAME,
          description: CODEX_FAST_COMMAND_DESCRIPTION,
          builtinCommand: CODEX_FAST_BUILTIN_COMMAND,
        }]
      : [],
    [providerId],
  );
  const availableCommands = useMemo<SkillInfo[]>(() => {
    const merged = [...builtInCommands];
    for (const command of commands ?? []) {
      if (merged.some((candidate) => candidate.name === command.name)) {
        continue;
      }
      merged.push(command);
    }
    return merged;
  }, [builtInCommands, commands]);
  const hasLoadedCommands = commands !== undefined;
  const hasBuiltInCommands = builtInCommands.length > 0;
  const isInactive = isOpen && !hasLoadedCommands && !hasBuiltInCommands && isSessionRunning === false;
  const isLoading = isOpen && !hasLoadedCommands && !hasBuiltInCommands && !isInactive;

  // Track the last input value so we can re-filter when commands arrive
  const lastInputRef = useRef('');
  const loadPromiseRef = useRef<Promise<void> | null>(null);

  const loadProviderSkills = useCallback(async () => {
    if (!sessionId || !providerId || loadPromiseRef.current) {
      return loadPromiseRef.current ?? Promise.resolve();
    }

    const task = (async () => {
      if (providerId === 'claude-code' || providerId === 'opencode') {
        if (isSessionRunning !== false) {
          wsClient.getCommands(sessionId);
        }
        return;
      }

      if (isSessionRunning === false) {
        return;
      }

      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/skills`);
        if (!response.ok) {
          throw new Error(`Failed to load skills: ${response.status}`);
        }

        const data = await response.json();
        const skills = Array.isArray(data.skills)
          ? data.skills
              .filter((skill: any) => skill && typeof skill.name === 'string')
              .map((skill: any) => ({
                name: skill.name as string,
                description: typeof skill.description === 'string' ? skill.description : '',
              }))
          : [];

        setCommands(sessionId, skills);
      } catch {
        setCommands(sessionId, []);
      }
    })();

    loadPromiseRef.current = task;
    try {
      await task;
    } finally {
      loadPromiseRef.current = null;
    }
  }, [isSessionRunning, providerId, sessionId, setCommands]);

  useEffect(() => {
    if (!sessionId || !providerId || hasLoadedCommands) return;
    if (isSessionRunning === false) return;
    void loadProviderSkills();
  }, [hasLoadedCommands, isSessionRunning, loadProviderSkills, providerId, sessionId]);

  const filterAndShow = useCallback(
    (value: string, list: SkillInfo[]) => {
      const query = value.slice(1).toLowerCase();
      const filtered = query
        ? list.filter(
            (s) =>
              s.name.toLowerCase().includes(query) ||
              s.description.toLowerCase().includes(query),
          )
        : [...list];

      if (query) {
        filtered.sort((a, b) => {
          const aName = a.name.toLowerCase();
          const bName = b.name.toLowerCase();
          const aExact = aName === query;
          const bExact = bName === query;
          if (aExact !== bExact) return aExact ? -1 : 1;
          const aStarts = aName.startsWith(query);
          const bStarts = bName.startsWith(query);
          if (aStarts !== bStarts) return aStarts ? -1 : 1;
          const aNameMatch = aName.includes(query);
          const bNameMatch = bName.includes(query);
          if (aNameMatch !== bNameMatch) return aNameMatch ? -1 : 1;
          return aName.localeCompare(bName);
        });
      }

      setFilteredSkills(filtered);
      setSelectedIndex(0);
      setIsOpen(true);
    },
    [],
  );

  // When commands first arrive while picker is in loading state, auto-populate
  const prevCommandsRef = useRef<CommandInfo[] | undefined>(undefined);
  useEffect(() => {
    const wasEmpty = !prevCommandsRef.current || prevCommandsRef.current.length === 0;
    prevCommandsRef.current = commands;
    // Only trigger on transition from empty → populated
    if (!wasEmpty) return;
    if (!commands || availableCommands.length === 0) return;
    const input = lastInputRef.current;
    if (!input.startsWith('/') || input.indexOf(' ') !== -1) return;
    if (selectedSkill) return;
    filterAndShow(input, availableCommands);
  }, [availableCommands, commands, selectedSkill, filterAndShow]);

  const selectSkill = useCallback((skill: SkillInfo) => {
    setSelectedSkill(skill);
    setIsOpen(false);
  }, []);

  const clearSkill = useCallback(() => {
    setSelectedSkill(null);
  }, []);

  const onInputChange = useCallback(
    (value: string) => {
      lastInputRef.current = value;

      if (selectedSkill) {
        setIsOpen(false);
        return;
      }

      if (!value.startsWith('/') || value.indexOf(' ') !== -1) {
        setIsOpen(false);
        return;
      }

      if (!commands && availableCommands.length === 0) {
        // Commands not yet received and there are no built-ins — show loading state
        setFilteredSkills([]);
        setSelectedIndex(0);
        setIsOpen(true);
        void loadProviderSkills();
        return;
      }

      if (!commands) {
        void loadProviderSkills();
      }

      if (availableCommands.length === 0) {
        setFilteredSkills([]);
        setSelectedIndex(0);
        setIsOpen(false);
        return;
      }

      filterAndShow(value, availableCommands);
    },
    [selectedSkill, commands, availableCommands, filterAndShow, loadProviderSkills],
  );

  const confirm = useCallback((): SkillInfo | null => {
    if (!isOpen || filteredSkills.length === 0) return null;
    const skill = filteredSkills[selectedIndex];
    if (!skill) return null;
    setSelectedSkill(skill);
    setIsOpen(false);
    return skill;
  }, [isOpen, filteredSkills, selectedIndex]);

  const navigateUp = useCallback(() => {
    setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
  }, []);

  const navigateDown = useCallback(() => {
    setSelectedIndex((prev) =>
      prev < filteredSkills.length - 1 ? prev + 1 : prev,
    );
  }, [filteredSkills.length]);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const parseForSend = useCallback(
    (input: string): { skillName: string; content: string } | null => {
      if (selectedSkill) {
        return { skillName: selectedSkill.name, content: input.trim() };
      }

      if (!input.startsWith('/')) return null;

      const skills = availableCommands;
      const spaceIdx = input.indexOf(' ');
      if (spaceIdx === -1) {
        const name = input.slice(1);
        const match = skills.find((s) => s.name === name);
        if (match) return { skillName: match.name, content: '' };
        return null;
      }

      const name = input.slice(1, spaceIdx);
      const match = skills.find((s) => s.name === name);
      if (!match) return null;

      const content = input.slice(spaceIdx + 1).trim();
      return { skillName: match.name, content };
    },
    [selectedSkill, availableCommands],
  );

  return {
    isOpen,
    isLoading,
    isInactive,
    filteredSkills,
    selectedIndex,
    selectedSkill,
    onInputChange,
    confirm,
    selectSkill,
    clearSkill,
    navigateUp,
    navigateDown,
    close,
    parseForSend,
  };
}
