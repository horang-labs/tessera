import {
  claimPairingToken,
  decidePairingRequest,
  issuePairingToken,
  receivePairingDecision,
} from '../../src/lib/auth/device-registry';

export async function pairApprovedDevice(name: string, now = new Date()) {
  const pairing = await issuePairingToken(now);
  const claim = await claimPairingToken({
    token: pairing.token,
    name,
    browser: 'Test browser',
    platform: 'Test platform',
    remoteAddress: '127.0.0.1',
  }, undefined, now);
  await decidePairingRequest(claim.request.id, 'approve', now);
  const result = await receivePairingDecision(
    claim.request.id,
    claim.pollingCredential,
    now,
  );
  if (result.status !== 'redeemed') {
    throw new Error(`Expected an approved device, got ${result.status}`);
  }
  return { pairing, claim, device: result.device };
}
