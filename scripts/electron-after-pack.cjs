const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { signAsync } = require('@electron/osx-sign');
const { Arch } = require('builder-util');

const execFileAsync = promisify(execFile);
const ADHOC_ENTITLEMENTS = path.join(__dirname, 'entitlements.mac.adhoc.plist');
const REQUIRED_ENTITLEMENT = 'com.apple.security.cs.disable-library-validation';

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findAppBundle(appOutDir, productFilename) {
  const candidates = [
    productFilename ? path.join(appOutDir, `${productFilename}.app`) : null,
    path.join(appOutDir, 'Tessera.app'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }

  const entries = await fs.readdir(appOutDir, { withFileTypes: true });
  const appBundles = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => path.join(appOutDir, entry.name));

  if (appBundles.length === 1) return appBundles[0];

  throw new Error(
    `Expected one macOS .app bundle in ${appOutDir}, found ${appBundles.length}`
  );
}

async function listAppBundles(rootAppPath) {
  const appBundles = [rootAppPath];
  const frameworksDir = path.join(rootAppPath, 'Contents', 'Frameworks');

  if (!(await pathExists(frameworksDir))) return appBundles;

  const entries = await fs.readdir(frameworksDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) {
      appBundles.push(path.join(frameworksDir, entry.name));
    }
  }

  return appBundles;
}

async function assertLibraryValidationDisabled(appBundlePath) {
  const { stdout, stderr } = await execFileAsync('codesign', [
    '--display',
    '--entitlements',
    '-',
    appBundlePath,
  ]);
  const output = `${stdout}\n${stderr}`;

  if (!output.includes(REQUIRED_ENTITLEMENT)) {
    throw new Error(`${REQUIRED_ENTITLEMENT} missing from ${appBundlePath}`);
  }
}

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  const appPath = platform === 'darwin'
    ? await findAppBundle(context.appOutDir, context.packager?.appInfo?.productFilename)
    : null;
  const resources = appPath
    ? path.join(appPath, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const nativePackage = `watcher-${platform}-${arch}${platform === 'linux' ? '-glibc' : ''}`;
  const nativeBinary = path.join(resources, 'app.asar.unpacked', 'node_modules', '@parcel', nativePackage, 'watcher.node');
  if (!(await pathExists(nativeBinary))) {
    throw new Error(`Packaged Parcel watcher binary is missing: ${nativeBinary}`);
  }
  console.log(`[electron-after-pack] verified ${nativePackage} binary`);
  if (platform !== 'darwin') return;

  if (process.env.TESSERA_MAC_DISTRIBUTION === '1') {
    console.log('[electron-after-pack] skipping ad-hoc signing for Developer ID distribution build');
    return;
  }

  if (process.platform !== 'darwin') {
    throw new Error('macOS ad-hoc signing requires codesign on a macOS build host');
  }


  console.log(`[electron-after-pack] ad-hoc signing ${appPath}`);

  await signAsync({
    app: appPath,
    identity: '-',
    identityValidation: false,
    platform: 'darwin',
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: false,
    optionsForFile(filePath) {
      const options = { timestamp: 'none' };
      if (filePath.endsWith('.app')) {
        options.entitlements = ADHOC_ENTITLEMENTS;
      }
      return options;
    },
  });

  await execFileAsync('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath,
  ]);

  for (const appBundle of await listAppBundles(appPath)) {
    await assertLibraryValidationDisabled(appBundle);
  }

  console.log(`[electron-after-pack] verified ad-hoc signature for ${appPath}`);
};
