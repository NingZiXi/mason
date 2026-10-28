import {createScene} from './pcb2-scene.js';
import {detailCopy} from './site-extras.js';
const dialog = document.querySelector('#story-detail');
const mount = document.querySelector('#detail-model');
const status = document.querySelector('#detail-status');
let scene, loading, preset = 'overview', request = 0, trigger, previousOverflow, failed = false;
const notify = open => document.querySelector('#pcb2-story').dispatchEvent(new CustomEvent('story-detail-state', {detail:{open}}));
function copy() {
  const c = detailCopy();
  document.querySelector('#detail-note').textContent = c[preset + 'Note'];
  dialog.querySelectorAll('[data-preset]').forEach(el => { el.setAttribute('aria-pressed', String(el.dataset.preset === preset)); });
  dialog.querySelector('[data-zoom="in"]').setAttribute('aria-label', c.zoomIn);
  dialog.querySelector('[data-zoom="out"]').setAttribute('aria-label', c.zoomOut);
  mount.querySelector('canvas')?.setAttribute('aria-label', c.detailTitle + '. ' + c.hint);
}
async function showPreset(name) {
  preset = name; copy();
  const token = ++request;
  try {
    dialog.dataset.loading = 'true';
    status.hidden = false; status.textContent = detailCopy().loading;
    if (!scene) {
      loading ||= createScene(mount).then(value => scene = value).catch(error => { loading = null; throw error; });
      await loading;
    }
    if (!dialog.open || token !== request) return;
    await scene.inspect(name);
    if (!dialog.open) scene.suspendInspection();
    if (token !== request) return;
    status.hidden = true; dialog.dataset.loading = 'false'; copy();
  } catch (error) { failed = true; dialog.dataset.loading = 'true'; status.hidden = false; status.textContent = detailCopy().failed; console.warn('Detail model unavailable:', error); }
}
export async function openDetails(source) {
  if (dialog.open) return;
  if (failed) { scene?.dispose(); scene = null; loading = null; failed = false; mount.replaceChildren(); delete mount.dataset.inspection; }
  trigger = source; previousOverflow = document.body.style.overflow;
  dialog.showModal(); document.body.style.overflow = 'hidden'; notify(true);
  await showPreset(preset);
}
dialog.querySelector('[data-detail-close]').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  request++; scene?.suspendInspection(); document.body.style.overflow = previousOverflow;
  notify(false); trigger?.focus({preventScroll:true});
});
dialog.querySelectorAll('[data-preset]').forEach(el => el.addEventListener('click', () => showPreset(el.dataset.preset)));
dialog.querySelector('[data-detail-reset]').addEventListener('click', () => showPreset(preset));
dialog.querySelector('[data-zoom="in"]').addEventListener('click', () => scene?.zoomInspection(1.2));
dialog.querySelector('[data-zoom="out"]').addEventListener('click', () => scene?.zoomInspection(1 / 1.2));
mount.addEventListener('preview-lost', () => { failed = true; dialog.dataset.loading = 'true'; status.hidden = false; status.textContent = detailCopy().failed; });
new MutationObserver(() => { copy(); if (!status.hidden) status.textContent = detailCopy()[failed ? 'failed' : 'loading']; }).observe(document.documentElement, {attributes:true, attributeFilter:['lang']});
