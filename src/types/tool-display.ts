export interface ShellCommandDisplay {
  displayCommand: string;
  commandName?: string;
  argumentsText?: string;
  cwd?: string;
  rawCommand?: string;
  processId?: string;
}

export interface ToolDisplayMetadata {
  shellCommand?: ShellCommandDisplay;
}
