import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
await mkdir('evidence/walkthrough',{recursive:true});
const report=[];
try {
  for(const width of [1440,768,390]){
    const page=await browser.newPage({viewport:{width,height:1000},locale:'zh-CN',reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://api.github.com/**',r=>r.fulfill({json:{}}));
    await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle'});
    assert.equal(await page.locator('#pcb2-film').isVisible(),false);
    await page.locator('#pcb2-story').scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('#pcb2-story').dataset.ready==='true');
    const pose=()=>page.locator('#story-model').evaluate(el=>JSON.parse(el.dataset.pose));
    for(let step=0;step<5;step++){
      await page.locator(`#story-tab-${step}`).click();
      assert.equal(await page.locator('#pcb2-story').getAttribute('data-step'),String(step));
      assert.equal(await page.locator(`#story-tab-${step}`).getAttribute('aria-selected'),'true');
      const p=await pose();assert.equal(p.step,step);
      assert.equal(await page.locator('#story-download').isVisible(),step===4);
      assert.equal(await page.locator('#story-timeline').isVisible(),step===3);
      if(width===1440)await page.locator('#pcb2-story').screenshot({path:`evidence/walkthrough/desktop-step-${step}.png`});
    }
    assert.equal(await page.locator('#story-next').isDisabled(),true);
    await page.locator('#story-tab-0').click();assert.equal(await page.locator('#story-prev').isDisabled(),true);
    await page.locator('#story-tab-0').press('ArrowRight');assert.equal(await page.locator('#pcb2-story').getAttribute('data-step'),'1');
    await page.locator('#story-tab-1').press('End');assert.equal(await page.locator('#pcb2-story').getAttribute('data-step'),'4');
    await page.locator('#story-tab-3').click();
    assert.equal(await page.locator('#story-pause').isDisabled(),true);
    await page.locator('[data-phase="0"]').click();const exploded=await pose();assert.equal(exploded.unit,30);assert.equal(exploded.cover,72);
    if(width===1440)await page.locator('#pcb2-story').screenshot({path:'evidence/walkthrough/desktop-exploded.png'});
    await page.locator('[data-phase="0.56"]').click();const clamped=await pose();assert.ok(Math.abs(clamped.base+4-clamped.metal)<1e-7);assert.ok(Math.abs(clamped.metal+.3-clamped.cover)<1e-7);assert.equal(clamped.unit,30);
    assert.ok(clamped.clamp>.99);assert.equal(clamped.posts,0);
    assert.equal(await page.locator('#story-callout-lines').isVisible(),true);
    assert.equal(await page.locator('#story-callout-title').innerText(),'三层组件，周圈夹紧');
    if(width===1440)await page.locator('#pcb2-story').screenshot({path:'evidence/walkthrough/desktop-clamped.png'});
    await page.locator('[data-phase="1"]').click();const seated=await pose();assert.equal(seated.unit,0);assert.equal(seated.base,4);assert.equal(seated.metal,8);
    assert.equal(await page.locator('#story-status').innerText(),'落位完成');
    assert.ok(seated.posts>.3);assert.equal(seated.clamp,0);assert.ok(seated.shadow>clamped.shadow);
    assert.equal(await page.locator('#story-callout-title').innerText(),'四角定位柱，引导落位');
    const guide=await page.locator('#story-guide-dot').evaluate(el=>{const r=el.ownerSVGElement.getBoundingClientRect();return {x:Number(el.getAttribute('cx')),y:Number(el.getAttribute('cy')),w:r.width,h:r.height};});
    assert.ok(guide.x>0&&guide.x<guide.w&&guide.y>0&&guide.y<guide.h);
    const overflow=await page.locator('#pcb2-story').evaluate(el=>[...el.querySelectorAll('button,canvas,h3,p')].some(c=>{if(!c.getClientRects().length)return false;const r=c.getBoundingClientRect(),s=el.getBoundingClientRect();return r.right>s.right+1||r.left<s.left-1;}));assert.equal(overflow,false);
    await page.locator('#pcb2-story').screenshot({path:`evidence/walkthrough/site-${width}-zh.png`});
    await page.locator('#lang-toggle').click();
    await page.waitForFunction(()=>document.querySelector('#story-title').textContent==='Clamp first. Lower together.');
    assert.equal(await page.locator('#story-title').innerText(),'Clamp first. Lower together.');
    await page.locator('#pcb2-story').scrollIntoViewIfNeeded();
    await page.locator('#pcb2-story').screenshot({path:`evidence/walkthrough/site-${width}-en.png`});
    // A horizontal touch gesture navigates; a mostly vertical gesture does not.
    await page.locator('#story-visual').evaluate(el=>{
      const fire=(type,x,y)=>{const e=new Event(type,{bubbles:true});Object.defineProperty(e,type==='touchstart'?'touches':'changedTouches',{value:[{clientX:x,clientY:y}]});el.dispatchEvent(e);};
      fire('touchstart',250,150);fire('touchend',100,155);
    });
    assert.equal(await page.locator('#pcb2-story').getAttribute('data-step'),'4');
    await page.locator('#story-visual').evaluate(el=>{
      const fire=(type,x,y)=>{const e=new Event(type,{bubbles:true});Object.defineProperty(e,type==='touchstart'?'touches':'changedTouches',{value:[{clientX:x,clientY:y}]});el.dispatchEvent(e);};
      fire('touchstart',100,100);fire('touchend',110,220);
    });assert.equal(await page.locator('#pcb2-story').getAttribute('data-step'),'4');
    await page.locator('#story-film-details summary').click();assert.equal(await page.locator('#pcb2-film').isVisible(),true);
    await page.evaluate(async()=>{const v=document.querySelector('#pcb2-film');v.muted=true;await v.play();v.pause();});
    await page.locator('#story-film-details summary').click();assert.equal(await page.locator('#pcb2-film').isVisible(),false);
    assert.deepEqual(errors,[]);report.push({width,steps:5,languages:2,clamped,seated,overflow,errors});await page.close();
  }
  const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});
  await page.route('https://api.github.com/**',r=>r.fulfill({json:{}}));
  await page.goto('http://127.0.0.1:4173/#example');await page.waitForFunction(()=>document.querySelector('#pcb2-story').dataset.ready==='true');
  // Record actual intermediate camera poses, then interrupt multiple transitions.
  await page.evaluate(()=>{
    window.storyCameraFrames=[];
    document.querySelector('#story-tab-1').click();
    const sample=()=>{const model=document.querySelector('#story-model');window.storyCameraFrames.push(JSON.parse(model.dataset.pose));if(model.dataset.transitioning==='true')requestAnimationFrame(sample);};
    requestAnimationFrame(sample);
  });
  await page.waitForFunction(()=>document.querySelector('#story-model').dataset.transitioning==='false');
  const cameraFrames=await page.evaluate(()=>window.storyCameraFrames);
  assert.ok(cameraFrames.some(p=>p.camera[0]>0&&p.camera[0]<165));
  assert.equal(cameraFrames.at(-1).camera[0],0);
  await page.evaluate(()=>{document.querySelector('#story-tab-3').click();document.querySelector('#story-tab-2').click();document.querySelector('#story-tab-4').click();});
  await page.waitForFunction(()=>document.querySelector('#story-model').dataset.transitioning==='false');
  assert.equal(await page.locator('#pcb2-story').getAttribute('data-step'),'4');
  assert.equal(await page.locator('#story-model').getAttribute('data-focus'),'none');
  const idlePose=await page.locator('#story-model').getAttribute('data-pose');
  await page.waitForTimeout(300);assert.equal(await page.locator('#story-model').getAttribute('data-pose'),idlePose);
  await page.locator('#story-tab-3').click();await page.waitForFunction(()=>JSON.parse(document.querySelector('#story-model').dataset.pose).phase>.06);
  await page.locator('#story-pause').click();const a=await page.locator('#story-model').getAttribute('data-pose');
  await page.waitForTimeout(250);assert.equal(await page.locator('#story-model').getAttribute('data-pose'),a);
  await page.locator('#story-pause').click();await page.waitForFunction(()=>JSON.parse(document.querySelector('#story-model').dataset.pose).phase===1,{},{timeout:12000});
  const replayPhase=await page.locator('#story-replay').evaluate(button=>{button.click();return JSON.parse(document.querySelector('#story-model').dataset.pose).phase;});
  assert.equal(replayPhase,0);await page.waitForFunction(()=>JSON.parse(document.querySelector('#story-model').dataset.pose).phase>.01);
  await page.locator('#story-tab-0').click();assert.equal(await page.locator('#story-assembly-controls').isVisible(),false);
  await page.locator('#story-tab-3').click();
  await page.locator('#story-model canvas').evaluate(canvas=>canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await page.waitForFunction(()=>document.querySelector('#pcb2-story').dataset.ready==='fallback');
  assert.equal(await page.locator('#story-fallback').isVisible(),true);
  assert.equal(await page.locator('#story-replay').isDisabled(),true);
  assert.equal(await page.locator('[data-phase="1"]').isDisabled(),true);
  await page.locator('#story-tab-4').click();assert.equal(await page.locator('#story-download').isVisible(),true);
  await page.close();
  // WebGL failure is recoverable at the page level: all copy/navigation still work.
  const fallback=await browser.newPage({viewport:{width:390,height:900},locale:'zh-CN'});
  await fallback.route('https://api.github.com/**',r=>r.fulfill({json:{}}));
  await fallback.addInitScript(()=>{const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return String(type).includes('webgl')?null:get.call(this,type,...args);};});
  await fallback.goto('http://127.0.0.1:4173/#example');await fallback.waitForFunction(()=>document.querySelector('#pcb2-story').dataset.ready==='fallback');
  await fallback.locator('#story-tab-4').click();assert.equal(await fallback.locator('#story-download').isVisible(),true);await fallback.close();
  await writeFile('evidence/walkthrough/verification.json',JSON.stringify({report,animation:'pause, resume, complete, replay and step cancellation passed',transitions:'intermediate camera poses, rapid cancellation and idle passed',callouts:'clamp and posts highlight, projected guides and tightening shadow passed',webglFallback:'passed'},null,2));
  console.log(JSON.stringify({report,animation:'passed',transitions:'passed',callouts:'passed',webglFallback:'passed'},null,2));
} finally {await browser.close();}
