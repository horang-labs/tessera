export type AgentReferenceSource = 'read' | 'search' | 'inspect';

export type AgentContextKind =
  | 'reference'
  | 'command'
  | 'verification'
  | 'issue'
  | 'task'
  | 'todo';

export type AgentContextStatus =
  | 'running'
  | 'completed'
  | 'error'
  | 'pending'
  | 'in_progress'
  | 'resolved'
  | 'active'
  | 'warning';

export interface AgentContextEvent {
  kind: AgentContextKind;
  title: string;
  detail?: string;
  meta?: string;
  status?: AgentContextStatus;
  source?: AgentReferenceSource;
  path?: string;
  command?: string;
}
