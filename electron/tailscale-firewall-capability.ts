export function supportsTailscaleFirewallConfiguration({
  platform = process.platform,
  devServerPort = process.env.TESSERA_DEV_PORT,
  testInstance = process.env.TESSERA_ELECTRON_TEST_INSTANCE,
}: {
  platform?: NodeJS.Platform;
  devServerPort?: string;
  testInstance?: string;
} = {}): boolean {
  return platform === 'win32' && !devServerPort && !testInstance;
}
