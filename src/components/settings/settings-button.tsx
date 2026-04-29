'use client';

import { Settings } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

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

  return (
    <Button
      variant="ghost"
      size={iconSize === 'lg' ? 'icon-lg' : 'icon'}
      className={className}
      onClick={openSettings}
      onFocus={preloadSettingsPanel}
      onPointerEnter={preloadSettingsPanel}
      aria-label={t('settings.title')}
      title={t('settings.title')}
    >
      <Settings className={iconSize === 'lg' ? 'w-5 h-5' : 'w-4 h-4'} />
    </Button>
  );
}
