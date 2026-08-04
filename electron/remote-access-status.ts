export type ElectronLanguage = 'en' | 'ko' | 'zh' | 'ja';

export interface RemoteAccessStatus {
  registeredDeviceCount: number;
  connectedDeviceCount: number;
}

export interface QuitConfirmationCopy {
  message: string;
  detail: string;
  buttons: [cancel: string, quit: string];
}

interface NativeCopy {
  trayOff: string;
  trayUnavailable: string;
  trayOn: (registered: number, connected: number) => string;
  terminalActiveMessage: (count: number) => string;
  terminalActiveDetail: (count: number) => string;
  terminalUnavailableMessage: string;
  terminalUnavailableDetail: string;
  remoteConnectedMessage: (count: number) => string;
  remoteConnectedDetail: (count: number) => string;
  remoteUnavailableMessage: string;
  remoteUnavailableDetail: string;
  cancel: string;
  quit: string;
}

const COPY: Record<ElectronLanguage, NativeCopy> = {
  en: {
    trayOff: 'Remote access: Off',
    trayUnavailable: 'Remote access: Status unavailable',
    trayOn: (registered, connected) => (
      `Remote access: On · ${registered} paired · ${connected} connected`
    ),
    terminalActiveMessage: (count) => (
      `Quit ${count} active terminal${count === 1 ? '' : 's'}?`
    ),
    terminalActiveDetail: (count) => (
      `Quitting Tessera will stop work running in ${count} active terminal${count === 1 ? '' : 's'}.`
    ),
    terminalUnavailableMessage: 'Terminal status is unavailable. Quit Tessera?',
    terminalUnavailableDetail: 'Quitting may stop active terminal work.',
    remoteConnectedMessage: (count) => (
      `Quit while ${count} remote device${count === 1 ? ' is' : 's are'} connected?`
    ),
    remoteConnectedDetail: (count) => (
      `Quitting Tessera will disconnect the remote device${count === 1 ? '' : 's'}.`
    ),
    remoteUnavailableMessage: 'Remote connection status is unavailable. Quit Tessera?',
    remoteUnavailableDetail: 'Quitting may disconnect an active remote device.',
    cancel: 'Cancel',
    quit: 'Quit Tessera',
  },
  ko: {
    trayOff: '원격 접속: 꺼짐',
    trayUnavailable: '원격 접속: 상태 확인 불가',
    trayOn: (registered, connected) => (
      `원격 접속: 켜짐 · 등록 ${registered}대 · 접속 중 ${connected}대`
    ),
    terminalActiveMessage: (count) => `실행 중인 터미널 ${count}개를 종료할까요?`,
    terminalActiveDetail: (count) => (
      `Tessera를 종료하면 실행 중인 터미널 ${count}개의 작업도 함께 중단됩니다.`
    ),
    terminalUnavailableMessage: '터미널 상태를 확인하지 못했습니다. Tessera를 종료할까요?',
    terminalUnavailableDetail: '종료하면 실행 중인 터미널 작업이 함께 중단될 수 있습니다.',
    remoteConnectedMessage: (count) => (
      `원격 기기 ${count}대가 접속 중입니다. Tessera를 종료할까요?`
    ),
    remoteConnectedDetail: (count) => (
      `Tessera를 종료하면 원격 기기 ${count}대의 연결이 끊깁니다.`
    ),
    remoteUnavailableMessage: '원격 접속 상태를 확인하지 못했습니다. Tessera를 종료할까요?',
    remoteUnavailableDetail: '종료하면 접속 중인 원격 기기의 연결이 끊길 수 있습니다.',
    cancel: '취소',
    quit: 'Tessera 종료',
  },
  zh: {
    trayOff: '远程访问：已关闭',
    trayUnavailable: '远程访问：无法获取状态',
    trayOn: (registered, connected) => (
      `远程访问：已开启 · 已配对 ${registered} 台 · 已连接 ${connected} 台`
    ),
    terminalActiveMessage: (count) => `要退出并停止 ${count} 个活动终端吗？`,
    terminalActiveDetail: (count) => (
      `退出 Tessera 也会停止 ${count} 个活动终端中正在运行的任务。`
    ),
    terminalUnavailableMessage: '无法获取终端状态。仍要退出 Tessera 吗？',
    terminalUnavailableDetail: '退出可能会停止正在运行的终端任务。',
    remoteConnectedMessage: (count) => (
      `有 ${count} 台远程设备已连接。仍要退出 Tessera 吗？`
    ),
    remoteConnectedDetail: (count) => (
      `退出 Tessera 会断开 ${count} 台远程设备的连接。`
    ),
    remoteUnavailableMessage: '无法获取远程连接状态。仍要退出 Tessera 吗？',
    remoteUnavailableDetail: '退出可能会断开正在使用的远程设备。',
    cancel: '取消',
    quit: '退出 Tessera',
  },
  ja: {
    trayOff: 'リモートアクセス：オフ',
    trayUnavailable: 'リモートアクセス：状態を確認できません',
    trayOn: (registered, connected) => (
      `リモートアクセス：オン · ペアリング済み ${registered}台 · 接続中 ${connected}台`
    ),
    terminalActiveMessage: (count) => `実行中のターミナル ${count}件を終了しますか？`,
    terminalActiveDetail: (count) => (
      `Tesseraを終了すると、${count}件のターミナルで実行中の作業も停止します。`
    ),
    terminalUnavailableMessage: 'ターミナルの状態を確認できません。Tesseraを終了しますか？',
    terminalUnavailableDetail: '終了すると、実行中のターミナル作業が停止する可能性があります。',
    remoteConnectedMessage: (count) => (
      `リモートデバイス ${count}台が接続中です。Tesseraを終了しますか？`
    ),
    remoteConnectedDetail: (count) => (
      `Tesseraを終了すると、リモートデバイス ${count}台の接続が切断されます。`
    ),
    remoteUnavailableMessage: 'リモート接続の状態を確認できません。Tesseraを終了しますか？',
    remoteUnavailableDetail: '終了すると、接続中のリモートデバイスが切断される可能性があります。',
    cancel: 'キャンセル',
    quit: 'Tesseraを終了',
  },
};

