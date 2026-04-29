export interface RateLimitWindowSnapshot {
  key: string;
  usedPercent: number;
  resetsAt: string | null;
  windowDurationMins: number | null;
  label?: string | null;
  shortLabel?: string | null;
}

export interface ProviderRateLimitsSnapshot {
  providerId: string;
  windows: RateLimitWindowSnapshot[];
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  updatedAt?: string;
}

export interface StatusDisplayUsageModel {
  hasData: boolean;
  hasContextWindow: boolean;
  usedPercent: number;
  contextWindow: number;
  currentUsage: number;
  severity: 'normal' | 'warning' | 'danger';
}

export interface StatusDisplayLimitWindow {
  key: string;
  label: string;
  shortLabel: string;
  usedPercent: number;
  resetsAt: string | null;
  severity: 'normal' | 'warning' | 'danger';
}

export interface StatusDisplayModel {
  providerId: string;
  usage: StatusDisplayUsageModel | null;
  limits: StatusDisplayLimitWindow[];
}
