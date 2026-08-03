import type { Metadata } from 'next';
import { PairingClient } from '@/components/pairing/pairing-client';

export const metadata: Metadata = {
  title: 'Connect device · Tessera',
  description: 'Securely connect this browser to Tessera.',
  robots: { index: false, follow: false },
};

// Capture the fragment before hydration and remove it from the current history
// entry. The token never reaches Next.js, proxy logs, Referer headers, or an
// analytics runtime.
const pairingBootstrapScript = `
(function () {
  try {
    var hash = window.location.hash;
    var token = hash ? new URLSearchParams(hash.slice(1)).get('t') : null;
    Object.defineProperty(window, '__tesseraPairingToken', {
      value: token || '',
      configurable: true,
      writable: true
    });
    if (hash) {
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search
      );
    }
  } catch (_) {}
})();
`;

export default function PairPage() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: pairingBootstrapScript }} />
      <PairingClient />
    </>
  );
}
