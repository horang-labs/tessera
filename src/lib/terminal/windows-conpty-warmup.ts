import os from 'os';
import logger from '@/lib/logger';

const WARMUP_KILL_TIMEOUT_MS = 10_000;

let warmed = false;

/**
 * Pays the one-time cost of the first ConPTY spawn (conpty native module
 * load, bundled conpty.dll + OpenConsole.exe first launch, Defender scans of
 * those binaries) at server boot instead of on the user's first terminal.
 * orca measured ~2.7s for the first spawn vs ~70ms after on a Windows dev
 * profile.
 */
export function warmWindowsConptyOnce(): void {
  if (process.platform !== 'win32' || warmed) return;
  warmed = true;
  // setImmediate keeps server startup ahead of the warm-up; a real terminal
  // spawn arriving first simply does the warming itself.
  setImmediate(() => {
    void (async () => {
      try {
        const ptyFactory = await import('node-pty');
        const proc = ptyFactory.spawn(process.env.COMSPEC || 'cmd.exe', ['/c', 'exit'], {
          name: 'xterm-256color',
          cols: 2,
          rows: 1,
          cwd: os.homedir(),
          env: process.env as Record<string, string>,
          // Match real terminal spawns so the bundled ConPTY binaries are the
          // ones warmed, not the legacy system ConPTY.
          useConptyDll: true,
        });
        const killTimer = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // best-effort cleanup of a stuck warm-up shell
          }
        }, WARMUP_KILL_TIMEOUT_MS);
        killTimer.unref?.();
        proc.onExit(() => {
          clearTimeout(killTimer);
        });
      } catch (error) {
        // Warm-up is best-effort; real spawns surface their own errors.
        logger.debug({ error }, 'Windows ConPTY warm-up skipped');
      }
    })();
  });
}
