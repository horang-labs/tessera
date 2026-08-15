async page => {
  const origin = await page.evaluate(() => location.origin);

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });

  const project = page.getByTestId('project-strip-/tmp/tessera-mobile-demo');
  await project.waitFor({ timeout: 60_000 });
  await project.click();

  const sidebarToggle = page.getByTestId('tab-bar-sidebar-toggle');
  if (await sidebarToggle.getAttribute('aria-label') === 'Expand sidebar') {
    await sidebarToggle.click();
  }

  await page.getByRole('button', { name: 'Collapse sidebar' }).waitFor();
  await page.getByText('commands.ts command handler', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByText('MV3 service worker connectivity', { exact: true }).first().waitFor({ timeout: 30_000 });
}
