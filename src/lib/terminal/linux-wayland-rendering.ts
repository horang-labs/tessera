export type LinuxWaylandRenderingEnvironment = Record<string, string | undefined>;

type LinuxWaylandOptions = {
  platform: NodeJS.Platform;
  env: LinuxWaylandRenderingEnvironment;
  ozonePlatform?: string;
};

export function isLinuxWaylandSession(options: LinuxWaylandOptions): boolean {
  if (options.platform !== 'linux') return false;

  const ozonePlatform = options.ozonePlatform?.trim().toLowerCase() ?? '';
  const ozoneHint = options.env.ELECTRON_OZONE_PLATFORM_HINT?.trim().toLowerCase() ?? '';
  const explicitlyX11 = ozonePlatform === 'x11' || (!ozonePlatform && ozoneHint === 'x11');
  if (explicitlyX11) return false;

  return Boolean(
    options.env.WAYLAND_DISPLAY
    || options.env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland'
    || ozonePlatform === 'wayland'
    || ozoneHint === 'wayland'
  );
}

/** Electron 33 otherwise defaults to XWayland even on a native Wayland desktop. */
export function linuxWaylandImeSwitches(options: LinuxWaylandOptions): Array<[string, string]> {
  if (!isLinuxWaylandSession(options)) return [];
  const platform = options.ozonePlatform?.trim().toLowerCase();
  if (platform && platform !== 'auto' && platform !== 'wayland') return [];
  return [
    ['ozone-platform', 'wayland'],
    ['enable-wayland-ime', ''],
    ['wayland-text-input-version', '3'],
  ];
}
