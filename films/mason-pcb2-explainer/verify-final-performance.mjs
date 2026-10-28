import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const evidence = 'evidence/final-performance';
await mkdir(evidence, {recursive: true});
const browser = await chromium.launch({headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
const report = {note: 'Local Chromium checks; software WebGL and simulated network/CPU do not represent a physical phone or production CDN.', runs: []};
try {
  for (const profile of [
    {name: 'desktop', width: 1440, height: 1000, dpr: 1},
    {name: 'phone', width: 390, height: 844, dpr: 2, touch: true},
    {name: 'phone-slow', width: 390, height: 844, dpr: 2, touch: true, slow: true},
  ]) {
    const context = await browser.newContext({viewport: {width: profile.width, height: profile.height}, deviceScaleFactor: profile.dpr, isMobile: !!profile.touch, hasTouch: !!profile.touch, locale: 'zh-CN'});
    const page = await context.newPage();
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.route('https://api.github.com/**', route => route.fulfill({json: {}}));
    await page.addInitScript(() => {
      window.finalMetrics = {lcp: 0, cls: 0, longTasks: []};
      new PerformanceObserver(list => list.getEntries().forEach(entry => finalMetrics.lcp = entry.startTime)).observe({type: 'largest-contentful-paint', buffered: true});
      new PerformanceObserver(list => list.getEntries().forEach(entry => {if (!entry.hadRecentInput) finalMetrics.cls += entry.value;})).observe({type: 'layout-shift', buffered: true});
      new PerformanceObserver(list => list.getEntries().forEach(entry => finalMetrics.longTasks.push({start: entry.startTime, duration: entry.duration}))).observe({type: 'longtask', buffered: true});
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    if (profile.slow) {
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 80, downloadThroughput: 200000, uploadThroughput: 100000});
      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
    }
    await page.goto('http://127.0.0.1:4173/');
    await page.waitForTimeout(profile.slow ? 2600 : 1000);
    const initial = await page.evaluate(() => ({...finalMetrics, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime, resources: performance.getEntriesByType('resource').map(entry => ({url: entry.name.split('/').pop(), bytes: entry.decodedBodySize})), paused: [...document.querySelectorAll('.feat,.showcase')].every(el => el.classList.contains('motion-paused')), overflow: document.documentElement.scrollWidth > innerWidth + 1}));
    assert.equal(initial.overflow, false);
    assert.equal(initial.paused, true, 'Offscreen ambient timelines must pause');
    assert.ok(!requests.some(url => /\.(?:bin|mp4)$|board\.json|pcb2-scene-/.test(url)), 'No CAD or video download on the hero');
    assert.ok(initial.cls < .05, 'Initial content should stay stable');
    await page.screenshot({path: `${evidence}/${profile.name}-hero.png`});

    // Carousel only advances while visible, and preference changes take effect immediately.
    if (!profile.slow) {
      const activeShot = () => page.locator('.shot-item.is-active').getAttribute('data-shot');
      const first = await activeShot();
      await page.waitForTimeout(4700);
      assert.equal(await activeShot(), first, 'Carousel must remain still offscreen');
      await page.locator('#showcase-stage').evaluate(el => el.scrollIntoView({behavior: 'instant', block: 'center'}));
      await page.waitForTimeout(4700);
      assert.notEqual(await activeShot(), first, 'Visible carousel should advance');
      await page.emulateMedia({reducedMotion: 'reduce'});
      const still = await activeShot();
      await page.waitForTimeout(4700);
      assert.equal(await activeShot(), still, 'Reduced motion must stop the carousel');
      await page.emulateMedia({reducedMotion: 'no-preference'});
      await page.locator('.shot-item').first().click();
      await page.evaluate(() => scrollTo({top: 0, behavior: 'instant'}));
      await page.waitForTimeout(300);
    }

    // Warm the CAD preview before measuring normal page scrolling separately.
    await page.locator('#example').evaluate(el => el.scrollIntoView({behavior: 'instant', block: 'center'}));
    await page.waitForFunction(() => document.querySelector('#pcb2-story').dataset.ready === 'true', null, {timeout: 30000});
    if (profile.slow) await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
    await page.emulateMedia({reducedMotion: 'reduce'});
    await page.locator('#story-tab-3').click();
    await page.waitForTimeout(300);
    await page.emulateMedia({reducedMotion: 'no-preference'});
    await page.evaluate(() => scrollTo({top: 0, behavior: 'instant'}));
    await page.waitForTimeout(700);
    const before = await cdp.send('Performance.getMetrics');
    const frames = await page.evaluate(async () => {
      const intervals = []; let start, previous;
      const startedAt = performance.now();
      const max = document.documentElement.scrollHeight - innerHeight;
      await new Promise(resolve => {
        function tick(now) {
          start ??= now;
          if (previous) intervals.push(now - previous);
          previous = now;
          const progress = Math.min(1, (now - start) / 2800);
          scrollTo({top: max * progress, behavior: 'instant'});
          if (progress < 1) requestAnimationFrame(tick); else resolve();
        }
        requestAnimationFrame(tick);
      });
      return {intervals, startedAt, finishedAt: performance.now()};
    });
    const after = await cdp.send('Performance.getMetrics');
    const delta = name => (after.metrics.find(m => m.name === name).value - before.metrics.find(m => m.name === name).value) * 1000;
    const sorted = [...frames.intervals].sort((a,b) => a-b);
    const longTasks = await page.evaluate(({startedAt, finishedAt}) => finalMetrics.longTasks.filter(task => task.start < finishedAt && task.start + task.duration > startedAt), frames);
    const scrolling = {cpuThrottled: false, frames: sorted.length, medianMs: sorted[Math.floor(sorted.length*.5)], p95Ms: sorted[Math.floor(sorted.length*.95)], maxMs: Math.max(...sorted), framesOver50ms: sorted.filter(ms => ms > 50).length, longTasks, layoutMs: delta('LayoutDuration'), scriptMs: delta('ScriptDuration')};
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.equal(await page.locator('.hero').evaluate(el => el.classList.contains('motion-paused')), true);
    assert.ok(!requests.some(url => /\.mp4(?:\?|$)/.test(url)), 'Video stays deferred');
    if (profile.touch && !profile.slow) {
      await page.locator('#example').evaluate(el => el.scrollIntoView({behavior: 'instant', block: 'center'}));
      await page.locator('#story-tab-0').click();
      const visual = page.locator('#story-visual');
      await visual.dispatchEvent('touchstart', {touches: [{identifier: 1, clientX: 260, clientY: 400}]});
      await visual.dispatchEvent('touchend', {changedTouches: [{identifier: 1, clientX: 260, clientY: 240}]});
      assert.equal(await page.locator('#pcb2-story').getAttribute('data-step'), '0', 'Vertical scroll must not change steps');
      await visual.dispatchEvent('touchstart', {touches: [{identifier: 1, clientX: 260, clientY: 400}]});
      await visual.dispatchEvent('touchend', {changedTouches: [{identifier: 1, clientX: 100, clientY: 395}]});
      assert.equal(await page.locator('#pcb2-story').getAttribute('data-step'), '1', 'Horizontal swipe must change steps');
      await page.waitForTimeout(750);
      await visual.scrollIntoViewIfNeeded();
      await page.screenshot({path: `${evidence}/phone-story.png`});
      await page.setViewportSize({width: 844, height: 390});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Landscape overflow');
      await page.locator('#story-detail-open').click();
      await page.waitForFunction(() => document.querySelector('#detail-model').dataset.inspection);
      const dialog = await page.locator('#story-detail').evaluate(el => {const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight,scroll:el.scrollHeight,client:el.clientHeight};});
      assert.ok(dialog.top >= -1 && dialog.bottom <= dialog.height + 1, 'Landscape dialog fits viewport');
      await page.screenshot({path: `${evidence}/phone-landscape-detail.png`});
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors, []);
    report.runs.push({profile: profile.name, initial, scrolling, errors});
    await context.close();
  }
} finally {
  await writeFile(`${evidence}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
