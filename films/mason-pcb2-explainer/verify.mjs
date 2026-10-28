import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {serve} from './server.mjs';
import JSZip from '../../node_modules/jszip/lib/index.js';
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const report={};
const {server,url}=await serve();
try{
  const film=await browser.newPage({viewport:{width:1920,height:1080}});const errors=[];film.on('pageerror',e=>errors.push(e.message));
  await film.goto(url);await film.evaluate(()=>window.__filmReady);
  report.assembly=[];
  for(const t of [18.6,21.6,15.5,21.6]){
    await film.evaluate(t=>window.seek(t),t);
    const a=await film.evaluate(()=>window.__assembly);
    if(t!==15.5){assert.ok(Math.abs(a.base+4-a.metal)<1e-6);assert.ok(Math.abs(a.metal+.3-a.cover)<1e-6);}
    if(t===21.6){assert.equal(a.unit+a.base,4);assert.equal(a.unit+a.base+4,8);}
    report.assembly.push({t,...a});
  }
  assert.deepEqual(report.assembly[1],report.assembly[3]);
  assert.deepEqual(errors,[]);await film.close();
  const sample=await JSZip.loadAsync(await readFile('../../docs/assets/examples/mason-pcb2-gerber.zip'));
  const source=await JSZip.loadAsync(await readFile('C:/Users/Hszn/Desktop/Gerber_PCB2_2026-09-19.zip'));
  report.sample=[];
  for(const name of ['Gerber_BoardOutlineLayer.GKO','Gerber_TopPasteMaskLayer.GTP','Gerber_BottomPasteMaskLayer.GBP']){
    assert.equal(await sample.file(name).async('string'),await source.file(name).async('string'));report.sample.push(name);
  }
  report.site=[];
  for(const width of [1440,768,390]){
    const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce',locale:'zh-CN'});
    const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
    await page.route('https://api.github.com/**',r=>r.fulfill({json:{}}));
    await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle'});
    assert.equal(await page.locator('.story-video').getAttribute('preload'),'none');
    assert.equal(await page.locator('.story-video').getAttribute('autoplay'),null);
    await page.locator('#example').scrollIntoViewIfNeeded();
    const bounds=await page.locator('#example .wrap').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1);
    const videoBounds=await page.locator('.story-video').boundingBox();assert.ok(Math.abs(videoBounds.width/videoBounds.height-16/9)<.02);
    await page.locator('.story-transcript summary').click();assert.equal(await page.locator('.story-transcript').getAttribute('open'),'');
    await page.locator('#example').screenshot({path:`evidence/site-${width}-zh.png`});
    await page.locator('#lang-toggle').click();assert.match(await page.locator('#pcb2-film-heading').innerText(),/One real board/);
    assert.match(await page.locator('.sample-download').innerText(),/Download sample/);
    await page.locator('#example').screenshot({path:`evidence/site-${width}-en.png`});
    if(width===1440){
      await page.evaluate(async()=>{const v=document.querySelector('video');v.muted=true;await v.play();v.pause();await new Promise((resolve,reject)=>{v.addEventListener('seeked',resolve,{once:true});v.addEventListener('error',()=>reject(v.error),{once:true});v.currentTime=21.6;});});
      const info=await page.locator('video').evaluate(v=>({duration:v.duration,width:v.videoWidth,height:v.videoHeight,error:v.error,readyState:v.readyState}));
      assert.equal(info.duration,28);assert.equal(info.width,1920);assert.equal(info.error,null);report.playback=info;
      for(const lang of ['zh','en']){const response=await page.request.get('http://127.0.0.1:4173/assets/mason-pcb2.'+lang+'.vtt');assert.equal(response.status(),200);assert.match(await response.text(),/^WEBVTT/);}
      const download=await page.request.get('http://127.0.0.1:4173/assets/examples/mason-pcb2-gerber.zip');assert.equal(download.status(),200);
    }
    assert.deepEqual(pageErrors,[]);report.site.push({width,languages:['zh','en'],overflow:false,errors:pageErrors});await page.close();
  }
  await writeFile('evidence/verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();server.close();}
