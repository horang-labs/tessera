import fs from 'node:fs';
import path from 'node:path';

export const TESSERA_CONTROL_SKILL_NAME = 'tessera-cli';

export interface TesseraControlSkillMetadata {
  name: string;
  description: string;
}

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

export function readBundledTesseraControlSkillMetadata(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): TesseraControlSkillMetadata {
  const skillFile = readBundledTesseraControlSkillFiles(env, cwd)
    .find((file) => file.relativePath === 'SKILL.md');
  const description = skillFile?.content.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!description) {
    throw new Error('Bundled Tessera control skill is missing its description');
  }

  return {
    name: TESSERA_CONTROL_SKILL_NAME,
    description,
  };
}

export function materializeTesseraControlSkill(
  skillsDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const targetDir = path.join(skillsDir, TESSERA_CONTROL_SKILL_NAME);
  fs.rmSync(targetDir, { recursive: true, force: true });
  for (const file of readBundledTesseraControlSkillFiles(env)) {
    const targetPath = path.join(targetDir, file.relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(targetPath, file.content, { mode: 0o600 });
  }
  return targetDir;
}

export function buildPosixTesseraControlSkillMaterialization(
  skillsDirectoryVariable: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(skillsDirectoryVariable)) {
    throw new Error('Invalid POSIX skills directory variable');
  }

  const lines = [
    `tessera_skill_dir="$${skillsDirectoryVariable}/${TESSERA_CONTROL_SKILL_NAME}"`,
    'rm -rf "$tessera_skill_dir"',
  ];
  for (const file of readBundledTesseraControlSkillFiles(env)) {
    const parent = file.relativePath.includes('/')
      ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/'))
      : '';
    lines.push(`mkdir -p "$tessera_skill_dir${parent ? `/${parent}` : ''}"`);
    lines.push(
      `printf '%s' '${Buffer.from(file.content, 'utf8').toString('base64')}'`
      + ` | base64 -d > "$tessera_skill_dir/${file.relativePath}"`,
    );
    lines.push(`chmod 600 "$tessera_skill_dir/${file.relativePath}"`);
  }
  return lines;
}
