export type LinuxWaylandRenderingEnvironment = Record<string, string | undefined>;

export function isLinuxWaylandSession(options: {
  platform: NodeJS.Platform;
  env: LinuxWaylandRenderingEnvironment;
  ozonePlatform?: string;
}): boolean {
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
