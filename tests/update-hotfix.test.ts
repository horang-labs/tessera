import assert from 'node:assert/strict';
import test from 'node:test';
import { checkForUpdates } from '../src/lib/update/update-checker';
import { compareVersions, isNewerVersion } from '../src/lib/update/version';

for (const channel of ['github-release', 'npm']) {
  for (const current of ['0.2.4', '0.2.4-hotfix', '0.2.4-hotfix.1']) {
    test(`${channel}: ${current} does not prompt to download the original 0.2.4`, async () => {
      const releases = ['0.2.4', '0.2.4-hotfix.1'];
      const fetchImpl: typeof fetch = async () => Response.json(channel === 'npm'
        ? { versions: Object.fromEntries(releases.map((version) => [version, {}])) }
        : releases.map((version) => ({ tag_name: `v${version}`, draft: false })));
      const result = await checkForUpdates({
        platform: 'win32', arch: 'x64', appVersion: current, channel,
        telemetryDisabledByEnv: true, isWindowsEcosystem: true,
      }, fetchImpl);
      assert.equal(result.error, null);
      assert.equal(result.status, 'current');
      assert.equal(result.updateAvailable, false);
    });
  }
}

test('hotfix suppression preserves future updates and ordinary prerelease upgrades', () => {
  assert.equal(isNewerVersion('0.2.5', '0.2.4-hotfix.1'), true);
  assert.equal(isNewerVersion('0.3.0', '0.2.4-hotfix.1'), true);
  assert.equal(isNewerVersion('0.2.4-hotfix.2', '0.2.4-hotfix.1'), true);
  assert.equal(isNewerVersion('0.2.4', '0.2.4-beta.1'), true);
  assert.equal(isNewerVersion('0.2.4', '0.2.4-rc.1'), true);
  assert.equal(isNewerVersion('0.2.4', '0.2.4-hotfixbeta.1'), true);
  assert.equal(isNewerVersion('v0.2.4+build.2', 'v0.2.4-hotfix.1+build.1'), false);
  assert.equal(isNewerVersion('0.2.3', '0.2.4-hotfix.1'), false);
  assert.equal(isNewerVersion(null, '0.2.4-hotfix.1'), false);
  assert.equal(isNewerVersion('invalid', '0.2.4-hotfix.1'), false);
  assert.equal(isNewerVersion('0.2.4', 'invalid'), false);
  assert.equal(compareVersions('0.2.4', '0.2.4-hotfix.1'), 1);
});
