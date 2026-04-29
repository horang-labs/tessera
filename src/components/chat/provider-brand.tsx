'use client';

import type { CSSProperties, ReactElement, SVGProps } from 'react';
import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';

type ProviderBrandTone = {
  avatarBg: string;
  avatarFg: string;
  softBg: string;
  softBorder: string;
  icon: string;
};

type ProviderBrandMeta = {
  id: string;
  label: string;
  displayName: string;
  tone: ProviderBrandTone;
  Icon: (props: SVGProps<SVGSVGElement>) => ReactElement;
};

const DEFAULT_TONE: ProviderBrandTone = {
  avatarBg: '#475569',
  avatarFg: '#F8FAFC',
  softBg: 'rgba(100, 116, 139, 0.12)',
  softBorder: 'rgba(100, 116, 139, 0.24)',
  icon: '#94A3B8',
};

function ClaudeLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <circle cx="12" cy="4.1" r="1.85" fill="currentColor" />
      <circle cx="17.6" cy="6.4" r="1.85" fill="currentColor" opacity="0.94" />
      <circle cx="19.9" cy="12" r="1.85" fill="currentColor" opacity="0.9" />
      <circle cx="17.6" cy="17.6" r="1.85" fill="currentColor" opacity="0.94" />
      <circle cx="12" cy="19.9" r="1.85" fill="currentColor" />
      <circle cx="6.4" cy="17.6" r="1.85" fill="currentColor" opacity="0.94" />
      <circle cx="4.1" cy="12" r="1.85" fill="currentColor" opacity="0.9" />
      <circle cx="6.4" cy="6.4" r="1.85" fill="currentColor" opacity="0.94" />
      <circle cx="12" cy="12" r="2.35" fill="currentColor" />
    </svg>
  );
}

function CodexLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M8 6.5 4.25 12 8 17.5"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16 6.5 19.75 12 16 17.5"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m13.7 5.25-3.4 13.5"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GenericBotLogo(props: SVGProps<SVGSVGElement>) {
  return <Bot {...props} />;
}

const PROVIDER_BRANDS: Record<string, ProviderBrandMeta> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude',
    displayName: 'Claude Code',
    tone: {
      avatarBg: '#C97755',
      avatarFg: '#FFF7ED',
      softBg: 'rgba(201, 119, 85, 0.12)',
      softBorder: 'rgba(201, 119, 85, 0.24)',
      icon: '#D38A67',
    },
    Icon: ClaudeLogo,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    displayName: 'Codex',
    tone: {
      avatarBg: '#0F172A',
      avatarFg: '#EFF6FF',
      softBg: 'rgba(59, 130, 246, 0.1)',
      softBorder: 'rgba(59, 130, 246, 0.22)',
      icon: '#60A5FA',
    },
    Icon: CodexLogo,
  },
};

function humanizeProviderId(providerId?: string): string {
  const normalized = providerId?.trim();
  if (!normalized) return 'Agent';

  return normalized
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function getProviderBrand(providerId?: string): ProviderBrandMeta {
  const normalized = providerId?.trim();
  if (!normalized) {
    return {
      id: 'unknown',
      label: 'Agent',
      displayName: 'Agent',
      tone: DEFAULT_TONE,
      Icon: GenericBotLogo,
    };
  }

  const brand = PROVIDER_BRANDS[normalized];
  if (brand) return brand;

  return {
    id: normalized,
    label: humanizeProviderId(normalized),
    displayName: humanizeProviderId(normalized),
    tone: DEFAULT_TONE,
    Icon: GenericBotLogo,
  };
}

export function ProviderLogoIcon({
  providerId,
  className,
  style,
}: {
  providerId?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const { Icon } = getProviderBrand(providerId);
  return <Icon className={className} style={style} aria-hidden="true" />;
}

export function ProviderBadge({
  providerId,
  className,
  fullLabel = false,
}: {
  providerId?: string;
  className?: string;
  fullLabel?: boolean;
}) {
  const brand = getProviderBrand(providerId);

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap',
        'text-(--text-secondary)',
        className
      )}
      style={{
        backgroundColor: brand.tone.softBg,
        borderColor: brand.tone.softBorder,
      }}
    >
      <ProviderLogoIcon
        providerId={providerId}
        className="h-3 w-3 shrink-0"
        style={{ color: brand.tone.icon }}
      />
      <span>{fullLabel ? brand.displayName : brand.label}</span>
    </span>
  );
}
