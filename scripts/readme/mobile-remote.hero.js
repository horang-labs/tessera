async page => {
  const setCaption = async (text) => {
    await page.evaluate((nextText) => {
      let caption = document.getElementById('readme-mobile-caption');
      if (!caption) {
        caption = document.createElement('div');
        caption.id = 'readme-mobile-caption';
        Object.assign(caption.style, {
          position: 'fixed',
          left: '50%',
          bottom: '158px',
          transform: 'translateX(-50%)',
          zIndex: '2147483647',
          maxWidth: '340px',
          padding: '7px 12px',
          border: '1px solid rgba(255,255,255,.16)',
          borderRadius: '999px',
          background: 'rgba(17,24,39,.88)',
          boxShadow: '0 6px 20px rgba(0,0,0,.28)',
          color: '#fff',
          font: '600 14px/1.25 system-ui, sans-serif',
          textAlign: 'center',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        });
        document.body.appendChild(caption);
      }
      caption.textContent = nextText;
    }, text);
  };

  await setCaption('Choose any session from your phone');
  await page.waitForTimeout(1_000);

  await page.getByText('Mobile PTY workflow', { exact: true }).first().click();
  const terminalInput = page.getByTestId('terminal-input-bar-textarea');
  await terminalInput.waitFor({ state: 'visible', timeout: 30_000 });
  await setCaption('Continue work in the live PTY');
  await page.waitForTimeout(800);
  await terminalInput.pressSequentially('What should I review next?', { delay: 24 });
  await page.waitForTimeout(150);
  await page.getByTestId('terminal-input-bar-send').click();
  await page.waitForTimeout(150);
  await page.getByTestId('terminal-input-bar-key-enter').click();
  await page.waitForTimeout(1_200);

  await setCaption('Read the same PTY in Chat View');
  await page.getByTestId('terminal-view-toggle').click();
  await page.getByTestId('terminal-chat-overlay').waitFor({ timeout: 10_000 });
  await page.getByText('What should I review next?', { exact: true }).waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => (
    document.querySelectorAll(
      '[data-testid="terminal-chat-overlay"] [data-testid="agent-message-group"]',
    ).length >= 2
  ), { timeout: 30_000 });
  await page.waitForTimeout(1_200);

  await setCaption('Switch sessions from the sidebar');
  await page.getByTestId('tab-bar-sidebar-toggle').click();
  await page.getByText('Mobile GUI workflow', { exact: true }).first().waitFor();
  await page.waitForTimeout(700);
  await page.getByText('Mobile GUI workflow', { exact: true }).first().click();

  const composer = page.getByRole('textbox', { name: 'Type a message... (/ skills, @ refs)' });
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByText('Supported commands', { exact: false }).waitFor({ timeout: 30_000 });
  await setCaption('Work in a separate GUI session');
  await page.waitForTimeout(1_000);
  await composer.pressSequentially('Summarize the next implementation step.', { delay: 14 });
  await page.waitForTimeout(400);

  await setCaption('Open Files and Git without leaving');
  await page.getByTestId('tab-bar-git-toggle').click();
  await page.getByTestId('git-panel').waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(750);
  await page.getByRole('tab', { name: 'Files' }).click();
  await page.waitForTimeout(900);
  await page.getByTestId('git-panel-close-btn').click();

  await setCaption('Keep coding from anywhere');
  await composer.waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    document.documentElement.dataset.readmeMobileDemoComplete = 'true';
    document.documentElement.dataset.readmeMobileDemoCompleteAt = String(performance.now());
  });
}
