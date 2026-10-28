// Site walkthrough: native controls and copy load first; CAD rendering loads on demand.
import './site-polish.js';
import './pointer-effects.js';
import './site-extras.js';
import './workflow.js';
const host = document.querySelector('#pcb2-story');
const $ = selector => host.querySelector(selector);
const tabs = [...host.querySelectorAll('[data-story-step]')];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let step = 0, phase = 0, playing = false, frame = 0, lastTime = 0;
let inView = false, scene = null, loading = null, sceneFailed = false;
let copyAnimations = [];
let detailOpen = false;
const duration = 6400;
const copy = {
  zh: {
    tabs: ['导入板子', '解析焊盘', '选择模式', '夹紧与落位', '开始体验'],
    titles: ['从你的板子开始。', '轮廓与焊盘，一起读懂。', '两种工具，各有用途。', '先夹紧，再整体落位。', '带上这块板子，试一遍。'],
    text: [
      '这块 85 × 60 mm 的 PCB2 就是本次示例。把 Gerber ZIP 拖进 Mason，让真实板框成为模型的起点。',
      '板框决定外形，锡膏层决定开孔位置。示例顶层解析到 347 个焊盘，底层 106 个，两面数据来自同一份 Gerber。',
      '已有金属钢网，选择配套夹具；快速原型，则可以生成带 PCB 卡槽的一体式打印钢网，独立使用。',
      'A 面顶盖和 B 面底座通过周圈螺丝夹住金属钢网。夹紧后的三层组件，再沿托盘四角定位柱一起落下。',
      '下载同款 Gerber，在 Mason 中导入、预览，再导出 STL 或 STEP。这里的夹具和钢网均由实际建模引擎生成。'
    ],
    notes: ['真实示例 · 85 × 60 mm', '347 个顶层焊盘 · 106 个底层焊盘', '夹具配金属钢网 · 打印钢网独立使用', '四角是定位柱，周圈才是夹紧螺丝', '本地生成 · 支持 STL / STEP 导出'],
    tags: ['PCB2 / YOUR STARTING POINT', 'GERBER / OUTLINE + PASTE', 'TWO MODES / ONE BOARD', 'ASSEMBLY / CLAMP → LOCATE', 'YOUR NEXT BUILD'],
    statuses: ['分解结构', '夹紧钢网', '定位落下', '落位完成'],
    prev: '上一步', next: '下一步', replay: '重播装配', pause: '暂停', resume: '继续播放',
    phases: ['分解', '夹紧', '落位'], download: '下载同款 Gerber',
    legend: ['PCB 托盘', 'B 面底座', '金属钢网', 'A 面顶盖'],
    jig: '金属钢网夹具', stencil: '一体式打印钢网',
    fallback: '模型预览暂不可用，仍可切换步骤或观看下方完整演示。',
    stage: 'PCB2 模型分步讲解', loading: '正在准备模型…',
    outline: '板框轮廓', top: '顶层锡膏', bottom: '底层锡膏', ready: '已识别',
    panelLabel: '讲解步骤',
    callouts: [['01 / CLAMP', '三层组件，周圈夹紧', 'A 面顶盖 · 金属钢网 · B 面底座'], ['02 / LOCATE', '四角定位柱，引导落位', '与托盘一体成型 · 无需角部螺丝']],
  },
  en: {
    tabs: ['Your board', 'Read the pads', 'Choose a mode', 'Clamp & locate', 'Try it yourself'],
    titles: ['Start with your board.', 'Read the outline. Place every pad.', 'Two tools. Different jobs.', 'Clamp first. Lower together.', 'Try this exact board.'],
    text: [
      'Meet PCB2, our 85 × 60 mm example. Drop its Gerber ZIP into Mason and use the real board outline as the starting point for your models.',
      'The outline defines the shape; the paste layers define the openings. This sample contains 347 parsed top-paste pads and 106 bottom-paste pads.',
      'Have a metal stencil? Generate a matching jig. For rapid prototypes, generate a standalone printable stencil with its own PCB pocket.',
      'Perimeter screws clamp the metal stencil between the A-side cover and B-side base. Lower all three together onto the tray’s four alignment posts.',
      'Download the same Gerber, import it into Mason, preview the result and export STL or STEP. The models here come from the actual CAD engine.'
    ],
    notes: ['Real sample · 85 × 60 mm', '347 top pads · 106 bottom pads', 'Metal stencil + jig / standalone printed stencil', 'Corner posts locate. Perimeter screws clamp.', 'Generated locally · STL / STEP export'],
    tags: ['PCB2 / YOUR STARTING POINT', 'GERBER / OUTLINE + PASTE', 'TWO MODES / ONE BOARD', 'ASSEMBLY / CLAMP → LOCATE', 'YOUR NEXT BUILD'],
    statuses: ['Exploded view', 'Clamp the stencil', 'Lower onto the posts', 'Assembly seated'],
    prev: 'Previous', next: 'Next', replay: 'Replay assembly', pause: 'Pause', resume: 'Resume',
    phases: ['Exploded', 'Clamped', 'Seated'], download: 'Download this Gerber',
    legend: ['PCB tray', 'B-side base', 'Metal stencil', 'A-side cover'],
    jig: 'Jig + metal stencil', stencil: 'Standalone printed stencil',
    fallback: 'The model preview is unavailable. You can still explore the steps or watch the complete film below.',
    stage: 'PCB2 step-by-step model walkthrough', loading: 'Preparing the models…',
    outline: 'Board outline', top: 'Top paste', bottom: 'Bottom paste', ready: 'Recognized',
    panelLabel: 'Walkthrough steps',
    callouts: [['01 / CLAMP', 'Clamp all three layers', 'A-side cover · metal stencil · B-side base'], ['02 / LOCATE', 'Locate on four corner posts', 'Built into the tray · no corner screws']],
  }
};
const lang = () => document.documentElement.lang.startsWith('zh') ? 'zh' : 'en';
const t = () => copy[lang()];

