import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useCommandStore, type CommandInfo } from '@/stores/command-store';
import { wsClient } from '@/lib/ws/client';
import {
  CODEX_FAST_BUILTIN_COMMAND,
  CODEX_FAST_COMMAND_DESCRIPTION,
  CODEX_FAST_COMMAND_NAME,
} from '@/lib/chat/codex-fast-command';
import {
  CODEX_COMPACT_BUILTIN_COMMAND,
  CODEX_COMPACT_COMMAND_DESCRIPTION,
  CODEX_COMPACT_COMMAND_NAME,
} from '@/lib/chat/codex-compact-command';
import {
  CLAUDE_FAST_BUILTIN_COMMAND,
  CLAUDE_FAST_COMMAND_DESCRIPTION,
  CLAUDE_FAST_COMMAND_NAME,
} from '@/lib/chat/claude-fast-command';
import { getTuiOnlySlashCommands } from '@/lib/terminal/tui-only-commands';
import {
  getCodexSlashCommandsForPicker,
  isReservedCodexSlashCommandName,
} from '@/lib/chat/codex-slash-command-registry';

export type SkillInfo = CommandInfo & {
  builtinCommand?:
    | typeof CODEX_FAST_BUILTIN_COMMAND
    | typeof CODEX_COMPACT_BUILTIN_COMMAND
    | typeof CLAUDE_FAST_BUILTIN_COMMAND;
  // 헤드리스 미지원(Claude TUI 전용) 명령 — 선택 시 전송이 아니라 터미널 fallback으로 실행된다.
  terminalFallback?: boolean;
  terminalRoute?: 'claude-tui' | 'codex-direct' | 'codex-handoff';
};

interface UseSkillPickerReturn {
  isOpen: boolean;
  isLoading: boolean;
  isInactive: boolean;
  isEmpty: boolean;
  filteredSkills: SkillInfo[];
  selectedIndex: number;
  selectedSkill: SkillInfo | null;
  onInputChange: (value: string) => void;
  /** Open a Codex-session view containing provider-reported skills only. */
  openSkillsOnly: () => void;
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
  /** 세션이 실제 보고한 명령(store commands) 이름 집합(소문자). 터미널 라우팅 제외 기준. */
  sessionCommandNames: ReadonlySet<string>;
}

