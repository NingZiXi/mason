// Decorative SVG only: pause its shared CSS timeline offscreen or in a hidden tab.
const stage = document.querySelector('.wf-stage');
let visible = false;
function update() { stage.classList.toggle('wf-running', visible && !document.hidden); }
new IntersectionObserver(entries => { visible = entries[0].isIntersecting; update(); }, {threshold: .15}).observe(stage);
document.addEventListener('visibilitychange', update);