function stop(settle = true) {
  playing = false; cancelAnimationFrame(frame); frame = 0;
  if (settle) scene?.settle();
  copyAnimations.forEach(animation => animation.cancel()); copyAnimations = [];
}
function animateCopy(direction) {
  if (reducedMotion.matches || !inView) return;
  copyAnimations = [...host.querySelectorAll('.story-copy > *')].filter(el => !el.hidden).map((el, i) =>
    el.animate([{opacity: 0, transform: `translateX(${direction * 12}px)`}, {opacity: 1, transform: 'translateX(0)'}],
      {duration: 380, delay: i * 18, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'backwards'}));
}
function renderCopy() {
  const c = t();
  tabs.forEach((tab, i) => {
    tab.querySelector('span').textContent = c.tabs[i];
    tab.setAttribute('aria-selected', String(i === step));
    tab.tabIndex = i === step ? 0 : -1;
  });
  $('[role=tablist]').setAttribute('aria-label', c.panelLabel);
  $('#story-panel').setAttribute('aria-labelledby', tabs[step].id);
  $('#story-number').textContent = `0${step + 1} / 05`;
  $('#story-title').textContent = c.titles[step];
  $('#story-description').textContent = c.text[step];
  $('#story-note').textContent = c.notes[step];
  $('#story-stage-tag').textContent = c.tags[step];
  $('#story-visual').setAttribute('aria-label', c.stage + ': ' + c.tabs[step]);
  $('#story-prev').disabled = step === 0;
  $('#story-next').disabled = step === 4;
  $('#story-prev [data-nav-label]').textContent = c.prev;
  $('#story-next [data-nav-label]').textContent = c.next;
  $('#story-replay').textContent = c.replay;
  $('#story-pause').textContent = playing ? c.pause : c.resume;
  $('#story-pause').disabled = sceneFailed || !scene || phase >= 1 || reducedMotion.matches;
  $('#story-replay').disabled = sceneFailed || !scene;
  $('#story-assembly-controls').hidden = step !== 3;
  $('#story-timeline').hidden = step !== 3;
  $('#story-modes-labels').hidden = step !== 2 || sceneFailed;
  $('#story-legend').hidden = step !== 3 || sceneFailed;
  $('#story-callout').hidden = step !== 3 || sceneFailed;
  $('#story-callout-lines').toggleAttribute('hidden', step !== 3 || sceneFailed);
  $('#story-dimensions').toggleAttribute('hidden', step > 1 || sceneFailed);
  $('#story-parse-info').hidden = step !== 1;
  $('#story-download').hidden = step !== 4;
  $('#story-download span').textContent = c.download;
  $('#story-jig-label').textContent = c.jig;
  $('#story-stencil-label').textContent = c.stencil;
  host.querySelectorAll('[data-phase]').forEach((button, i) => {
    button.textContent = c.phases[i];
    button.disabled = sceneFailed || !scene;
  });
  host.querySelectorAll('[data-part-label]').forEach((el, i) => { el.textContent = c.legend[i]; });
  host.querySelectorAll('[data-layer-label]').forEach((el, i) => { el.textContent = [c.outline, c.top, c.bottom][i]; });
  $('#story-ready').textContent = c.ready;
  $('#story-fallback-note').textContent = sceneFailed ? c.fallback : c.loading;
  host.dataset.step = step;
  updateStatus();
}
function updateStatus() {
  const phaseIndex = phase < .2 ? 0 : phase < .64 ? 1 : 2;
  const statusIndex = phase >= .88 ? 3 : phaseIndex;
  const text = step === 3 ? t().statuses[statusIndex] : t().notes[step];
  if ($('#story-status').textContent !== text) $('#story-status').textContent = text;
  host.querySelectorAll('[data-phase]').forEach((el, i) => el.setAttribute('aria-pressed', String(i === phaseIndex)));
  $('#story-progress').style.width = phase * 100 + '%';
  const locating = phase >= .6;
  const guideCopy = t().callouts[locating ? 1 : 0];
  ['#story-callout-tag', '#story-callout-title', '#story-callout-detail'].forEach((selector, i) => {
    if ($(selector).textContent !== guideCopy[i]) $(selector).textContent = guideCopy[i];
  });
  host.dataset.focus = step === 3 ? (locating ? 'posts' : 'clamp') : 'none';
  host.querySelectorAll('[data-part-label]').forEach((el, i) => {
    el.parentElement.dataset.active = String(step === 3 && (locating ? i === 0 : i !== 0));
  });
}

