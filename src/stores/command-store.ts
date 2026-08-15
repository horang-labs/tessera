import { create } from 'zustand';

export interface CommandInfo {
  name: string;
  description: string;
}

interface CommandState {
  /** Commands per session (from CLI initialize response) */
  commands: Record<string, CommandInfo[]>;
  /** Provider invalidation revision per session. */
  revisions: Record<string, number>;
  /** Global invalidation revision for settings that affect every catalog. */
  catalogRevision: number;
  setCommands: (sessionId: string, commands: CommandInfo[]) => void;
  getCommands: (sessionId: string) => CommandInfo[];
  invalidateSession: (sessionId: string) => void;
  invalidateAll: () => void;
  clearSession: (sessionId: string) => void;
}

export const useCommandStore = create<CommandState>((set, get) => ({
  commands: {},
  revisions: {},
  catalogRevision: 0,
  setCommands: (sessionId, commands) =>
    set((s) => ({ commands: { ...s.commands, [sessionId]: commands } })),
  getCommands: (sessionId) => get().commands[sessionId] ?? [],
  invalidateSession: (sessionId) =>
    set((s) => {
      const { [sessionId]: _, ...commands } = s.commands;
      return {
        commands,
        revisions: {
          ...s.revisions,
          [sessionId]: (s.revisions[sessionId] ?? 0) + 1,
        },
      };
    }),
  invalidateAll: () =>
    set((s) => ({
      commands: {},
      catalogRevision: s.catalogRevision + 1,
    })),
  clearSession: (sessionId) =>
    set((s) => {
      const { [sessionId]: _, ...commands } = s.commands;
      const { [sessionId]: __, ...revisions } = s.revisions;
      return { commands, revisions };
    }),
}));
