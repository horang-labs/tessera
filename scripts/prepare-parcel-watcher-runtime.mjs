import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** npm's optional dependencies install for the host, not the Electron cross-build target. */
export function prepareParcelWatcherRuntime(rootDir, platform, arch) {
  const runtime = path.join(rootDir, '.electron-runtime');
  const wrapperManifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'node_modules/@parcel/watcher/package.json'), 'utf8'));
  const packageName = `@parcel/watcher-${platform}-${arch}${platform === 'linux' ? '-glibc' : ''}`;
  const version = wrapperManifest.optionalDependencies[packageName];
  if (!version) throw new Error(`Unsupported Parcel watcher target: ${packageName}`);
  const staging = fs.mkdtempSync(path.join(runtime, '.parcel-prebuild-'));
  try {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error('Run native runtime preparation through npm');
    const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', `${packageName}@${version}`, '--json', '--pack-destination', staging], {
      cwd: rootDir, encoding: 'utf8', timeout: 120_000,
    }));
    const destination = path.join(runtime, 'node_modules', packageName);
    fs.mkdirSync(destination, { recursive: true });
    execFileSync('tar', ['-xzf', path.join(staging, packed[0].filename), '--strip-components=1', '-C', destination], { timeout: 30_000 });
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
    if (manifest.name !== packageName || manifest.version !== version || !fs.existsSync(path.join(destination, manifest.main))) {
      throw new Error(`Invalid Parcel watcher prebuild: ${packageName}`);
    }
    const runtimeManifestPath = path.join(runtime, 'package.json');
    const runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8'));
    runtimeManifest.dependencies[packageName] = version;
    fs.writeFileSync(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
    console.log(`Prepared ${packageName}@${version}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
