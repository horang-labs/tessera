import { promises as fs } from 'fs';
import path from 'path';
import { nodeFileTrace } from '@vercel/nft';

const rootDir = process.cwd();
const runtimeDir = path.join(rootDir, '.electron-runtime');
const nextServerDir = path.join(rootDir, '.next', 'server');
const nextStaticDir = path.join(rootDir, '.next', 'static');
const requiredServerFilesPath = path.join(rootDir, '.next', 'required-server-files.json');

const ELECTRON_ENTRYPOINTS = [
  'dist-electron/electron/main.js',
  'dist-electron/electron/preload.js',
  'dist-electron/electron/tray.js',
  'dist-electron/electron/server-child.js',
];

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

function isUnderRoot(absPath) {
  const relativePath = path.relative(rootDir, absPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function shouldSkip(relativePath) {
  if (!relativePath) return true;

  return (
    relativePath.startsWith('.electron-runtime/') ||
    relativePath === '.electron-runtime' ||
    relativePath.startsWith('.git/') ||
    relativePath === '.git' ||
    relativePath.startsWith('.next/cache/') ||
    relativePath === '.next/cache' ||
    relativePath.startsWith('.next/trace/') ||
    relativePath === '.next/trace' ||
    relativePath.startsWith('.next/types/') ||
    relativePath === '.next/types' ||
    relativePath.startsWith('node_modules/electron/') ||
    relativePath === 'node_modules/electron' ||
    relativePath.startsWith('node_modules/typescript/') ||
    relativePath === 'node_modules/typescript' ||
    relativePath.startsWith('node_modules/sharp/') ||
    relativePath === 'node_modules/sharp' ||
    relativePath.startsWith('node_modules/@img/') ||
    relativePath === 'node_modules/@img' ||
    (relativePath.startsWith('node_modules/node-pty/prebuilds/') &&
      relativePath.endsWith('.pdb')) ||
    relativePath.startsWith('artifacts/') ||
    relativePath === 'artifacts' ||
    relativePath.startsWith('docs/') ||
    relativePath === 'docs' ||
    relativePath.startsWith('pr-assets/') ||
    relativePath === 'pr-assets' ||
    relativePath.startsWith('prototypes/') ||
    relativePath === 'prototypes' ||
    relativePath.startsWith('release/') ||
    relativePath === 'release' ||
    relativePath.startsWith('reviews/') ||
    relativePath === 'reviews' ||
    relativePath.startsWith('temp/') ||
    relativePath === 'temp' ||
    relativePath.endsWith('.map') ||
    relativePath.endsWith('.d.ts') ||
    relativePath.endsWith('.md')
  );
}

async function pathExists(absPath) {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(absDir, callback) {
  if (!(await pathExists(absDir))) return;

  const entries = await fs.readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(absPath, callback);
      continue;
    }

    if (entry.isFile()) {
      await callback(absPath);
    }
  }
}

async function addFile(absPath, files) {
  if (!(await pathExists(absPath))) return;
  if (!isUnderRoot(absPath)) return;

  const relPath = toPosix(path.relative(rootDir, absPath));
  if (shouldSkip(relPath)) return;

  const fileStat = await fs.lstat(absPath);
  if (fileStat.isSymbolicLink()) {
    const targetStat = await fs.stat(absPath).catch(() => null);
    if (targetStat?.isDirectory()) {
      await walkFiles(absPath, async (childPath) => {
        await addFile(childPath, files);
      });
      return;
    }
  }

  files.add(relPath);
}

async function addDirectory(relDir, files) {
  const absDir = path.join(rootDir, relDir);
  await walkFiles(absDir, async (absPath) => {
    await addFile(absPath, files);
  });
}

async function addNextTraceFiles(files) {
  const requiredServerFiles = JSON.parse(await fs.readFile(requiredServerFilesPath, 'utf8'));

  for (const relPath of requiredServerFiles.files) {
    await addFile(path.join(rootDir, relPath), files);
  }

  await addDirectory('.next/server', files);
  await addDirectory('.next/static', files);

  await walkFiles(nextServerDir, async (tracePath) => {
    if (!tracePath.endsWith('.nft.json')) return;

    const trace = JSON.parse(await fs.readFile(tracePath, 'utf8'));
    const traceDir = path.dirname(tracePath);

    for (const tracedPath of trace.files) {
      await addFile(path.resolve(traceDir, tracedPath), files);
    }
  });
}

async function addTracedEntrypointFiles(files) {
  const { fileList } = await nodeFileTrace(ELECTRON_ENTRYPOINTS, {
    base: rootDir,
    processCwd: rootDir,
    mixedModules: true,
    ignore: (tracePath) => shouldSkip(toPosix(tracePath)),
  });

  for (const relPath of fileList) {
    await addFile(path.join(rootDir, relPath), files);
  }
}

async function copyFileToRuntime(relPath) {
  const sourcePath = path.join(rootDir, relPath);
  const targetPath = path.join(runtimeDir, relPath);
  const sourceStat = await fs.lstat(sourcePath);

  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  if (sourceStat.isSymbolicLink()) {
    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      dereference: true,
    });
    return;
  }

  await fs.copyFile(sourcePath, targetPath);
}

