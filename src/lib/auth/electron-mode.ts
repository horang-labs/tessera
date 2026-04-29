export function isElectronAuthBypassEnabled(): boolean {
  return process.env.ELECTRON_CHILD === '1'
    || process.env.TESSERA_ELECTRON_AUTH_BYPASS === '1';
}
