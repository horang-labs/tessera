import { isWindowsHostedWslFilesystemPath } from '@/lib/filesystem/path-environment';
import type { AgentEnvironment } from '@/lib/settings/types';
import { getServerHostInfo } from '@/lib/system/server-host';

export type ProjectFilesystemKind = 'windows' | 'wsl' | 'native';

export interface ProjectEnvironmentValidation {
  ok: boolean;
  filesystemKind: ProjectFilesystemKind;
  error?: string;
}

export function getProjectFilesystemKind(projectPath: string): ProjectFilesystemKind {
  const trimmed = projectPath.trim();
  if (isWindowsHostedWslFilesystemPath(trimmed)) return 'wsl';
  if (isWindowsFilesystemPath(trimmed)) return 'windows';
  if (isWindowsDriveMountPath(trimmed)) return 'windows';

  if (trimmed.startsWith('/') && getServerHostInfo().isWindowsEcosystem) {
    return 'wsl';
  }

  return 'native';
}

export function validateProjectEnvironment(
  projectPath: string,
  agentEnvironment: AgentEnvironment,
): ProjectEnvironmentValidation {
  const filesystemKind = getProjectFilesystemKind(projectPath);
  const isWindowsEcosystem = getServerHostInfo().isWindowsEcosystem;

  if (!isWindowsEcosystem) {
    return { ok: true, filesystemKind };
  }

  if (agentEnvironment === 'wsl') {
    if (filesystemKind === 'wsl') return { ok: true, filesystemKind };
    return {
      ok: false,
      filesystemKind,
      error: 'WSL mode only supports WSL filesystem folders. Switch Agent Environment to Windows Native to use Windows folders.',
    };
  }

  if (filesystemKind === 'wsl') {
    return {
      ok: false,
      filesystemKind,
      error: 'Windows Native mode only supports Windows filesystem folders. Switch Agent Environment to WSL to use WSL folders.',
    };
  }

  return { ok: true, filesystemKind };
}

function isWindowsFilesystemPath(value: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(value)
    || /^[a-zA-Z]:$/.test(value)
    || /^\\\\(?!wsl(?:\.localhost|\$)\\)/i.test(value)
    || /^\/\/(?!wsl(?:\.localhost|\$)\/)/i.test(value)
  );
}

function isWindowsDriveMountPath(value: string): boolean {
  return /^\/mnt\/[a-zA-Z](?:\/|$)/.test(value.replace(/\\/g, '/'));
}
