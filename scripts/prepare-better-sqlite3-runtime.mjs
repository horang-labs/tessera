import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const require = createRequire(import.meta.url);

function readOption(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1]?.trim();
  if (!value) throw new Error(`Missing value for --${name}`);
  return value;
}

const platform = readOption('platform', process.platform);
const arch = readOption('arch', process.arch);
const supportedPlatforms = new Set(['win32', 'darwin', 'linux']);
const supportedArchitectures = new Set(['x64', 'arm64']);

if (!supportedPlatforms.has(platform)) {
  throw new Error(`Unsupported Electron target platform: ${platform}`);
}
if (!supportedArchitectures.has(arch)) {
  throw new Error(`Unsupported Electron target architecture: ${arch}`);
}

const electronPackage = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'node_modules', 'electron', 'package.json'), 'utf8'),
);
const runtimePackageDir = path.join(
  rootDir,
  '.electron-runtime',
  'node_modules',
  'better-sqlite3',
);
const prebuildInstall = path.join(rootDir, 'node_modules', 'prebuild-install', 'bin.js');

if (!fs.existsSync(path.join(runtimePackageDir, 'package.json'))) {
  throw new Error('Missing better-sqlite3 in .electron-runtime; run electron:prebuild first');
}

execFileSync(process.execPath, [
  prebuildInstall,
  '--runtime', 'electron',
  '--target', electronPackage.version,
  '--platform', platform,
  '--arch', arch,
  '--force',
], {
  cwd: runtimePackageDir,
  stdio: 'inherit',
});

const nativeModule = path.join(runtimePackageDir, 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(nativeModule)) {
  throw new Error(`better-sqlite3 prebuild was not installed at ${nativeModule}`);
}

const preparedTarget = readNativeTarget(nativeModule);
if (preparedTarget.platform !== platform || preparedTarget.arch !== arch) {
  throw new Error(
    `Prepared better-sqlite3 target ${preparedTarget.platform}-${preparedTarget.arch}`
      + ` does not match requested ${platform}-${arch}`,
  );
}

if (platform === process.platform && arch === process.arch) {
  const electronBinary = require('electron');
  const probe = [
    `const Database = require(${JSON.stringify(runtimePackageDir)});`,
    `const db = new Database(':memory:');`,
    `if (db.prepare('SELECT 1 AS value').get().value !== 1) process.exit(2);`,
    `db.close();`,
  ].join(' ');
  execFileSync(electronBinary, ['--eval', probe], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    timeout: 30_000,
  });
}

console.log(
  `Prepared better-sqlite3 ${platform}-${arch} for Electron ${electronPackage.version}`,
);

function readNativeTarget(filename) {
  const binary = fs.readFileSync(filename);

  if (binary.subarray(0, 2).toString('ascii') === 'MZ') {
    const peOffset = binary.readUInt32LE(0x3c);
    if (binary.subarray(peOffset, peOffset + 4).toString('binary') !== 'PE\0\0') {
      throw new Error(`Invalid PE header in ${filename}`);
    }
    const machine = binary.readUInt16LE(peOffset + 4);
    if (machine === 0x8664) return { platform: 'win32', arch: 'x64' };
    if (machine === 0xaa64) return { platform: 'win32', arch: 'arm64' };
  }

  if (binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = binary.readUInt16LE(18);
    if (machine === 0x3e) return { platform: 'linux', arch: 'x64' };
    if (machine === 0xb7) return { platform: 'linux', arch: 'arm64' };
  }

  if (binary.readUInt32LE(0) === 0xfeedfacf) {
    const cpuType = binary.readUInt32LE(4);
    if (cpuType === 0x01000007) return { platform: 'darwin', arch: 'x64' };
    if (cpuType === 0x0100000c) return { platform: 'darwin', arch: 'arm64' };
  }

  throw new Error(`Unsupported native module format in ${filename}`);
}
