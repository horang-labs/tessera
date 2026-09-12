import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';

const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { useWorkspaceFileList } from './src/hooks/use-workspace-file-list';
    window.pending = [];
    window.fetch = (url) => new Promise(resolve => window.pending.push({url, resolve}));
    function Listing({id, project}) {
      const state = useWorkspaceFileList(id, project);
      window.list = state;
      return <pre>{JSON.stringify({files:state.files, loading:state.loading, loaded:state.loadedDirectories})}</pre>;
    }
    function Probe() {
      const [target, setTarget] = useState({id:'A', project:'p', mount:0});
      window.select = (id, project='p', mount=0) => flushSync(() => setTarget({id, project, mount}));
      return <Listing key={target.mount} {...target}/>;
    }
    createRoot(document.getElementById('root')).render(<Probe/>);
  ` },
  bundle: true, write: false, jsx: 'automatic',
});

test('cached listings survive A/B/A, remounts and failed revalidation without a loading frame', async () => {
  const browser = await launchPhoneBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const reply = async (directory, files, directories = [], id = null) => {
      await page.waitForFunction(({directory, id}) => window.pending.some(r => new URL(r.url, 'http://test').searchParams.get('directory') === directory && (!id || r.url.includes('/' + id + '/files'))), {directory, id});
      await page.evaluate(({directory, files, directories, id}) => {
        const index = window.pending.findIndex(r => new URL(r.url, 'http://test').searchParams.get('directory') === directory && (!id || r.url.includes('/' + id + '/files')));
        window.pending.splice(index, 1)[0].resolve(new Response(JSON.stringify({files, directories, workDir:'/workspace'})));
      }, {directory, files, directories, id});
      await page.waitForFunction(file => window.list.files.includes(file), files[0]);
    };
    await reply('', ['a.txt'], ['nested']);
    await page.evaluate(() => { void window.list.loadDirectory('nested'); });
    await reply('nested', ['nested/deep.txt']);
    await page.evaluate(() => window.select('B'));
    await reply('', ['b.txt']);
    const restored = await page.evaluate(() => {
      window.select('A');
      return JSON.parse(document.querySelector('pre').textContent);
    });
    assert.equal(restored.loading, false, 'returning to A must never show a spinner');
    assert.deepEqual(restored.files, ['a.txt', 'nested/deep.txt']);
    assert.deepEqual(restored.loaded, ['', 'nested']);
    await page.evaluate(() => window.pending.splice(0).forEach(r => r.resolve(new Response('{}', {status:403}))));
    assert.equal(await page.evaluate(() => window.list.loading), false);
    const remounted = await page.evaluate(() => {
      window.select('A', 'p', 1);
      return JSON.parse(document.querySelector('pre').textContent);
    });
    assert.deepEqual(remounted.files, restored.files);
    assert.equal(remounted.loading, false);
    const otherProject = await page.evaluate(() => {
      window.select('A', 'other', 1);
      return JSON.parse(document.querySelector('pre').textContent);
    });
    assert.deepEqual(otherProject.files, [], 'project scopes must not share cached files');
    assert.equal(otherProject.loading, true);
    // Even a transport that completes after abort cannot overwrite the new target.
    await page.evaluate(() => window.pending.splice(0).forEach(r => {
      const currentProject = new URL(r.url, 'http://test').searchParams.get('projectId') === 'other';
      r.resolve(new Response(JSON.stringify({files:[currentProject ? 'other.txt' : 'stale.txt']})));
    }));
    await page.waitForFunction(() => window.list.files.includes('other.txt'));
    assert.deepEqual(await page.evaluate(() => window.list.files), ['other.txt']);
    await page.evaluate(() => window.select('A'));
    assert.deepEqual(await page.evaluate(() => window.list.files), restored.files);
    await reply('', ['changed.txt'], [], 'A');
    assert.deepEqual(await page.evaluate(() => window.list.files), ['changed.txt'], 'revalidation removes deleted cached subtrees');
    assert.equal(await page.evaluate(() => window.list.loading), false);

    // Fill the bounded cache, touch A, then insert one more: oldest B is evicted.
    for (let i = 0; i < 17; i++) {
      await page.evaluate(id => window.select(id), 'extra' + i);
      await reply('', ['extra' + i + '.txt'], [], 'extra' + i);
    }
    await page.evaluate(() => window.select('A'));
    await reply('', ['changed.txt'], [], 'A');
    await page.evaluate(() => window.select('last'));
    await reply('', ['last.txt'], [], 'last');
    await page.evaluate(() => window.select('A'));
    assert.equal(await page.evaluate(() => window.list.loading), false, 'recently used A stays cached');
    await page.evaluate(() => window.select('B'));
    assert.equal(await page.evaluate(() => window.list.loading), true, 'least recently used B is evicted');
    assert.deepEqual(await page.evaluate(() => window.list.files), []);
  } finally { await browser.close(); }
});
