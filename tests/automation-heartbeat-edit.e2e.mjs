async page => {
  const base=page.url().split('?')[0];if(!base.startsWith('http://172.17.241.221:34539/'))throw Error('Wrong owned fixture');
  const control=id=>page.locator(`[data-ph-capture-attribute-control="${id}"]`);
  const require=(ok,message)=>{if(!ok)throw Error(message);};
  const open=async query=>{await page.goto(base+'?'+query);await page.getByRole('button',{name:'Open fixture manager',exact:true}).click();};
  await open('heartbeat-edit');await page.getByRole('button',{name:'Resume',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[data-ph-capture-attribute-control="automation.manager.enable"]').disabled);
  await control('automation.manager.enable').click();await page.getByText('Send a new worker instruction before resuming.').waitFor();
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  await page.locator('[name="prompt"]').fill('Corrected saved instruction');
  require(!await page.getByRole('button',{name:'Save changes',exact:true}).isDisabled(),'Disabled Heartbeat edit blocked by boundary recovery');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByRole('alert').waitFor();
  await page.getByRole('button',{name:'Inspect fixture writes'}).evaluate(el=>el.click());
  const edit=JSON.parse(await page.getByLabel('Fixture writes').textContent()).find(item=>item.method==='PUT');
  require(edit?.body.input.enabled===false && edit.body.input.prompt==='Corrected saved instruction','Disabled edit did not submit corrected payload');
  return 'PASS: rejected Heartbeat Resume preserves disabled edit and corrected save payload';
}
