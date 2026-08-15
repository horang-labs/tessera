async page => {
  // Open on a populated project/session index, then cut directly to useful work.
  await page.waitForTimeout(900);
  await page.getByText('commands.ts command handler', { exact: true }).first().click();

  const composer = page.getByRole('textbox', { name: 'Type a message... (/ skills, @ refs)' });
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByText('Supported commands', { exact: false }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3200);

  // Let the real attachment affordance read clearly without opening a chooser.
  await page.getByRole('button', { name: 'Attach file' }).hover();
  await page.waitForTimeout(900);

  await page.getByTestId('tab-bar-sidebar-toggle').click();
  await page.getByRole('button', { name: 'Collapse sidebar' }).waitFor();
  await page.waitForTimeout(1000);

  await page.getByText('MV3 service worker connectivity', { exact: true }).first().click();
  await page.getByText('Manifest Update Needed', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('textbox', { name: 'Type a message... (/ skills, @ refs)' }).waitFor();
  await page.waitForTimeout(3800);
}
