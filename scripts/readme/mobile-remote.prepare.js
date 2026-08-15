async page => {
  const origin = await page.evaluate(() => location.origin);

  await page.addInitScript(() => {
    const installDemoStyles = () => {
      const style = document.createElement('style');
      style.dataset.readmeDemo = 'true';
      style.textContent = `
        nextjs-portal, [data-agentation-root] { display: none !important; }
        .readme-demo-tap {
          position: fixed;
          z-index: 2147483647;
          width: 34px;
          height: 34px;
          margin: -17px 0 0 -17px;
          border: 2px solid rgba(255,255,255,.92);
          border-radius: 9999px;
          pointer-events: none;
          animation: readme-demo-tap 360ms ease-out forwards;
        }
        @keyframes readme-demo-tap {
          from { opacity: .95; transform: scale(.45); }
          to { opacity: 0; transform: scale(1.35); }
        }
      `;
      document.documentElement.appendChild(style);
    };
    if (document.documentElement) installDemoStyles();
    else addEventListener('DOMContentLoaded', installDemoStyles, { once: true });
  });

  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('project-strip-/tmp/tessera-mobile-demo').waitFor({ timeout: 60_000 });
  await page.getByTestId('project-strip-/tmp/tessera-mobile-demo').click();

  const sidebarToggle = page.getByTestId('tab-bar-sidebar-toggle');
  if (await sidebarToggle.getAttribute('aria-label') === 'Expand sidebar') {
    await sidebarToggle.click();
  }
  await page.getByRole('button', { name: 'Collapse sidebar' }).waitFor();
  await page.getByText('Mobile terminal polish', { exact: true }).first().waitFor({ timeout: 30_000 });
  const otherRegion = page.getByRole('region', { name: 'Other' });
  await otherRegion.getByText('Other', { exact: true }).click();

  await page.evaluate(() => {
    const node = document.createElement('div');
    node.id = 'readme-demo-fade';
    Object.assign(node.style, {
      position: 'fixed', inset: '0', zIndex: '2147483646', background: '#0d0d0d',
      opacity: '1', transition: 'opacity 320ms ease', pointerEvents: 'none',
    });
    document.body.appendChild(node);
  });
}
