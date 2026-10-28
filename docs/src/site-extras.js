const zh = () => document.documentElement.lang.startsWith('zh');
const strings = {
  zh: {details:'查看模型细节 ↗', question:'你打算怎样制作？', metal:'已有金属钢网', printed:'直接打印钢网', recommended:'适合你的选择', jigReason:'选择钢网夹具：用顶盖和底座夹紧金属钢网，再沿托盘定位柱落位。', stencilReason:'选择 PCB 钢网：生成带 PCB 卡槽的一体式打印钢网，独立使用。', detailTitle:'从细节，看懂结构', posts:'四角定位柱', clamp:'三层夹紧', apertures:'焊盘开孔', overviewNote:'在页面中央自由转动模型，查看夹紧组件与 PCB 托盘的装配关系。', postsNote:'定位柱与 PCB 托盘一体成型，引导夹好的组件整体落下；四角不装螺丝。', clampNote:'上方 A 面顶盖、中间金属钢网、下方 B 面底座，由周圈螺丝夹紧。', aperturesNote:'独立打印钢网的顶层开孔，来自这块板子的 347 个顶层锡膏焊盘。', hint:'拖动旋转 · 滚轮或双指缩放 · 方向键旋转，+ / − 缩放', close:'关闭', reset:'重置视角', zoomIn:'放大', zoomOut:'缩小', loading:'正在准备细节模型…', failed:'细节预览暂不可用，请退出查看后重试，或观看下方完整演示。'},
  en: {details:'Explore model details ↗', question:'How will you make it?', metal:'I have a metal stencil', printed:'I want to print a stencil', recommended:'Recommended for you', jigReason:'Choose the jig: clamp the metal stencil between the cover and base, then lower onto the tray’s alignment posts.', stencilReason:'Choose PCB stencil: print a standalone stencil with its own PCB pocket.', detailTitle:'Explore the construction', posts:'Alignment posts', clamp:'Three-layer clamp', apertures:'Paste apertures', overviewNote:'Rotate the model to explore how the clamped assembly fits onto the PCB tray.', postsNote:'Posts are built into the PCB tray and guide the clamped unit into place. No screws at the four corners.', clampNote:'A-side cover above, metal stencil in the middle, B-side base below. Perimeter screws clamp all three together.', aperturesNote:'Standalone printed stencil with openings from this board’s 347 top-paste pads.', hint:'Drag to rotate · Scroll or pinch to zoom · Arrow keys rotate, + / − zoom', close:'Close', reset:'Reset view', zoomIn:'Zoom in', zoomOut:'Zoom out', loading:'Preparing model details…', failed:'Detail preview is unavailable. Close and retry, or watch the complete film below.'}
};
export const detailCopy = () => strings[zh() ? 'zh' : 'en'];
let mode = null;
const guide = document.querySelector('#mode-guide');
function render() {
  const c = detailCopy();
  document.querySelectorAll('[data-extra]').forEach(el => { el.textContent = c[el.dataset.extra]; });
  guide.querySelectorAll('[data-mode-choice]').forEach(el => el.setAttribute('aria-pressed', String(mode === el.dataset.modeChoice)));
  document.querySelectorAll('.mode-jig,.mode-stencil').forEach(el => {
    const selected = mode === (el.classList.contains('mode-jig') ? 'jig' : 'stencil');
    el.classList.toggle('mode-recommended', selected);
    el.querySelector('.mode-recommendation').hidden = !selected;
  });
  document.querySelector('#mode-result').hidden = !mode;
  document.querySelector('#mode-reason').textContent = mode ? c[mode + 'Reason'] : '';
}
guide.querySelectorAll('[data-mode-choice]').forEach(el => el.addEventListener('click', () => { mode = el.dataset.modeChoice; render(); }));
document.querySelector('#story-detail-open').addEventListener('click', async event => {
  const trigger = event.currentTarget;
  trigger.disabled = true;
  try { const {openDetails} = await import('./detail-viewer.js'); trigger.disabled = false; await openDetails(trigger); }
  catch (error) { console.warn('Detail viewer unavailable:', error); document.querySelector('#detail-error').hidden = false; }
  finally { trigger.disabled = false; }
});
new MutationObserver(render).observe(document.documentElement, {attributes:true, attributeFilter:['lang']});
render();
