import { spawnSync, ChildProcess } from 'child_process';
import logger from '../logger';

function killBySessionId(pid: number, signal: 'TERM' | 'KILL'): void {
  if (process.platform === 'win32') {
    return;
  }

  try {
    spawnSync('pkill', [`-${signal}`, '-s', String(pid)], {
      timeout: 5000,
      windowsHide: true,
    });
  } catch {
    // No matching processes or pkill not available
  }
}

function getAllDescendantPids(pid: number): number[] {
  if (process.platform === 'win32') {
    return [];
  }

  try {
    const result = spawnSync('pgrep', ['-P', String(pid)], {
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) {
      return [];
    }

    const childPids = result.stdout.toString().trim().split('\n')
      .filter((value) => value.length > 0)
      .map(Number)
      .filter((value) => !isNaN(value));

    const allPids = [...childPids];
    for (const childPid of childPids) {
      allPids.push(...getAllDescendantPids(childPid));
    }
    return allPids;
  } catch {
    return [];
  }
}

function killDescendants(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  const descendants = getAllDescendantPids(pid);
  if (descendants.length === 0) {
    return;
  }

  logger.debug({ parentPid: pid, signal, descendants }, 'Killing descendant processes');

  for (let i = descendants.length - 1; i >= 0; i--) {
    try {
      process.kill(descendants[i], signal);
    } catch {
      // already dead
    }
  }
}

function killWindowsProcessTree(pid: number): void {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      timeout: 5000,
      windowsHide: true,
    });
  } catch (error) {
    logger.debug({ pid, error }, 'taskkill failed or process already exited');
  }
}

export async function gracefulKillProcess(sessionId: string, proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const pid = proc.pid;
    if (!pid) {
      resolve();
      return;
    }

    if (process.platform === 'win32') {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may already be gone
      }

      const timeout = setTimeout(() => {
        logger.warn({ sessionId, pid }, 'Windows process did not exit gracefully, forcing taskkill');
        killWindowsProcessTree(pid);
        resolve();
      }, 5000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        logger.debug({ sessionId }, 'Process exited gracefully');
        resolve();
      });
      return;
    }

    const descendants = getAllDescendantPids(pid);

    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Process group already dead
    }

    killBySessionId(pid, 'TERM');

    for (let i = descendants.length - 1; i >= 0; i--) {
      try {
        process.kill(descendants[i], 'SIGTERM');
      } catch {
        // already dead
      }
    }

    const timeout = setTimeout(() => {
      logger.warn({ sessionId, pid }, 'Process group did not exit gracefully, forcing SIGKILL');
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Process group already dead
      }
      killBySessionId(pid, 'KILL');
      killDescendants(pid, 'SIGKILL');
      resolve();
    }, 5000);

    proc.once('exit', () => {
      clearTimeout(timeout);
      logger.debug({ sessionId }, 'Process exited gracefully');
      resolve();
    });
  });
}
