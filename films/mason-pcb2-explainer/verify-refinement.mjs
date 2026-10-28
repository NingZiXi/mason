import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
await mkdir('evidence/refinement',{recursive:true});
const report=[];
try {
  for(const width of [320,390,768,1024,1440]) {
    const page=await browser.newPage({viewport:{width,height:1000},locale:'zh-CN',reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://api.github.com/**',r=>r.fulfill({json:{}}));
    await page.goto('http://127.0.0.1:4173/');
    await page.waitForTimeout(700);
    const structure=await page.evaluate(()=>({buttons:document.querySelectorAll('button').length,links:document.querySelectorAll('a').length}));
    for(const language of ['zh','en']) {
      if(language==='en') await page.locator('#lang-toggle').click();
      for(const selector of ['.hero','#example','#showcase.showcase-sec','#workflow','#modes','#features','#download','#faq','footer']) {
        const el=page.locator(selector);if(!await el.count())continue;
        await el.evaluate(e=>e.scrollIntoView({behavior:'instant',block:'start'}));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${width}/${language}/${selector}: page overflow`);
        // Check text and controls in the edited regions; scrollers and SVG art
        // intentionally contain offscreen children, so exclude those here.
        const violations=await el.evaluate(root=>[...root.querySelectorAll('h1,h2,h3,.hero-sub,.mode p,.mode li,.feat h3,.feat p,.step h3,.step p,.os-name,.os-file,summary')].filter(e=>{
          if(!e.getClientRects().length||e.closest('svg'))return false;
          const r=e.getBoundingClientRect();return r.width>0&&(r.left< -1||r.right>innerWidth+1||e.scrollWidth>e.clientWidth+2);
        }).map(e=>({class:e.className,text:e.textContent.slice(0,45),width:e.clientWidth,scroll:e.scrollWidth})));
        assert.deepEqual(violations,[],`${width}/${language}/${selector}: text overflow`);
        if([390,1440].includes(width)) {
          if(selector==='.hero')await page.screenshot({path:`evidence/refinement/final-${width}-${language}-hero.png`});
          else await el.screenshot({path:`evidence/refinement/final-${width}-${language}-${selector.replace(/[^a-z]/g,'')}.png`});
        }
      }
      const features=await page.locator('.feats-bento').evaluate(el=>({columns:getComputedStyle(el).gridTemplateColumns.split(' ').length,cards:[...el.children].map(e=>e.clientWidth)}));
      if(width<=600){assert.equal(features.columns,1);assert.ok(features.cards.every(w=>w>240));}
      if(width===768)assert.equal(features.columns,2);
      await page.locator('#faq details').first().locator('summary').click();
      const answer=await page.locator('#faq details').first().locator('.faq-content').evaluate(e=>({height:e.clientHeight,scroll:e.scrollHeight}));
      assert.ok(answer.height>=answer.scroll-2,'FAQ answer must not clip');
      await page.locator('#faq details').first().locator('summary').click();
      report.push({width,language,features,structure,errors});
    }
    assert.deepEqual(errors,[]);await page.close();
  }
  // All existing model steps must fit after the spacing/type changes.
  for(const width of [390,768,1440]) {
    const page=await browser.newPage({viewport:{width,height:1000},locale:'zh-CN',reducedMotion:'reduce'});
    await page.route('https://api.github.com/**',r=>r.fulfill({json:{}}));await page.goto('http://127.0.0.1:4173/#example');
    await page.waitForFunction(()=>document.querySelector('#pcb2-story').dataset.ready==='true');
    for(let step=0;step<5;step++) {
      await page.locator(`#story-tab-${step}`).click();
      const outside=await page.locator('#pcb2-story').evaluate(root=>{
        const b=root.getBoundingClientRect();return [...root.querySelectorAll('button,h3,p')].filter(e=>e.getClientRects().length).some(e=>{const r=e.getBoundingClientRect();return r.left<b.left-1||r.right>b.right+1;});
      });assert.equal(outside,false,`${width}: story step ${step} overflow`);
    }
    await page.locator('#story-detail-open').click();await page.waitForFunction(()=>document.querySelector('#detail-model').dataset.inspection);await page.keyboard.press('Escape');await page.close();
  }
  await writeFile('evidence/refinement/report.json',JSON.stringify(report,null,2));
  console.log('Visual refinement passed at 320, 390, 768, 1024 and 1440px in both languages; story/details passed.');
}finally{await browser.close();}