export function useSkillPicker(
  sessionId?: string,
  providerId?: string,
  isSessionRunning?: boolean,
  codexFastAvailable = true,
  codexPlatform?: string | null,
  agentEnvironment?: string | null,
): UseSkillPickerReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [filteredSkills, setFilteredSkills] = useState<SkillInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedSkill, setSelectedSkill] = useState<SkillInfo | null>(null);
  const [skillsOnlyMode, setSkillsOnlyMode] = useState(false);
  const setCommands = useCommandStore((s) => s.setCommands);

  // Reactive subscription to command store
  const commands = useCommandStore(
    (s) => (sessionId ? s.commands[sessionId] : undefined),
  );
  const builtInCommands = useMemo<SkillInfo[]>(
    () => {
      if (providerId === 'codex') {
        return [...(codexFastAvailable ? [{
          name: CODEX_FAST_COMMAND_NAME,
          description: CODEX_FAST_COMMAND_DESCRIPTION,
          builtinCommand: CODEX_FAST_BUILTIN_COMMAND,
        } as SkillInfo] : []), {
          name: CODEX_COMPACT_COMMAND_NAME,
          description: CODEX_COMPACT_COMMAND_DESCRIPTION,
          builtinCommand: CODEX_COMPACT_BUILTIN_COMMAND,
        }];
      }
      if (providerId === 'claude-code') {
        return [{
          name: CLAUDE_FAST_COMMAND_NAME,
          description: CLAUDE_FAST_COMMAND_DESCRIPTION,
          builtinCommand: CLAUDE_FAST_BUILTIN_COMMAND,
        }];
      }
      return [];
    },
    [codexFastAvailable, providerId],
  );
  const availableCommands = useMemo<SkillInfo[]>(() => {
    const merged = [...builtInCommands];
    for (const command of commands ?? []) {
      if (providerId === 'codex' && isReservedCodexSlashCommandName(command.name)) {
        continue;
      }
      if (merged.some((candidate) => candidate.name === command.name)) {
        continue;
      }
      merged.push(command);
    }
    if (providerId === 'codex') {
      for (const command of getCodexSlashCommandsForPicker({
        platform: codexPlatform,
        agentEnvironment,
      })) {
        if (merged.some((candidate) => candidate.name === command.name)) continue;
        const isTerminal = command.support.startsWith('terminal-');
        merged.push({
          name: command.name,
          description: command.description,
          ...(isTerminal ? {
            terminalFallback: true,
            terminalRoute: command.support === 'terminal-handoff'
              ? 'codex-handoff' as const
              : 'codex-direct' as const,
          } : {}),
        });
      }
    }
    // claude-code: 헤드리스에서 동작 불가한 TUI 전용 명령(/config /agents 등)을 피커에
    // 함께 노출한다. 선택하면 전송이 아니라 터미널 fallback으로 실행된다(terminalFallback 마커).
    if (providerId === 'claude-code') {
      for (const tui of getTuiOnlySlashCommands()) {
        if (merged.some((candidate) => candidate.name === tui.name)) continue;
        merged.push({
          name: tui.name,
          description: tui.description,
          terminalFallback: true,
          terminalRoute: 'claude-tui',
        });
      }
    }
    return merged;
  }, [agentEnvironment, builtInCommands, codexPlatform, commands, providerId]);
  // 세션이 실제 보고한 명령(store commands)의 이름 집합(소문자). 터미널 라우팅에서
  // "headless 지원이면 제외" 판정의 1순위 기준으로 message-input에 노출한다.
  const sessionCommandNames = useMemo<ReadonlySet<string>>(
    () => new Set((commands ?? []).map((c) => c.name.toLowerCase())),
    [commands],
  );
  const hasLoadedCommands = commands !== undefined;
  const hasBuiltInCommands = builtInCommands.length > 0;
  const isInactive = isOpen && !hasLoadedCommands
    && (skillsOnlyMode || !hasBuiltInCommands)
    && isSessionRunning === false;
  const isLoading = isOpen && !hasLoadedCommands
    && (skillsOnlyMode || !hasBuiltInCommands)
    && !isInactive;
  const isEmpty = isOpen && skillsOnlyMode && hasLoadedCommands && filteredSkills.length === 0;

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
    const list = skillsOnlyMode
      ? (commands ?? []).filter((command) => !isReservedCodexSlashCommandName(command.name))
      : availableCommands;
    if (list.length === 0) return;
    const input = lastInputRef.current;
    if (!input.startsWith('/') || input.indexOf(' ') !== -1) return;
    if (selectedSkill) return;
    filterAndShow(input, list);
  }, [availableCommands, commands, filterAndShow, selectedSkill, skillsOnlyMode]);

  const selectSkill = useCallback((skill: SkillInfo) => {
    setSelectedSkill(skill);
    setSkillsOnlyMode(false);
    setIsOpen(false);
  }, []);

  const clearSkill = useCallback(() => {
    setSelectedSkill(null);
  }, []);

  const onInputChange = useCallback(
    (value: string) => {
      lastInputRef.current = value;

      if (selectedSkill) {
        setSkillsOnlyMode(false);
        setIsOpen(false);
        return;
      }

      if (!value.startsWith('/') || value.indexOf(' ') !== -1) {
        setSkillsOnlyMode(false);
        setIsOpen(false);
        return;
      }

      if (skillsOnlyMode) {
        if (!commands) {
          setFilteredSkills([]);
          setSelectedIndex(0);
          setIsOpen(true);
          void loadProviderSkills();
          return;
        }
        filterAndShow(
          value,
          commands.filter((command) => !isReservedCodexSlashCommandName(command.name)),
        );
        return;
      }

      setSkillsOnlyMode(false);

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
    [
      availableCommands,
      commands,
      filterAndShow,
      loadProviderSkills,
      selectedSkill,
      skillsOnlyMode,
    ],
  );

  const openSkillsOnly = useCallback(() => {
    lastInputRef.current = '/';
    setSelectedSkill(null);
    setSkillsOnlyMode(true);
    if (commands !== undefined) {
      filterAndShow('/', commands.filter((command) => !isReservedCodexSlashCommandName(command.name)));
      return;
    }
    setFilteredSkills([]);
    setSelectedIndex(0);
    setIsOpen(true);
    void loadProviderSkills();
  }, [commands, filterAndShow, loadProviderSkills]);

  const confirm = useCallback((): SkillInfo | null => {
    if (!isOpen || filteredSkills.length === 0) return null;
    const skill = filteredSkills[selectedIndex];
    if (!skill) return null;
    setSelectedSkill(skill);
    setSkillsOnlyMode(false);
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
    setSkillsOnlyMode(false);
    setIsOpen(false);
  }, []);

  const parseForSend = useCallback(
    (input: string): { skillName: string; content: string } | null => {
      // terminalFallback 마커가 selectedSkill로 남아 있으면(confirm 후 미정리) 실제
      // 스킬로 전송하지 않는다 — null을 반환해 일반 전송/터미널 경로로 위임한다.
      if (selectedSkill && !selectedSkill.terminalFallback) {
        return { skillName: selectedSkill.name, content: input.trim() };
      }

      if (!input.startsWith('/')) return null;

      const skills = availableCommands;
      const spaceIdx = input.indexOf(' ');
      if (spaceIdx === -1) {
        const name = input.slice(1);
        // terminalFallback 항목은 실제 전송 명령이 아니라 터미널 라우팅 마커이므로
        // 정상 명령 매칭에서 제외한다 — 그래야 handleSend의 `!parsed` fallback이 탄다.
        const match = skills.find((s) => s.name === name && !s.terminalFallback);
        if (match) return { skillName: match.name, content: '' };
        return null;
      }

      const name = input.slice(1, spaceIdx);
      const match = skills.find((s) => s.name === name && !s.terminalFallback);
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
    isEmpty,
    filteredSkills,
    selectedIndex,
    selectedSkill,
    onInputChange,
    openSkillsOnly,
    confirm,
    selectSkill,
    clearSkill,
    navigateUp,
    navigateDown,
    close,
    parseForSend,
    sessionCommandNames,
  };
}
