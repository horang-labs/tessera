async page => {
  const origin = page.url().split('/').slice(0,3).join('/');
  if (!origin.endsWith(':34539')) throw Error('Wrong fixture origin');
  const root = '/home/work/tmp/tessera-534-redesign-ui/screenshots';
  const control = id => page.locator(`[data-ph-capture-attribute-control="${id}"]`);
  const require = (ok, message) => { if (!ok) throw Error(message); };
  let index = 1;
  const shot = async name => page.screenshot({path:`${root}/${String(++index).padStart(3,'0')}-${name}.png`});
  const load = async (query='', width=390, height=844) => {
    await page.setViewportSize({width,height}); await page.goto(origin+'/?'+query);
    require(await page.locator('[data-automation-polish-fixture="synthetic"]').count(), 'Fixture missing');
  };
  const open = async () => {
    await page.getByRole('button',{name:'Open fixture manager',exact:true}).click();
    await page.locator('dialog[open]').waitFor();
  };
  await load('',1440,1000); await open(); await control('automation.autorun.start').waitFor(); await shot('autorun-default-single-footer');
  await page.locator('[name="supervisorModel"]').selectOption('gpt-6-astra');
  require(await control('automation.autorun.start').isDisabled(), 'Incomplete selection enabled Start');
  await page.locator('[name="supervisorEffort"]').selectOption('xhigh');
  await page.locator('[name="supervisorTier"]').selectOption('fast');
  await page.waitForFunction(() => !document.querySelector('[data-ph-capture-attribute-control="automation.autorun.start"]').disabled);
  await control('automation.form.save').click(); await control('automation.manager.close').click();
  await page.getByRole('button',{name:'Inspect fixture writes'}).click();
  const saved = JSON.parse(await page.getByLabel('Fixture writes').textContent()).at(-1).body;
  require(saved.autorun.supervisor.model === 'gpt-6-astra' && saved.autorun.supervisor.reasoningEffort === 'xhigh' && saved.autorun.supervisor.serviceTier === 'fast', 'Selected tuple coerced');
  require(saved.autorun.objective.kind === 'preview', 'Untouched verified goal became explicit');
  await shot('exact-tuple-verified-goal-payload');
  for (const query of ['held','peek&held&language=ko&theme=light']) {
    await load(query); await shot(query.startsWith('peek') ? 'peek-held-toolbar-390-ko' : 'normal-held-toolbar-390');
    const toolbar = page.getByRole('region',{name:'Shared Session toolbar'});
    require(await control('automation.pause').isVisible(), 'Held Pause inaccessible');
    const bounds = await toolbar.boundingBox(); require(bounds && bounds.width <= 390 && bounds.height <= 66, 'Toolbar adds row or overflows');
  }
  await open(); await control('automation.autorun.start').waitFor(); await shot('autorun-default-390-ko');
  await control('automation.form.advanced').click(); await shot('autorun-expanded-390-ko');
  await page.locator('[data-automation-scroll]').evaluate(el => el.scrollTop=el.scrollHeight); await shot('autorun-expanded-bottom-390-ko');
  await load('loading'); await open(); await page.getByRole('status').filter({hasText:'Checking setup'}).waitFor();
  require(await page.locator('[aria-busy="true"]').count(), 'Missing busy status');
  require(await control('automation.autorun.refresh').count() === 0, 'Retry visible during loading');
  await shot('preflight-loading-390'); await control('automation.setup.heartbeat').click();
  require(await page.locator('[name="prompt"]').isVisible(), 'Loading prevents Heartbeat switch'); await shot('heartbeat-main-form-390');
  await load('schedule',1440,1000); await open(); await page.locator('[name="prompt"]').fill('Review the changed files.');
  await page.locator('[name="at"]').fill('2027-01-16T09:00'); await shot('schedule-main-form-wide');
  return `PASS: ${index-1} visuals; exact alternate tuple/verified objective; normal/Peek390; loading switch/retry gates`;
}
