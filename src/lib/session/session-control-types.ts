export type ProviderSessionMode = 'work' | 'build' | 'plan';

export type ProviderSessionAccessMode =
  | 'default'
  | 'acceptEdits'
  | 'dontAsk'
  | 'bypassPermissions'
  | 'readOnly'
  | 'ask'
  | 'auto'
  | 'fullAccess'
  | 'opencodeDefault'
  | 'opencodeAskChanges'
  | 'opencodeReadOnly'
  | 'opencodeAllowAll';

export type CodexCollaborationMode = 'default' | 'plan';
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface ProviderRuntimeControls {
  sessionMode?: ProviderSessionMode;
  accessMode?: ProviderSessionAccessMode;
  collaborationMode?: CodexCollaborationMode;
  approvalPolicy?: CodexApprovalPolicy;
  sandboxMode?: CodexSandboxMode;
  serviceTier?: string | null;
}
