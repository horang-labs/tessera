import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const DEFAULT_DB_NAME = 'tessera';
export const DEV_BRANCH_DB_NAME = 'tessera-dev';
export const PRD_BRANCH_NAME = 'main';

export interface DatabaseLocation {
  branchName: string | null;
  dbDir: string;
  dbName: string;
  dbPath: string;
  source: 'git-main-branch' | 'git-non-main-branch';
}

export interface ResolveDatabaseLocationOptions {
  cwd?: string;
  dbDir?: string;
  detectGitBranch?: (cwd: string) => Promise<string | null>;
}

export async function detectCurrentGitBranch(cwd: string = process.cwd()): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd });
    const branchName = stdout.trim();
    return branchName || null;
  } catch {
    return null;
  }
}

export async function resolveDatabaseLocation(
  options: ResolveDatabaseLocationOptions = {}
): Promise<DatabaseLocation> {
  const cwd = options.cwd ?? process.cwd();
  const dbDir = options.dbDir ?? path.join(os.homedir(), '.tessera');
  const getBranch = options.detectGitBranch ?? detectCurrentGitBranch;
  const branchName = await getBranch(cwd);

  if (branchName === PRD_BRANCH_NAME) {
    return buildDatabaseLocation({
      branchName,
      dbDir,
      dbName: DEFAULT_DB_NAME,
      source: 'git-main-branch',
    });
  }

  return buildDatabaseLocation({
    branchName,
    dbDir,
    dbName: DEV_BRANCH_DB_NAME,
    source: 'git-non-main-branch',
  });
}

function buildDatabaseLocation(args: {
  branchName: string | null;
  dbDir: string;
  dbName: string;
  source: DatabaseLocation['source'];
}): DatabaseLocation {
  return {
    branchName: args.branchName,
    dbDir: args.dbDir,
    dbName: args.dbName,
    dbPath: path.join(args.dbDir, `${args.dbName}.db`),
    source: args.source,
  };
}
