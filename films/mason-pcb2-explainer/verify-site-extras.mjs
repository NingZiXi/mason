import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
const browser = await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
await mkdir('evidence/extras', {recursive:true});
const reports=[];
try {
  for (const width of [1440,390]) {
    const page = await browser.newPage({viewport:{width,height:1000},locale:'zh-CN',reducedMotion:'reduce'});
    const errors=[];page.on('pageerror', error=>errors.push(error.message));
    await page.route('https://api.github.com/**',r=>r.fulfill({json:{}}));
    await page.goto('http://127.0.0.1:4173/#example');
    await page.waitForFunction(()=>document.querySelector('#pcb2-story').dataset.ready==='true');
    await page.locator('#story-detail-open').click();
    await page.waitForFunction(()=>document.querySelector('#detail-model').dataset.inspection);
    const inspection=()=>page.locator('#detail-model').evaluate(el=>JSON.parse(el.dataset.inspection));
    for(const preset of ['posts','clamp','apertures']) {
      await page.locator(`[data-preset="${preset}"]`).click();
      await page.waitForFunction(p=>JSON.parse(document.querySelector('#detail-model').dataset.inspection).preset===p,preset);
      assert.equal(await page.locator(`[data-preset="${preset}"]`).getAttribute('aria-pressed'),'true');
      await page.locator('#story-detail').screenshot({path:`evidence/extras/${width}-${preset}.png`});
    }
    const original=await inspection();
    await page.locator('[data-zoom="in"]').click();assert.ok((await inspection()).zoom>original.zoom);
    await page.locator('[data-detail-reset]').click();assert.equal((await inspection()).zoom,1);
    const canvas=page.locator('#detail-model canvas');
    await canvas.focus();await canvas.press('ArrowRight');assert.notDeepEqual((await inspection()).camera,original.camera);
    const box=await canvas.boundingBox();
    const beforeDrag=await inspection();
    await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.7,box.y+box.height*.55,{steps:8});await page.mouse.up();
    assert.notDeepEqual((await inspection()).camera,beforeDrag.camera);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#story-detail').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'story-detail-open');
    assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
    await page.locator('#story-detail-open').click();await page.waitForFunction(()=>document.querySelector('#detail-status').hidden);
    assert.equal(await page.locator('#detail-model canvas').count(),1);
    await page.locator('[data-detail-close]').click();
    for (const mode of ['jig','stencil']) {
      await page.locator(`[data-mode-choice="${mode}"]`).click();
      assert.equal(await page.locator(`.mode-${mode}`).evaluate(el=>el.classList.contains('mode-recommended')),true);
      await page.locator('#mode-guide').screenshot({path:`evidence/extras/${width}-${mode}.png`});
      assert.equal(await page.locator('.mode-recommended').count(),1);
      assert.equal(await page.locator(`[data-mode-choice="${mode}"]`).getAttribute('aria-pressed'),'true');
    }
    await page.locator('#lang-toggle').click();
    await page.waitForFunction(()=>document.querySelector('[data-mode-choice="jig"]').textContent==='I have a metal stencil');
    await page.locator('#story-tab-4').click();
    assert.equal(await page.locator('#story-download span').first().innerText(),'Download this Gerber');
    await page.locator('#story-detail-open').click();await page.waitForFunction(()=>document.querySelector('#detail-status').hidden);
    assert.equal(await page.locator('#detail-title').innerText(),'Explore the construction');
    await page.locator('[data-detail-close]').click();
    assert.equal(await page.locator('.mode-stencil').evaluate(el=>el.classList.contains('mode-recommended')),true);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);
    const download=await page.request.get('http://127.0.0.1:4173/assets/examples/mason-pcb2-gerber.zip');assert.equal(download.status(),200);assert.ok((await download.body()).length>100000);
    assert.deepEqual(errors,[]);reports.push({width,errors,overflow});await page.close();
  }
  // Opening details pauses the main assembly.
  const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});
  await page.route('https://api.github.com/**',r=>r.fulfill({json:{}}));
  await page.goto('http://127.0.0.1:4173/#example');
  await page.waitForFunction(()=>document.querySelector('#pcb2-story').dataset.ready==='true');
  await page.locator('#story-tab-3').click();
  await page.waitForFunction(()=>JSON.parse(document.querySelector('#story-model').dataset.pose||'{}').phase>.04);
  await page.locator('#story-detail-open').click();await page.waitForFunction(()=>document.querySelector('#detail-model').dataset.inspection);
  const pose=await page.locator('#story-model').getAttribute('data-pose');await page.waitForTimeout(300);
  assert.equal(await page.locator('#story-model').getAttribute('data-pose'),pose);
  await page.keyboard.press('Escape');await page.close();
  // The dialog remains usable when WebGL is unavailable.
  const failed=await browser.newPage({viewport:{width:390,height:900},locale:'zh-CN'});
  await failed.addInitScript(()=>{HTMLCanvasElement.prototype.getContext=function(){return null;};});
  await failed.goto('http://127.0.0.1:4173/#example');await failed.locator('#story-detail-open').click();
  await failed.waitForFunction(()=>document.querySelector('#detail-status').textContent.includes('暂不可用'));
  assert.equal(await failed.locator('[data-detail-close]').isVisible(),true);await failed.keyboard.press('Escape');await failed.close();
  await writeFile('evidence/extras/report.json',JSON.stringify(reports,null,2));console.log('Site extras passed:',reports);
} finally {await browser.close();}
