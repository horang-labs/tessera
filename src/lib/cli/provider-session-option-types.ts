import type { PermissionMode } from '@/lib/ws/message-types';
import type { ProviderSessionAccessMode, ProviderSessionMode } from '@/lib/session/session-control-types';

export interface ProviderReasoningEffortOption {
  value: string;
  label: string;
  description: string;
}

export interface ProviderServiceTierOption {
  value: string;
  label: string;
  description: string;
}

export interface ProviderModelOption {
  value: string;
  label: string;
  description?: string;
  isDefault: boolean;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts: ProviderReasoningEffortOption[];
  serviceTiers?: ProviderServiceTierOption[];
}

export interface ProviderPermissionMapping {
  value: PermissionMode;
  label: string;
  description: string;
  mappedLabel?: string;
  isExact: boolean;
  note?: string;
}

export interface ProviderModeOption {
  value: ProviderSessionMode;
  label: string;
  description: string;
}

export interface ProviderAccessOption {
  value: ProviderSessionAccessMode;
  label: string;
  description: string;
}

export interface ProviderSessionOptions {
  providerId: string;
  displayName: string;
  supportsReasoningEffort: boolean;
  /**
   * Whether effort can be changed at runtime (mid-session).
   * true  → provider supports live effort changes, header shows interactive dropdown.
   * false → effort is set at spawn or unsupported, header shows read-only badge when applicable.
   */
  runtimeEffortChange: boolean;
  /**
   * Whether access/permission presets can be changed while a CLI process is running.
   * true/undefined → runtime control is available.
   * false          → preset is applied only when the provider process starts.
   */
  runtimeAccessChange?: boolean;
  modelOptions: ProviderModelOption[];
  permissionMappings: ProviderPermissionMapping[];
  permissionModeNote?: string;
  modeOptions: ProviderModeOption[];
  accessOptions: ProviderAccessOption[];
  planLocksAccess: boolean;
  planAccessLabel?: string;
}

export interface CodexModelEntry {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts?: Array<{
    reasoningEffort?: string;
    description?: string;
  }>;
  serviceTiers?: Array<{
    id?: string;
    name?: string;
    description?: string;
  }>;
}

export interface CodexModelResponse {
  data?: CodexModelEntry[];
  models?: CodexModelEntry[];
}
