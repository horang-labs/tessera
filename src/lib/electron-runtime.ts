export function isElectronRuntime(): boolean {
  return process.env.ELECTRON_CHILD === '1'
    || process.env.TESSERA_ELECTRON_RUNTIME === '1';
}
