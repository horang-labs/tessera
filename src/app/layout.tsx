import type { Metadata } from 'next';
import ThemeInitializer from '@/components/theme-initializer';
import '@xterm/xterm/css/xterm.css';
import './globals.css';
import { I18nHtmlLang } from '@/components/i18n-html-lang';
import { Agentation } from 'agentation';
import { ElectronCloseDialog } from '@/components/layout/electron-close-dialog';
import { TelemetryProvider } from '@/components/telemetry/telemetry-provider';

export const metadata: Metadata = {
  title: 'Tessera',
  description: 'Multi-provider chat development tool',
};

// Inline script to prevent FOUC (Flash of Unstyled Content)
// Runs before React hydration to apply the correct theme class and font scale
const themeScript = `
(function() {
  try {
    var stored = localStorage.getItem('tessera:settings');
    var settings = stored ? JSON.parse(stored).state.settings : {};
    var theme = settings.theme || 'auto';
    var isDark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark) document.documentElement.classList.add('dark');
    var scales = [0.8125, 0.875, 0.9375, 1];
    var raw = typeof settings.fontSize === 'number' ? settings.fontSize : 0.875;
    var scale = 0.875;
    if (raw < 2) {
      var best = scales[0];
      var bestDelta = Math.abs(raw - best);
      for (var i = 0; i < scales.length; i++) {
        var d = Math.abs(raw - scales[i]);
        if (d < bestDelta) { best = scales[i]; bestDelta = d; }
      }
      scale = best;
    }
    document.documentElement.style.setProperty('--font-scale', String(scale));
  } catch(e) {}
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <I18nHtmlLang />
        <ThemeInitializer />
        <TelemetryProvider />
        {children}
        <ElectronCloseDialog />
        {process.env.NODE_ENV === 'development' && <Agentation />}
      </body>
    </html>
  );
}
