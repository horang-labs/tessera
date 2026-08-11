import fs from 'node:fs';
import path from 'node:path';

export const TESSERA_CONTROL_SKILL_NAME = 'tessera-cli';

export interface BundledTesseraControlSkillFile {
  relativePath: string;
  content: string;
}

const BUNDLED_SKILL_FILES = [
  'SKILL.md',
  'agents/openai.yaml',
] as const;

export function resolveBundledTesseraControlSkillDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const appRoot = env.TESSERA_APP_ROOT?.trim() || cwd;
  return path.join(appRoot, 'skills', TESSERA_CONTROL_SKILL_NAME);
}

export function readBundledTesseraControlSkillFiles(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): BundledTesseraControlSkillFile[] {
  const skillDir = resolveBundledTesseraControlSkillDir(env, cwd);
  return BUNDLED_SKILL_FILES.map((relativePath) => ({
    relativePath,
    content: fs.readFileSync(path.join(skillDir, relativePath), 'utf8'),
  }));
}
