import type { Metadata } from 'next';
import { PwaInstallClient } from '@/components/pwa/pwa-install-client';

export const metadata: Metadata = {
  title: 'Install Tessera',
  description: 'Optionally add Tessera to your Home Screen.',
  robots: { index: false, follow: false },
};

const installPromptCaptureScript = `
(function () {
  if (window.__tesseraInstallPromptCapture) return;
  var capture = function (event) {
    event.preventDefault();
    window.__tesseraInstallPrompt = event;
  };
  window.__tesseraInstallPromptCapture = capture;
  window.addEventListener('beforeinstallprompt', capture);
})();
`;

export default function InstallPage() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: installPromptCaptureScript }} />
      <PwaInstallClient />
    </>
  );
}
