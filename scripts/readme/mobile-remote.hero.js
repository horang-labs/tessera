async page => {
  const attachment = await page.evaluate(() => localStorage.getItem('tesseraReadmeAttachment'));
  if (!attachment) throw new Error('Attachment path was not staged in localStorage');

  const tap = async locator => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('Demo target has no bounding box');
    await page.evaluate(({ x, y }) => {
      const mark = document.createElement('div');
      mark.className = 'readme-demo-tap';
      mark.style.left = `${x}px`;
      mark.style.top = `${y}px`;
      document.body.appendChild(mark);
      setTimeout(() => mark.remove(), 420);
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await locator.click();
    await page.waitForTimeout(420);
  };

  const indicateTap = async locator => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('Demo target has no bounding box');
    await page.evaluate(({ x, y }) => {
      const mark = document.createElement('div');
      mark.className = 'readme-demo-tap';
      mark.style.left = `${x}px`;
      mark.style.top = `${y}px`;
      document.body.appendChild(mark);
      setTimeout(() => mark.remove(), 420);
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await page.waitForTimeout(420);
  };

  const fade = page.locator('#readme-demo-fade');
  await page.waitForTimeout(220);
  await fade.evaluate(node => { node.style.opacity = '0'; });
  await page.waitForTimeout(500);
  await fade.evaluate(node => node.remove());

  // The opening establishes the phone project/session navigation from the copied seed.
  await page.waitForTimeout(1900);
  await tap(page.getByRole('button', { name: 'Collapse sidebar' }));

  // Briefly show the compact phone tab switcher before launching a safe standalone PTY.
  const tabList = page.getByTestId('tab-list-trigger');
  await tap(tabList);
  await page.waitForTimeout(650);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await tap(page.getByRole('button', { name: /^Shell Open a project shell/ }));
  await page.waitForTimeout(650);
  await tap(page.getByRole('button', { name: 'Shell', exact: true }));

  const bar = page.getByTestId('terminal-input-bar');
  await bar.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(1000);

  const input = page.getByTestId('terminal-input-bar-textarea');
  await tap(input);
  await input.pressSequentially('git status --short', { delay: 55 });
  await page.waitForTimeout(300);
  await tap(page.getByTestId('terminal-input-bar-send'));
  await page.waitForTimeout(1100);

  // The visible image button and real hidden file input exercise Tessera's PTY attachment path.
  const attach = page.getByTestId('terminal-input-bar-attach-image');
  await indicateTap(attach);
  await page.getByTestId('terminal-input-bar-image-input').setInputFiles(attachment);
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="terminal-input-bar-attach-image"]');
    return button?.getAttribute('aria-busy') === 'false';
  }, { timeout: 15_000 });
  await page.waitForTimeout(1900);

  await page.evaluate(() => {
    const node = document.createElement('div');
    Object.assign(node.style, {
      position: 'fixed', inset: '0', zIndex: '2147483646', background: '#0d0d0d',
      opacity: '0', transition: 'opacity 320ms ease', pointerEvents: 'none',
    });
    document.body.appendChild(node);
    requestAnimationFrame(() => { node.style.opacity = '1'; });
  });
  await page.waitForTimeout(570);
}
