'use client';

import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings-store';
import type { WindowsCloseBehavior } from '@/lib/settings/types';
import { useI18n } from '@/lib/i18n';
import { telemetryClickAttributes, telemetryIgnoreAttributes } from '@/lib/telemetry/ui-click';
import { captureTelemetryUiControl } from '@/lib/telemetry/client';

type WindowCloseAction = 'quit' | 'tray' | 'cancel';

interface WindowCloseRequest {
  requestId: string;
}

interface ElectronApi {
  isElectron?: boolean;
  platform?: string;
  onWindowCloseRequest?: (callback: (payload: WindowCloseRequest) => void) => (() => void) | void;
  respondWindowClose?: (requestId: string, action: WindowCloseAction) => void;
  setWindowsCloseBehavior?: (behavior: WindowsCloseBehavior) => void;
  onTitlebarMenuCommand?: (callback: (command: string) => void) => (() => void) | void;
}

const SET_CLOSE_BEHAVIOR_COMMAND_PREFIX = 'set-windows-close-behavior:';

function getElectronApi(): ElectronApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: ElectronApi }).electronAPI;
}

function getSavedCloseBehavior(): WindowsCloseBehavior {
  return useSettingsStore.getState().settings.windowsCloseBehavior ?? 'ask';
}

function parseCloseBehaviorCommand(command: string): WindowsCloseBehavior | null {
  if (!command.startsWith(SET_CLOSE_BEHAVIOR_COMMAND_PREFIX)) return null;

  const behavior = command.slice(SET_CLOSE_BEHAVIOR_COMMAND_PREFIX.length);
  return behavior === 'ask' || behavior === 'tray' || behavior === 'quit'
    ? behavior
    : null;
}

export function ElectronCloseDialog() {
  const { t } = useI18n();
  const windowsCloseBehavior = useSettingsStore((state) => state.settings.windowsCloseBehavior);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const [request, setRequest] = useState<WindowCloseRequest | null>(null);
  const [rememberChoice, setRememberChoice] = useState(false);
  const [savingAction, setSavingAction] = useState<WindowCloseAction | null>(null);

  const respond = useCallback(
    async (action: WindowCloseAction) => {
      if (!request) return;

      const electronApi = getElectronApi();
      if (!electronApi?.respondWindowClose) return;

      const requestId = request.requestId;
      setSavingAction(action);

      if (rememberChoice && action !== 'cancel' && getSavedCloseBehavior() !== action) {
        await updateSettings({ windowsCloseBehavior: action });
      }

      setRequest(null);
      setRememberChoice(false);
      setSavingAction(null);
      electronApi.respondWindowClose(requestId, action);
    },
    [rememberChoice, request, updateSettings],
  );

  useEffect(() => {
    const electronApi = getElectronApi();
    if (!electronApi?.isElectron || electronApi.platform !== 'win32') return;
    if (!electronApi.onWindowCloseRequest || !electronApi.respondWindowClose) return;

    return electronApi.onWindowCloseRequest((payload) => {
      const savedBehavior = getSavedCloseBehavior();

      if (savedBehavior === 'quit' || savedBehavior === 'tray') {
        electronApi.respondWindowClose?.(payload.requestId, savedBehavior);
        return;
      }

      setRememberChoice(false);
      setSavingAction(null);
      setRequest(payload);
    });
  }, []);

  useEffect(() => {
    const electronApi = getElectronApi();
    if (!electronApi?.isElectron || electronApi.platform !== 'win32') return;
    electronApi.setWindowsCloseBehavior?.(windowsCloseBehavior);
  }, [windowsCloseBehavior]);

  useEffect(() => {
    const electronApi = getElectronApi();
    if (!electronApi?.isElectron || electronApi.platform !== 'win32') return;
    if (!electronApi.onTitlebarMenuCommand) return;

    return electronApi.onTitlebarMenuCommand((command) => {
      const behavior = parseCloseBehaviorCommand(command);
      if (!behavior || getSavedCloseBehavior() === behavior) return;

      void updateSettings({ windowsCloseBehavior: behavior });
    });
  }, [updateSettings]);

  useEffect(() => {
    if (!request) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void respond('cancel');
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [request, respond]);

  if (!request) return null;

  const isBusy = savingAction !== null;

  return (
    <div
      {...telemetryIgnoreAttributes('manual_capture')}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
      data-testid="electron-close-dialog-overlay"
      onClick={() => {
        if (!isBusy) {
          void captureTelemetryUiControl('app_window.close_dialog.cancel', 'app_window');
          void respond('cancel');
        }
      }}
    >
      <div
        {...telemetryIgnoreAttributes('event_boundary')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="electron-close-title"
        aria-describedby="electron-close-description"
        className="w-full max-w-[25rem] overflow-hidden rounded-lg border border-(--divider) bg-(--sidebar-bg) text-(--text-primary) shadow-[0_18px_54px_rgba(0,0,0,0.28)]"
        data-testid="electron-close-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-5 pb-4 pt-5">
          <div className="flex items-center justify-between gap-4">
            <h2 id="electron-close-title" className="text-base font-semibold tracking-normal">
              {t('electronClose.title')}
            </h2>
            <button
              {...telemetryClickAttributes('app_window.close_dialog.cancel', 'app_window')}
              type="button"
              aria-label={t('common.cancel')}
              className="rounded-md p-1 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) disabled:pointer-events-none disabled:opacity-50"
              disabled={isBusy}
              onClick={() => void respond('cancel')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p
            id="electron-close-description"
            className="mt-3 text-sm leading-6 text-(--text-secondary)"
          >
            {t('electronClose.description')}
          </p>

          <label className="mt-5 flex items-center gap-2 text-sm text-(--text-secondary)">
            <input
              {...telemetryClickAttributes('app_window.close_dialog.remember', 'app_window')}
              type="checkbox"
              className="h-4 w-4 rounded border-(--input-border) accent-(--accent)"
              checked={rememberChoice}
              disabled={isBusy}
              onChange={(event) => setRememberChoice(event.target.checked)}
            />
            <span>{t('electronClose.remember')}</span>
          </label>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-(--divider) bg-(--input-bg)/45 px-5 py-4 sm:flex-row sm:justify-end">
          <Button
            {...telemetryClickAttributes('app_window.close_dialog.cancel', 'app_window')}
            type="button"
            variant="outline"
            disabled={isBusy}
            onClick={() => void respond('cancel')}
          >
            {t('common.cancel')}
          </Button>
          <Button
            {...telemetryClickAttributes('app_window.close_dialog.quit', 'app_window')}
            type="button"
            variant="outline"
            className="border-(--input-border) text-(--error) hover:bg-(--error)/10 hover:text-(--error)"
            disabled={isBusy}
            onClick={() => void respond('quit')}
            data-testid="electron-close-quit"
          >
            {t('electronClose.quit')}
          </Button>
          <Button
            {...telemetryClickAttributes('app_window.close_dialog.tray', 'app_window')}
            type="button"
            disabled={isBusy}
            onClick={() => void respond('tray')}
            data-testid="electron-close-send-to-tray"
          >
            {t('electronClose.sendToTray')}
          </Button>
        </div>
      </div>
    </div>
  );
}
