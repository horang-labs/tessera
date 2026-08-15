'use client';

import { Settings } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { isUpdateVisible, useUpdateStore } from '@/stores/update-store';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { settingsTelemetryClickAttributes } from '@/lib/telemetry/ui-click';

interface SettingsButtonProps {
  className?: string;
  iconSize?: 'default' | 'lg';
}

function preloadSettingsPanel() {
  void import('./settings-panel');
}

export default function SettingsButton({ className, iconSize = 'default' }: SettingsButtonProps) {
  const { t } = useI18n();
  const openSettings = useSettingsStore((state) => state.open);
  const hasUpdate = useUpdateStore(isUpdateVisible);

  return (
    <Button
      {...settingsTelemetryClickAttributes('settings.open')}
      variant="ghost"
      size={iconSize === 'lg' ? 'icon-lg' : 'icon'}
      className={cn('relative', className)}
      // Called with no arguments on purpose: the click event is not a request
      // for a section, and passing it through would read as one.
      onClick={() => openSettings()}
      onFocus={preloadSettingsPanel}
      onPointerEnter={preloadSettingsPanel}
      aria-label={t('settings.title')}
      title={t('settings.title')}
    >
      <Settings className={iconSize === 'lg' ? 'w-5 h-5' : 'w-4 h-4'} />
      {hasUpdate && (
        <span
          className="absolute right-2 top-2 h-2 w-2 rounded-full bg-(--warning) ring-2 ring-(--sidebar-bg)"
          aria-hidden="true"
        />
      )}
    </Button>
  );
}