async function ensureScene() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const {createScene} = await import('./pcb2-scene.js');
      scene = await createScene($('#story-model'));
      scene.draw(step, phase);
      $('#story-fallback').hidden = true;
      host.dataset.ready = 'true';
      renderCopy();
      if (step === 3 && inView && !document.hidden && !reducedMotion.matches) play();
    } catch (error) {
      sceneFailed = true;
      host.dataset.ready = 'fallback';
      renderCopy();
      console.warn('Mason walkthrough preview unavailable:', error);
    }
  })();
  return loading;
}
function tick(now) {
  if (!playing) return;
  phase = Math.min(1, phase + Math.max(0, now - lastTime) / duration);
  lastTime = now;
  scene?.draw(step, phase);
  updateStatus();
  if (phase < 1) frame = requestAnimationFrame(tick);
  else { stop(); renderCopy(); }
}
function play() {
  if (!scene || step !== 3 || reducedMotion.matches || !inView || document.hidden || detailOpen) return;
  if (phase >= 1) phase = 0;
  stop(); playing = true; lastTime = performance.now();
  renderCopy(); frame = requestAnimationFrame(tick);
}
function select(index, focus = false) {
  const next = Math.max(0, Math.min(4, index));
  if (next === step) { if (focus) tabs[step].focus({preventScroll: true}); return; }
  const direction = next > step ? 1 : -1;
  stop(false); step = next;
  phase = reducedMotion.matches ? 1 : 0;
  renderCopy();
  animateCopy(direction);
  if (scene) {
    if (reducedMotion.matches || !inView) scene.draw(step, phase);
    else scene.transitionTo(step, phase);
  } else if (inView) ensureScene();
  if (focus) tabs[step].focus({preventScroll: true});
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => select(index));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % 5;
    else if (event.key === 'ArrowLeft') next = (index + 4) % 5;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = 4;
    else return;
    event.preventDefault(); select(next, true);
  });
});
$('#story-prev').addEventListener('click', () => select(step - 1));
$('#story-next').addEventListener('click', () => select(step + 1));
$('#story-replay').addEventListener('click', () => {
  phase = 0; scene?.draw(step, phase); updateStatus();
  if (!reducedMotion.matches) play();
  else renderCopy();
});
$('#story-pause').addEventListener('click', () => {
  if (playing) stop(); else play();
  renderCopy();
});
host.querySelectorAll('[data-phase]').forEach(button => button.addEventListener('click', () => {
  stop(); phase = Number(button.dataset.phase); scene?.draw(step, phase); renderCopy();
}));
let touchStart = null;
$('#story-visual').addEventListener('touchstart', event => {
  touchStart = event.touches.length === 1 ? [event.touches[0].clientX, event.touches[0].clientY] : null;
}, {passive: true});
$('#story-visual').addEventListener('touchend', event => {
  if (!touchStart || !event.changedTouches.length) return;
  const dx = event.changedTouches[0].clientX - touchStart[0];
  const dy = event.changedTouches[0].clientY - touchStart[1];
  touchStart = null;
  if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) select(step + (dx < 0 ? 1 : -1));
}, {passive: true});
$('#story-visual').addEventListener('touchcancel', () => { touchStart = null; }, {passive: true});

new MutationObserver(renderCopy).observe(document.documentElement, {attributes: true, attributeFilter: ['lang']});
new IntersectionObserver(entries => {
  inView = entries[0].isIntersecting;
  if (inView) ensureScene();
  else { stop(); renderCopy(); }
}, {threshold: .08}).observe(host);
host.addEventListener('story-detail-state', event => {
  detailOpen = event.detail.open;
  if (detailOpen) { stop(); renderCopy(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); renderCopy(); } });
$('#story-model').addEventListener('preview-settled', () => { if (step === 3) play(); });
$('#story-model').addEventListener('preview-lost', () => {
  stop(); scene = null; sceneFailed = true;
  host.dataset.ready = 'fallback';
  $('#story-model').style.visibility = 'hidden';
  $('#story-fallback').hidden = false;
  renderCopy();
});
reducedMotion.addEventListener('change', () => { stop(); phase = 1; scene?.draw(step, phase); renderCopy(); });
const videoDetails = document.querySelector('#story-film-details');
videoDetails.addEventListener('toggle', () => {
  if (!videoDetails.open) document.querySelector('#pcb2-film').pause();
  else { stop(); renderCopy(); }
});
renderCopy();