export function resolveElectronLanguage(locale: string): ElectronLanguage {
  const language = locale.trim().toLowerCase().split(/[-_]/, 1)[0];
  return language === 'ko' || language === 'zh' || language === 'ja'
    ? language
    : 'en';
}

export function parseRemoteAccessStatus(value: unknown): RemoteAccessStatus | null {
  if (!value || typeof value !== 'object') return null;
  const devices = (value as { devices?: unknown }).devices;
  if (!Array.isArray(devices)) return null;

  let connectedDeviceCount = 0;
  for (const device of devices) {
    if (
      !device
      || typeof device !== 'object'
      || typeof (device as { id?: unknown }).id !== 'string'
      || typeof (device as { connected?: unknown }).connected !== 'boolean'
    ) {
      return null;
    }
    if ((device as { connected: boolean }).connected) connectedDeviceCount += 1;
  }

  return {
    registeredDeviceCount: devices.length,
    connectedDeviceCount,
  };
}

export function retainLastRemoteAccessStatus(
  current: RemoteAccessStatus | null,
  observed: RemoteAccessStatus | null,
): RemoteAccessStatus | null {
  return observed ?? current;
}

export function formatRemoteAccessTrayLabel(
  language: ElectronLanguage,
  status: RemoteAccessStatus | null,
): string {
  const copy = COPY[language];
  if (!status) return copy.trayUnavailable;
  if (status.registeredDeviceCount === 0) return copy.trayOff;
  return copy.trayOn(status.registeredDeviceCount, status.connectedDeviceCount);
}

export function buildQuitConfirmation(
  language: ElectronLanguage,
  activeTerminalCount: number,
  remoteStatus: RemoteAccessStatus | null,
): QuitConfirmationCopy | null {
  const terminalNeedsWarning = activeTerminalCount !== 0;
  const remoteNeedsWarning = remoteStatus === null || remoteStatus.connectedDeviceCount > 0;
  if (!terminalNeedsWarning && !remoteNeedsWarning) return null;

  const copy = COPY[language];
  const terminalDetail = activeTerminalCount < 0
    ? copy.terminalUnavailableDetail
    : copy.terminalActiveDetail(activeTerminalCount);

  let message: string;
  const details: string[] = [];
  if (!remoteStatus) {
    message = copy.remoteUnavailableMessage;
    details.push(copy.remoteUnavailableDetail);
  } else if (remoteStatus.connectedDeviceCount > 0) {
    message = copy.remoteConnectedMessage(remoteStatus.connectedDeviceCount);
    details.push(copy.remoteConnectedDetail(remoteStatus.connectedDeviceCount));
  } else if (activeTerminalCount < 0) {
    message = copy.terminalUnavailableMessage;
  } else {
    message = copy.terminalActiveMessage(activeTerminalCount);
  }

  if (terminalNeedsWarning) details.push(terminalDetail);

  return {
    message,
    detail: details.join('\n\n'),
    buttons: [copy.cancel, copy.quit],
  };
}
