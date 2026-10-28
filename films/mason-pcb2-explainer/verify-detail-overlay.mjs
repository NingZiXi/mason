import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const reports=[];
await mkdir('evidence/detail-overlay',{recursive:true});
try {
  for(const [width,height] of [[1440,1000],[390,844],[844,390],[320,640]]) {
    const page=await browser.newPage({viewport:{width,height},locale:'zh-CN',reducedMotion:'reduce'});
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://api.github.com/**',route=>route.fulfill({json:{}}));
    await page.goto('http://127.0.0.1:4173/#example');
    await page.locator('#story-detail-open').click();
    await page.waitForFunction(()=>document.querySelector('#detail-status').hidden);
    const state=await page.evaluate(()=>{
      const dialog=document.querySelector('#story-detail');
      const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      const css=getComputedStyle(dialog), backdrop=getComputedStyle(dialog,'::backdrop');
      return {dialog:rect(dialog),canvas:rect(document.querySelector('#detail-model canvas')),background:css.backgroundColor,border:css.borderWidth,shadow:css.boxShadow,blur:backdrop.backdropFilter,inspection:JSON.parse(document.querySelector('#detail-model').dataset.inspection),controls:[...dialog.querySelectorAll('button,.detail-note,.detail-hint')].map(rect),overflow:dialog.scrollHeight>dialog.clientHeight+1};
    });
    assert.equal(state.inspection.preset,'overview');
    assert.equal(state.background,'rgba(0, 0, 0, 0)');
    assert.equal(state.border,'0px');assert.equal(state.shadow,'none');assert.ok(state.blur.includes('blur(18px)'));
    assert.equal(state.dialog.x,0);assert.equal(state.dialog.y,0);
    assert.equal(state.dialog.width,width);assert.equal(state.dialog.height,height);
    assert.ok(state.canvas.height>100);assert.equal(state.overflow,false);
    assert.ok(Math.abs(state.canvas.x+state.canvas.width/2-width/2)<2);
    for(const box of state.controls){assert.ok(box.x>=0&&box.y>=0&&box.right<=width+1&&box.bottom<=height+1,JSON.stringify(box));}
    assert.deepEqual(errors,[]);
    await page.screenshot({path:`evidence/detail-overlay/${width}x${height}.png`});
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'story-detail-open');
    reports.push({width,height,...state,errors});await page.close();
  }
  await writeFile('evidence/detail-overlay/report.json',JSON.stringify(reports,null,2));
  console.log('Transparent fullscreen detail overlay passed at 4 viewport sizes.');
}finally{await browser.close();}
