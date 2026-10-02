// Run with patched playwright-cli run-code --filename on the owned synthetic
// tests/fixtures/automation-manager-navigation.tsx page. No app/profile/backend.
async page => {
  if (!await page.locator('[data-automation-navigation-fixture="synthetic"]').count()) throw new Error('Refusing navigation test outside owned synthetic fixture');
  const origin = page.url();
  const evidence = '/home/work/tmp/tessera-534-d006/screenshots/';
  const snap = name => page.screenshot({path:evidence+name+'.png'});
  const click = name => page.getByRole('button',{name,exact:true}).click();
  await page.setViewportSize({width:1280,height:960});
  await snap('01-paused-rule-list');
  await click('New automation');
  await click('Repeat a message · Heartbeat');
  await page.locator('textarea[name=prompt]').fill('Preserved new Heartbeat draft');
  await snap('02-unsaved-heartbeat-draft');
  await click('Back');
  await click('Retained review · Paused');
  await click('Resume');
  await page.getByText('Sends your fixed message without judging completion.',{exact:true}).waitFor();
  await snap('03-resume-preview-context-unavailable');
  await click('Delete automation');
  await snap('04-delete-confirmation');
  await click('Confirm delete');
  await page.getByRole('status').filter({hasText:'Draining'}).waitFor();
  await snap('05-deleted-rule-still-draining');
  await click('Back');
  // Regression: previously this was an empty setup with intent=resume.
  await page.getByRole('button',{name:'Repeat a message · Heartbeat',exact:true}).waitFor({timeout:2000});
  await snap('06-back-restores-method-chooser');
  await click('Repeat a message · Heartbeat');
  if (await page.locator('textarea[name=prompt]').inputValue() !== 'Preserved new Heartbeat draft') throw new Error('New method draft was lost');
  if (!await page.getByRole('button',{name:'Pause to type',exact:true}).isVisible()) throw new Error('Deleted held ownership lost Pause');
  await snap('07-new-setup-retains-draft-and-held-pause');
  await click('Include deleted rules');
  await click('Retained review · Deleted');
  await page.getByRole('tab',{name:'History',exact:true}).click();
  await page.getByText('Prompt delivered',{exact:true}).waitFor();
  if (!await page.getByText('Instruction attempts: 2/10',{exact:true}).isVisible()) throw new Error('Deleted lifetime counters/history lost');
  await snap('08-deleted-history-remains-readable');
  await click('Close');
  if (await page.getByRole('textbox',{name:'Worker draft',exact:true}).inputValue() !== 'Retained worker draft') throw new Error('Worker draft changed');
  await click('Inspect fixture writes');
  if (await page.getByLabel('Fixture writes').textContent() !== 'DELETE /api/automations/rule-1') throw new Error('Navigation automatically created, enabled, paused or replaced a rule');
  // A rejected DELETE stays in the existing Resume draft and confirmation.
  await page.goto(origin+'?reject-delete');
  await click('Retained review · Paused'); await click('Resume');
  await click('Delete automation'); await click('Confirm delete');
  await page.getByText('This rule changed in another window. Review the current version before editing or enabling again.',{exact:true}).waitFor();
  if (!await page.getByRole('button',{name:'Confirm delete',exact:true}).isVisible()) throw new Error('Failed deletion discarded confirmation/context');
  await snap('09-rejected-delete-retains-resume-context');
  await page.goto(origin+'?delay-delete');
  await click('Retained review · Paused'); await click('Resume');
  await click('Delete automation'); await click('Confirm delete');
  await click('Back'); await click('New automation');
  await click('Repeat a message · Heartbeat');
  await page.locator('textarea[name=prompt]').fill('New draft while deletion settles');
  await page.getByRole('status').filter({hasText:'Draining'}).waitFor();
  if (!await page.getByRole('button',{name:'Repeat a message · Heartbeat',exact:true}).isVisible()) throw new Error('Late delete reopened old rule');
  if (await page.locator('textarea[name=prompt]').inputValue() !== 'New draft while deletion settles') throw new Error('Late delete changed active navigation draft');
  await snap('10-late-delete-preserves-new-navigation');
  console.log('PASS D006 real shared rendered interactions: Resume/delete/Back, drafts, deleted history/counters, held Pause, no automatic rule writes, failed delete context. Synthetic transport only.');
}
