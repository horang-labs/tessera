async page => {
  const base=page.url().split('?')[0];if(!base.startsWith('http://172.17.241.221:34539/'))throw Error('Wrong owned fixture');
  await page.goto(base+'?gate-events&late');await page.getByRole('button',{name:'Open fixture manager',exact:true}).click();
  const start=page.locator('[data-ph-capture-attribute-control="automation.autorun.start"]');
  await page.waitForFunction(()=>!document.querySelector('[data-ph-capture-attribute-control="automation.autorun.start"]').disabled);
  await page.locator('[name="supervisorModel"]').selectOption('gpt-6-astra');await page.locator('[name="supervisorEffort"]').selectOption('xhigh');
  const emit=payload=>page.evaluate(payload=>window.dispatchEvent(new CustomEvent('fixture-terminal-state',{detail:{type:'session_state',sessionId:'session-1',terminalId:'term-1',status:'running',...payload}})),payload);
  const count=()=>page.evaluate(()=>window.fixturePreviewRequests.length);
  const before=await count();
  await emit({hookEvent:'PreToolUse',preview:'Reading…',interruptInputPolicy:'single-escape',stateAt:2});
  await emit({hookEvent:'PostToolUse',preview:'Read complete',interruptInputPolicy:'none',stateAt:3});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  if(await count()!==before)throw Error('Display-only event restarted selected attestation');
  await emit({hookEvent:'ControlPromptSubmit',stateAt:4});
  await page.waitForFunction(before=>window.fixturePreviewRequests.length===before+1,before);
  const last=await page.evaluate(()=>window.fixturePreviewRequests.at(-1));
  if(last.supervisor.model!=='gpt-6-astra'||last.supervisor.reasoningEffort!=='xhigh')throw Error('True gate change rechecked previous tuple');
  await page.waitForFunction(()=>!document.querySelector('[data-ph-capture-attribute-control="automation.autorun.start"]').disabled);
  if(await start.isDisabled())throw Error('Fresh selected check did not settle');
  return 'PASS: two display-only updates cause zero requests; accepted submission rechecks current Astra/xhigh tuple';
}
