import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const baseline = process.argv.includes('--baseline');
const browser = await chromium.launch({headless: true});
const report = [];
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  await page.route('https://api.github.com/**', r => r.fulfill({json: {}}));
  await page.addInitScript(() => {
    window.glWork = {compile: 0, link: 0, upload: 0};
    for (const [method, counter] of [['compileShader', 'compile'], ['linkProgram', 'link'], ['bufferData', 'upload']]) {
      const original = WebGL2RenderingContext.prototype[method];
      WebGL2RenderingContext.prototype[method] = function (...args) { window.glWork[counter]++; return original.apply(this, args); };
    }
  });
  await page.goto('http://127.0.0.1:4173/#example');
  await page.waitForFunction(() => document.querySelector('#pcb2-story').dataset.ready === 'true');
  const gpu = await page.locator('#story-model canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2'), info = gl.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  for (const step of [1, 2, 1, 0, 1, 2, 1]) {
    const result = await page.evaluate(step => new Promise(resolve => {
      const model = document.querySelector('#story-model'), before = {...window.glWork}, frames = [];
      const startPose = JSON.parse(model.dataset.pose);
      const started = performance.now();
      document.querySelector(`#story-tab-${step}`).click();
      function sample() {
        frames.push({at: performance.now() - started, ...JSON.parse(model.dataset.pose)});
        if (model.dataset.transitioning === 'true') requestAnimationFrame(sample);
        else resolve({step, startPose, frames, gl: Object.fromEntries(Object.keys(before).map(k => [k, window.glWork[k] - before[k]]))});
      }
      requestAnimationFrame(sample);
    }), step);
    result.maxFrameGap = Math.max(...result.frames.map((f, i) => f.at - (result.frames[i-1]?.at ?? 0)));
    report.push(result);
  }
  if (!baseline) {
    const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((sum, n, i) => sum + n * b[i], 0))));
    for (const {step, gl, startPose, frames} of report) {
      assert.equal(gl.compile, 0, 'Step changes must not compile new shaders');
      assert.equal(gl.upload, 0, 'Step changes must not upload geometry');
      assert.ok(frames.length >= 3, 'Transition must include intermediate frames');
      assert.equal(frames.at(-1).transitioning, false);
      const end = frames.at(-1).orientation, totalAngle = angle(startPose.orientation, end);
      let remaining = totalAngle;
      for (const f of frames) {
        const next = angle(f.orientation, end);
        assert.ok(next <= remaining + 1e-5, `Step ${step}: camera angle ${next} must not increase from ${remaining} at ${f.at} ms`);
        remaining = next;
        if (f.transitionProgress > .85 && f.transitioning) assert.ok(next < totalAngle * .04 + 1e-5, 'No sudden rotation near the overhead endpoint');
      }
    }
    // Interrupt a partly completed camera move, retaining exactly the displayed pose.
    const interrupted = await page.evaluate(() => new Promise(resolve => {
      const model = document.querySelector('#story-model');
      document.querySelector('#story-tab-0').click();
      function check() {
        const p = JSON.parse(model.dataset.pose);
        if (p.transitioning && p.camera[0] > 5 && p.camera[0] < 155) {
          document.querySelector('#story-tab-2').click();
          resolve({before: p, after: JSON.parse(model.dataset.pose)});
        } else requestAnimationFrame(check);
      }
      requestAnimationFrame(check);
    }));
    assert.deepEqual(interrupted.after.camera, interrupted.before.camera);
    assert.deepEqual(interrupted.after.pcb, interrupted.before.pcb);
    await page.waitForFunction(() => document.querySelector('#story-model').dataset.transitioning === 'false');
  }
  await mkdir('evidence/walkthrough', {recursive: true});
  await writeFile(`evidence/walkthrough/motion${baseline ? '-baseline' : ''}.json`, JSON.stringify({gpu, report}, null, 2));
  console.log(JSON.stringify({gpu, report: report.map(({step, gl, frames, maxFrameGap}) => ({step, gl, frames: frames.length, maxFrameGap}))}, null, 2));
} finally { await browser.close(); }
