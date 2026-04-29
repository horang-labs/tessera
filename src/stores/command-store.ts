import { create } from 'zustand';

export interface CommandInfo {
  name: string;
  description: string;
}

interface CommandState {
  /** Commands per session (from CLI initialize response) */
  commands: Record<string, CommandInfo[]>;
  setCommands: (sessionId: string, commands: CommandInfo[]) => void;
  getCommands: (sessionId: string) => CommandInfo[];
  clearSession: (sessionId: string) => void;
}

export const useCommandStore = create<CommandState>((set, get) => ({
  commands: {},
  setCommands: (sessionId, commands) =>
    set((s) => ({ commands: { ...s.commands, [sessionId]: commands } })),
  getCommands: (sessionId) => get().commands[sessionId] ?? [],
  clearSession: (sessionId) =>
    set((s) => {
      const { [sessionId]: _, ...rest } = s.commands;
      return { commands: rest };
    }),
}));
