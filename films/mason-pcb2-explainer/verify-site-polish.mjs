import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const browser = await chromium.launch({headless: true});
await mkdir('evidence/polish', {recursive: true});
const report = [];
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://api.github.com/**', route => route.fulfill({json: {}}));
  await page.goto('http://127.0.0.1:4173/');
  await page.waitForFunction(() => document.documentElement.classList.contains('reveal-ready'));
  assert.equal(await page.locator('.mode-jig').evaluate(el => getComputedStyle(el).opacity), '0');
  await page.locator('#modes').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .reveal')].every(el => el.classList.contains('in')));
  await page.waitForTimeout(850);
  const entered = await page.locator('.mode-jig').evaluate(el => ({translate: getComputedStyle(el).translate, opacity: getComputedStyle(el).opacity}));
  assert.equal(entered.opacity, '1');
  const card = page.locator('.mode-jig');
  await card.hover({position: {x: 200, y: 160}});
  await page.waitForTimeout(320);
  assert.equal(await card.getAttribute('data-pointer-active'), 'true');
  const hovering = await card.evaluate(el => ({transform: getComputedStyle(el).transform, spot: el.style.getPropertyValue('--spot-x')}));
  assert.notEqual(hovering.transform, 'none');
  assert.notEqual(hovering.spot, '');
  await page.locator('#modes').screenshot({path: 'evidence/polish/desktop-modes.png'});
  await page.mouse.move(0, 0);
  assert.equal(await card.getAttribute('data-pointer-active'), null);
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.locator('#modes').scrollIntoViewIfNeeded();
  assert.equal(await card.getAttribute('class').then(c => c.includes('in')), true);
  assert.equal(await card.evaluate(el => getComputedStyle(el).opacity), '1');

  await page.locator('#pcb2-story').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#pcb2-story').dataset.ready === 'true');
  await page.waitForTimeout(700);
  const next = page.locator('#story-next');
  await next.hover(); await page.waitForTimeout(280);
  assert.notEqual(await next.locator('.button-arrow').evaluate(el => getComputedStyle(el).transform), 'none');
  await page.mouse.down(); await page.waitForTimeout(260);
  assert.equal(await next.evaluate(el => el.matches(':active')), true);
  const pressed = await next.evaluate(el => getComputedStyle(el).transform);
  assert.notEqual(pressed, 'none');
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('#story-model').dataset.transitioning === 'false');
  assert.equal(await page.locator('#pcb2-story').getAttribute('data-step'), '1');
  await page.locator('#lang-toggle').click();
  assert.equal(await page.locator('#story-prev [data-nav-label]').innerText(), 'Previous');
  await page.locator('#pcb2-story').screenshot({path: 'evidence/polish/desktop-dimensions.png'});

  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.waitForFunction(() => !document.documentElement.classList.contains('reveal-ready'));
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('reveal-ready')), false);
  assert.equal(await page.locator('.reveal:not(.in)').count(), 0);
  await page.locator('#modes').scrollIntoViewIfNeeded(); await card.hover();
  assert.equal(await card.getAttribute('data-pointer-active'), null);
  assert.equal(await card.evaluate(el => getComputedStyle(el).transform), 'none');
  assert.deepEqual(errors, []);
  report.push({desktop: 'one-time reveals, card spotlight/lift, button press/arrow and reduced motion passed'});
  await page.close();

  for (const width of [1440, 768, 390]) {
    const page = await browser.newPage({viewport: {width, height: 1000}, reducedMotion: 'reduce', hasTouch: width === 390, isMobile: width === 390});
    await page.route('https://api.github.com/**', route => route.fulfill({json: {}}));
    await page.goto('http://127.0.0.1:4173/#example');
    await page.waitForFunction(() => document.querySelector('#pcb2-story').dataset.ready === 'true');
    for (const step of [0, 1]) {
      await page.locator(`#story-tab-${step}`).click();
      assert.equal(await page.locator('#story-dimensions').isVisible(), true);
      assert.equal(await page.locator('#story-width-label').textContent(), '85 mm');
      assert.equal(await page.locator('#story-height-label').textContent(), '60 mm');
      const bounds = await page.locator('#story-dimensions').evaluate(svg => {
        const {width, height} = svg.getBoundingClientRect();
        return [...svg.querySelectorAll('path,text')].map(el => {const b = el.getBoundingClientRect(), r = svg.getBoundingClientRect(); return {x: b.left-r.left,y: b.top-r.top,w: b.width,h: b.height,width,height};});
      });
      assert.ok(bounds.every(b => b.x >= 0 && b.y >= 0 && b.x+b.w <= b.width && b.y+b.h <= b.height), `Dimensions must fit at ${width}px / step ${step}`);
      await page.locator('#pcb2-story').scrollIntoViewIfNeeded();
      await page.waitForTimeout(180);
      await page.locator('#pcb2-story').screenshot({path: `evidence/polish/dimensions-${width}-${step}.png`});
    }
    await page.locator('#story-tab-2').click();
    assert.equal(await page.locator('#story-dimensions').isVisible(), false);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false);
    report.push({width, dimensions: 'projected labels fit in both views', overflow});
    await page.close();
  }
  // The reading content remains visible even when scripts cannot run.
  const noJS = await browser.newPage({javaScriptEnabled: false});
  await noJS.goto('http://127.0.0.1:4173/');
  assert.equal(await noJS.locator('.mode-jig').evaluate(el => getComputedStyle(el).opacity), '1');
  await noJS.close();
  await writeFile('evidence/polish/verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
