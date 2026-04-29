'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { Image as ImageIcon, Plus, X } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import type { UserProfileSettings } from '@/lib/settings/types';
import {
  DEFAULT_PROFILE_AVATAR_DATA_URL,
  DEFAULT_PROFILE_DISPLAY_NAME,
  PROFILE_AVATAR_PRESETS,
} from '@/lib/settings/profile-defaults';

const AVATAR_SIZE = 160;
const MAX_AVATAR_SOURCE_BYTES = 8 * 1024 * 1024;

function getInitial(displayName: string, fallback: string): string {
  const source = displayName.trim() || fallback;
  return Array.from(source.trim())[0]?.toUpperCase() || 'Y';
}

function buildAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new window.Image();

    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('Canvas is unavailable');
        }

        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const side = Math.min(width, height);
        const sourceX = Math.max(0, (width - side) / 2);
        const sourceY = Math.max(0, (height - side) / 2);

        context.drawImage(
          image,
          sourceX,
          sourceY,
          side,
          side,
          0,
          0,
          AVATAR_SIZE,
          AVATAR_SIZE,
        );

        resolve(canvas.toDataURL('image/webp', 0.86));
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Image failed to load'));
    };

    image.src = objectUrl;
  });
}

export default function ProfileSettings() {
  const { t } = useI18n();
  const profile = useSettingsStore((state) => state.settings.profile);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const displayName = profile.displayName;
  const fallbackName = DEFAULT_PROFILE_DISPLAY_NAME;
  const initial = getInitial(displayName, fallbackName);
  const avatarDataUrl = profile.avatarDataUrl.trim() || DEFAULT_PROFILE_AVATAR_DATA_URL;
  const activePresetId = PROFILE_AVATAR_PRESETS.find((preset) => preset.dataUrl === avatarDataUrl)?.id;
  const canResetAvatar = avatarDataUrl !== DEFAULT_PROFILE_AVATAR_DATA_URL;

  const updateProfile = (patch: Partial<UserProfileSettings>) => {
    void updateSettings({
      profile: {
        ...profile,
        ...patch,
      },
    });
  };

  const handleAvatarChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError(t('settings.profile.avatarUnsupported'));
      return;
    }

    if (file.size > MAX_AVATAR_SOURCE_BYTES) {
      setError(t('settings.profile.avatarTooLarge'));
      return;
    }

    setError(null);
    setIsProcessing(true);
    try {
      const avatarDataUrl = await buildAvatarDataUrl(file);
      updateProfile({ avatarDataUrl });
    } catch {
      setError(t('settings.profile.avatarReadFailed'));
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-medium text-(--text-primary)">
          {t('settings.profile.title')}
        </h3>
        <p className="mt-1 text-xs text-(--text-muted)">
          {t('settings.profile.description')}
        </p>
      </div>

      <div className="flex items-start gap-4">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-(--divider) bg-(--accent) text-base font-semibold text-white shadow-sm"
          data-testid="profile-avatar-preview"
        >
          {avatarDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarDataUrl}
              alt={t('settings.profile.avatarAlt')}
              className="h-full w-full object-cover"
            />
          ) : (
            <span>{initial}</span>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="profile-display-name" className="text-sm font-medium text-(--text-secondary)">
              {t('settings.profile.displayName')}
            </label>
            <input
              id="profile-display-name"
              type="text"
              value={displayName}
              maxLength={80}
              onChange={(event) => updateProfile({ displayName: event.target.value })}
              placeholder={t('settings.profile.displayNamePlaceholder')}
              className="w-full rounded-md border border-(--input-border) bg-(--input-bg) px-3 py-2 text-sm text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent)"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleAvatarChange}
              className="sr-only"
              data-testid="profile-avatar-input"
            />
            <div className="flex flex-wrap items-center gap-2" aria-label={t('settings.profile.avatarAlt')}>
              {PROFILE_AVATAR_PRESETS.map((preset, index) => {
                const isActive = activePresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => updateProfile({ avatarDataUrl: preset.dataUrl })}
                    aria-label={`${t('settings.profile.avatarAlt')} ${index + 1}`}
                    aria-pressed={isActive}
                    data-testid={`profile-avatar-preset-${preset.id}`}
                    className={`h-10 w-10 overflow-hidden rounded-xl border transition-all ${
                      isActive
                        ? 'border-(--accent) ring-2 ring-(--accent)/35'
                        : 'border-(--divider) hover:border-(--accent)/55'
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={preset.dataUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isProcessing}
                aria-label={t('settings.profile.uploadAvatar')}
                title={t('settings.profile.uploadAvatar')}
                data-testid="profile-avatar-upload"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-(--input-border) bg-(--input-bg) text-(--text-secondary) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) disabled:cursor-wait disabled:opacity-60"
              >
                {isProcessing ? (
                  <ImageIcon className="h-4 w-4 animate-pulse" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
              </button>
            </div>
            {canResetAvatar && (
              <button
                type="button"
                onClick={() => updateProfile({ avatarDataUrl: DEFAULT_PROFILE_AVATAR_DATA_URL })}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
              >
                <X className="h-3.5 w-3.5" />
                <span>{t('settings.profile.removeAvatar')}</span>
              </button>
            )}
          </div>

          <p className="text-[11px] leading-5 text-(--text-tertiary)">
            {t('settings.profile.avatarHelp')}
          </p>
          {error && (
            <p className="text-[11px] text-(--status-error-text)" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
