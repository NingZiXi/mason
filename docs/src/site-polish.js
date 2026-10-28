// Small native interactions shared by the static site. No rendering loop at rest.
const motion = matchMedia('(prefers-reduced-motion: reduce)');

document.querySelectorAll('.sec-head, .story-heading').forEach(heading => {
  heading.classList.remove('reveal', 'in');
  heading.querySelectorAll('.sec-tag, h2, p').forEach(el => el.classList.add('reveal'));
});
document.querySelectorAll('.story-walk, .sample-strip, .story-film-details, .story-transcript').forEach(el => el.classList.add('reveal'));
const reveals = [...document.querySelectorAll('.reveal')];
let observer;
function show(el, delay = 0) {
  el.style.setProperty('--reveal-delay', delay + 'ms');
  el.classList.add('in');
  observer?.unobserve(el);
}
if (!motion.matches && 'IntersectionObserver' in window) {
  document.documentElement.classList.add('reveal-ready');
  observer = new IntersectionObserver(entries => {
    entries.filter(entry => entry.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top || a.boundingClientRect.left - b.boundingClientRect.left)
      .forEach((entry, i) => show(entry.target, Math.min(i, 3) * 70));
  }, {threshold: .06, rootMargin: '0px 0px -20px 0px'});
  reveals.forEach(el => observer.observe(el));
} else reveals.forEach(el => show(el));

// Keyboard navigation and preference changes always expose the content immediately.
document.addEventListener('focusin', event => {
  let el = event.target;
  while (el instanceof HTMLElement) {
    if (el.classList.contains('reveal') && !el.classList.contains('in')) {
      show(el);
      el.getAnimations().filter(animation => ['opacity', 'translate'].includes(animation.transitionProperty)).forEach(animation => animation.finish());
    }
    el = el.parentElement;
  }
});
motion.addEventListener('change', () => {
  if (motion.matches) {
    observer?.disconnect();
    document.documentElement.classList.remove('reveal-ready');
    reveals.forEach(el => show(el));
  }
});

// Decorative CSS timelines retain their phase while outside the viewport.
const ambientSurfaces = [...document.querySelectorAll('.hero, .feat, .showcase')];
const ambientVisible = new Set();
function updateAmbient() {
  ambientSurfaces.forEach(el => el.classList.toggle('motion-paused', document.hidden || !ambientVisible.has(el)));
}
const ambientObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) ambientVisible.add(entry.target);
    else ambientVisible.delete(entry.target);
  });
  updateAmbient();
});
ambientSurfaces.forEach(el => { el.classList.add('motion-paused'); ambientObserver.observe(el); });
document.addEventListener('visibilitychange', updateAmbient);

// Pointer responses are owned by pointer-effects.js.
