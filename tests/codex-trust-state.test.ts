import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeCodexOverlayTrust,
  serializeCodexTrustBaseline,
} from '@/lib/terminal/codex-trust-state';

const MANAGED_HOOKS = '/tmp/.tessera/codex-overlay/session-1/hooks.json';

test('Codex trust promotion keeps a concurrent account-level revocation', () => {
  const baseline = 'model = "gpt-5.4"\n';
  const finalOverlay = [
    baseline.trimEnd(),
    '',
    '[projects."/tmp/project"]',
    'trust_level = "trusted"',
    '',
  ].join('\n');
  const currentAccount = [
    baseline.trimEnd(),
    '',
    '[projects."/tmp/project"]',
    'trust_level = "untrusted"',
    '',
  ].join('\n');

  const merged = mergeCodexOverlayTrust({
    baselineJson: serializeCodexTrustBaseline(baseline),
    finalOverlayConfig: finalOverlay,
    currentAccountConfig: currentAccount,
    managedHooksPath: MANAGED_HOOKS,
  });

  assert.equal(merged, currentAccount);
});

test('Codex trust promotion persists explicit trust revocation and hook hash changes', () => {
  const projectHeader = '[projects."/tmp/project"]';
  const hookHeader = '[hooks.state."/tmp/project/.codex/hooks.json:pre_tool_use:0:0"]';
  const baseline = [
    projectHeader,
    'trust_level = "trusted"',
    '',
    hookHeader,
    'enabled = true',
    'trusted_hash = "sha256:old"',
    '',
  ].join('\n');
  const finalOverlay = baseline
    .replace('trust_level = "trusted"', 'trust_level = "untrusted"')
    .replace('enabled = true', 'enabled = false')
    .replace('sha256:old', 'sha256:new');

  const merged = mergeCodexOverlayTrust({
    baselineJson: serializeCodexTrustBaseline(baseline),
    finalOverlayConfig: finalOverlay,
    currentAccountConfig: baseline,
    managedHooksPath: MANAGED_HOOKS,
  });

  assert.match(merged, /^trust_level = "untrusted"$/m);
  assert.match(merged, /^enabled = false$/m);
  assert.match(merged, /^trusted_hash = "sha256:new"$/m);
});

test('Codex trust promotion ignores section-shaped text inside multiline values', () => {
  const fakeTrust = [
    'notice = """',
    '[projects."/tmp/injected"]',
    'trust_level = "trusted"',
    '[hooks.state."/tmp/injected/hooks.json:pre_tool_use:0:0"]',
    'enabled = true',
    'trusted_hash = "sha256:injected"',
    '"""',
    '',
  ].join('\n');

  const merged = mergeCodexOverlayTrust({
    baselineJson: serializeCodexTrustBaseline(''),
    finalOverlayConfig: fakeTrust,
    currentAccountConfig: '',
    managedHooksPath: MANAGED_HOOKS,
  });

  assert.equal(merged, '');
});

test('Codex trust promotion never promotes trust for Tessera managed hooks', () => {
  const finalOverlay = [
    `[hooks.state."${MANAGED_HOOKS}:pre_tool_use:0:0"]`,
    'enabled = true',
    'trusted_hash = "sha256:tessera"',
    '',
  ].join('\n');

  const merged = mergeCodexOverlayTrust({
    baselineJson: serializeCodexTrustBaseline(''),
    finalOverlayConfig: finalOverlay,
    currentAccountConfig: '',
    managedHooksPath: MANAGED_HOOKS,
  });

  assert.equal(merged, '');
});
