import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  for(const width of [1440,390]) {
    const page=await browser.newPage({viewport:{width,height:900},locale:'zh-CN'});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://api.github.com/**',route=>route.fulfill({json:{}}));
    let release;
    const gate=new Promise(resolve=>release=resolve);
    let requested;
    const assetRequested=new Promise(resolve=>requested=resolve);
    await page.route('**/story/board.json',async route=>{requested();await gate;await route.continue();});
    await page.goto('http://127.0.0.1:4173/#example');
    await page.locator('#story-visual').scrollIntoViewIfNeeded();
    await assetRequested;
    assert.equal(await page.locator('#story-fallback img').count(),0);
    assert.equal(await page.locator('#story-fallback').isVisible(),true);
    assert.equal(await page.locator('#story-model').evaluate(el=>getComputedStyle(el).visibility),'hidden');
    // Switching steps while assets are pending must reveal the selected step.
    await page.locator('#story-tab-1').click();
    release();
    await page.waitForFunction(()=>document.querySelector('#pcb2-story').dataset.ready==='true');
    assert.equal(await page.locator('#story-fallback').isVisible(),false);
    assert.equal(await page.locator('#story-model').evaluate(el=>getComputedStyle(el).visibility),'visible');
    assert.equal(await page.locator('#pcb2-story').getAttribute('data-step'),'1');
    assert.equal(JSON.parse(await page.locator('#story-model').getAttribute('data-pose')).step,1);
    assert.deepEqual(errors,[]);
    // A lost graphics context must hide stale geometry and show the error message.
    await page.locator('#story-model canvas').evaluate(canvas=>canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true})));
    await page.waitForFunction(()=>document.querySelector('#pcb2-story').dataset.ready==='fallback');
    assert.equal(await page.locator('#story-fallback').isVisible(),true);
    assert.equal(await page.locator('#story-model').evaluate(el=>getComputedStyle(el).visibility),'hidden');
    await page.close();
    console.log(`Loading state, pending step change, ready state and context loss passed: ${width}px`);
  }
} finally {await browser.close();}