async function collectRuntimeDependencies() {
  const runtimeNodeModulesDir = path.join(runtimeDir, 'node_modules');
  const dependencies = {};

  if (!(await pathExists(runtimeNodeModulesDir))) {
    return dependencies;
  }

  const entries = await fs.readdir(runtimeNodeModulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(runtimeNodeModulesDir, entry.name);
      const scopedEntries = await fs.readdir(scopeDir, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory()) continue;

        const packageJsonPath = path.join(scopeDir, scopedEntry.name, 'package.json');
        if (!(await pathExists(packageJsonPath))) continue;

        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
        dependencies[packageJson.name] = packageJson.version;
      }
      continue;
    }

    const packageJsonPath = path.join(runtimeNodeModulesDir, entry.name, 'package.json');
    if (!(await pathExists(packageJsonPath))) continue;

    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    dependencies[packageJson.name] = packageJson.version;
  }

  return Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));
}

async function copyTurbopackExternalAliases() {
  const nextNodeModulesDir = path.join(rootDir, '.next', 'node_modules');
  if (!(await pathExists(nextNodeModulesDir))) return;

  const entries = await fs.readdir(nextNodeModulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const sourcePath = path.join(nextNodeModulesDir, entry.name);
    const sourceStat = await fs.stat(sourcePath).catch(() => null);
    if (!sourceStat?.isDirectory()) continue;

    const targetPath = path.join(runtimeDir, 'node_modules', entry.name);
    await fs.rm(targetPath, { recursive: true, force: true });
    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      dereference: true,
    });

    const packageJsonPath = path.join(targetPath, 'package.json');
    if (await pathExists(packageJsonPath)) {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      packageJson.name = entry.name;
      await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    }
  }
}

async function writeRuntimePackageJson() {
  const sourcePackageJson = JSON.parse(
    await fs.readFile(path.join(rootDir, 'package.json'), 'utf8')
  );
  const runtimeDependencies = await collectRuntimeDependencies();

  const runtimePackageJson = {
    name: sourcePackageJson.name,
    version: sourcePackageJson.version,
    description: sourcePackageJson.description,
    private: sourcePackageJson.private,
    author: sourcePackageJson.author,
    homepage: sourcePackageJson.homepage,
    main: 'dist-electron/electron/main.js',
    dependencies: runtimeDependencies,
  };

  await fs.writeFile(
    path.join(runtimeDir, 'package.json'),
    `${JSON.stringify(runtimePackageJson, null, 2)}\n`
  );
}

async function ensureExecutableRuntimeFiles() {
  const executableFiles = [
    'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
    'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  ];

  for (const relPath of executableFiles) {
    const filePath = path.join(runtimeDir, relPath);
    if (await pathExists(filePath)) {
      await fs.chmod(filePath, 0o755);
    }
  }
}

async function main() {
  if (!(await pathExists(requiredServerFilesPath))) {
    throw new Error('Missing .next/required-server-files.json. Run `npm run build` first.');
  }

  if (!(await pathExists(nextServerDir)) || !(await pathExists(nextStaticDir))) {
    throw new Error('Missing Next.js production output. Run `npm run build` first.');
  }

  const files = new Set();

  await fs.rm(runtimeDir, { recursive: true, force: true });

  await addFile(path.join(rootDir, 'next.config.mjs'), files);
  await addDirectory('assets', files);
  await addDirectory('public', files);
  await addDirectory('dist-electron', files);
  await addDirectory('node_modules/next', files);
  await addDirectory('node_modules/@next/env', files);
  await addDirectory('node_modules/sql.js', files);
  await addDirectory('node_modules/node-pty/lib/worker', files);
  await addDirectory('node_modules/node-pty/prebuilds', files);
  await addDirectory('node_modules/node-pty/build/Release', files);
  await addDirectory('node_modules/node-pty/build/Debug', files);
  await addNextTraceFiles(files);
  await addTracedEntrypointFiles(files);

  const sortedFiles = [...files].sort();
  for (const relPath of sortedFiles) {
    await copyFileToRuntime(relPath);
  }
  await copyTurbopackExternalAliases();

  await ensureExecutableRuntimeFiles();

  await writeRuntimePackageJson();

  const totalBytes = (
    await Promise.all(
      sortedFiles.map(async (relPath) => (await fs.stat(path.join(rootDir, relPath))).size)
    )
  ).reduce((sum, size) => sum + size, 0);

  console.log(
    `Prepared ${sortedFiles.length} runtime files in ${path.relative(rootDir, runtimeDir)} (${Math.round(totalBytes / 1024 / 1024)} MB)`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
