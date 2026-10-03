async page => {
  const origin = page.url().split('/candidate/')[0].split('/base/')[0];
  if (!origin.endsWith(':34539')) throw new Error('Not the owned fixture server');
  const root = '/home/work/tmp/tessera-534-polish-ui/representative';
  let index = 0;
  const control = id => page.locator(`[data-ph-capture-attribute-control="${id}"]`);
  const shot = async name => {
    await page.screenshot({ path: `${root}/${String(++index).padStart(2,'0')}-${name}.png` });
  };
  const profiles = [
    { theme: 'dark', language: 'en', width: 1440, height: 1000 },
    { theme: 'light', language: 'ko', width: 390, height: 844 },
  ];
  const open = async (variant, profile, extra = '') => {
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await page.goto(`${origin}/${variant}/?theme=${profile.theme}&language=${profile.language}${extra}`);
    if (!await page.locator('[data-automation-polish-fixture="synthetic"]').count()) throw new Error('Missing fixture guard');
    await page.getByRole('button', { name: 'Open fixture manager', exact: true }).click();
    await page.locator('dialog[open]').waitFor();
    if (!extra.includes('schedule')) await control('automation.autorun.start').waitFor();
  };
  const expandAutorun = async () => {
    await control('automation.autorun.objective_edit').click();
    await control('automation.autorun.criteria').click();
    await page.locator('[name="constraints"]').fill('Preserve the public API.\n공개 API와 저장한 초안을 유지해 주세요.');
    await page.locator('[name="criteria"]').fill('Regression test passes.\n회귀 테스트 통과');
    await control('automation.form.advanced').click();
  };
  const bottom = async () => {
    const body = page.locator('[data-automation-scroll]');
    await (await body.count() ? body : page.locator('dialog')).evaluate(el => el.scrollTop = el.scrollHeight);
  };
  await open('base', profiles[0]); await expandAutorun(); await bottom();
  await shot('baseline-dark-en-expanded-bottom');
  for (const profile of profiles) {
    const name = `${profile.theme}-${profile.language}-${profile.width}`;
    await open('candidate', profile); await shot(`${name}-autorun-default`);
    await expandAutorun(); await shot(`${name}-autorun-expanded-top`);
    await bottom(); await shot(`${name}-autorun-expanded-bottom`);
  }
  // One shared-form spot check; no history/theme/locale matrix.
  await open('candidate', profiles[0]);
  await control('automation.setup.heartbeat').click();
  await page.locator('[name="prompt"]').fill('Review the latest change and report the result.');
  await control('automation.form.advanced').click(); await bottom();
  await shot('dark-en-wide-heartbeat-expanded');
  await open('candidate', profiles[0], '&schedule');
  await page.locator('[name="prompt"]').fill('Review the changed files.');
  await page.locator('[name="at"]').fill('2027-01-16T09:00');
  await shot('dark-en-wide-schedule-once');
  return `${index} ordered synthetic UI screenshots captured; visual inspection required`;
}
