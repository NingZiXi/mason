import { onScopeDispose, watch, type Ref } from 'vue';
import type { AppMode } from '../stores/config';

// Distances are in CSS pixels. The switch and toolbar lead; the heavier form
// arrives a beat later. Common actions, scroll containers and window chrome stay put.
const cues = {
  tools:   { travel: 14, opacity: .80, duration: 330, delay: 0 },
  source:  { travel:  7, opacity: .91, duration: 320, delay: 0 },
  form:    { travel: 19, opacity: .77, duration: 390, delay: 14 },
  screws:  { travel: 16, opacity: .82, duration: 375, delay: 30 },
  scene:   { travel:  8, opacity: .91, duration: 365, delay: 0 },
  empty:   { travel: 16, opacity: .84, duration: 370, delay: 8 },
} as const;
type Cue = keyof typeof cues;
type Pose = { x: number; opacity: number };

export function useWorkspaceModeMotion(mode: Readonly<Ref<AppMode>>, main: Ref<HTMLElement | null>) {
  const playing = new Map<Cue, { node: HTMLElement; animation: Animation }>();
  const interrupted = new Map<Cue, Pose>();

  watch(mode, () => {
    interrupted.clear();
    // Read the poses together, before Vue replaces a form (and before cancelling
    // any animations). The equivalent form in the other mode inherits its pose.
    for (const [key, { node }] of playing) {
      const style = getComputedStyle(node);
      interrupted.set(key, { x: parseFloat(style.translate) || 0, opacity: Number(style.opacity) });
    }
    for (const { animation } of playing.values()) animation.cancel();
    playing.clear();
    if (main.value) main.value.dataset.modeSwitched = '';
  }, { flush: 'pre' });

  watch(mode, next => {
    if (!main.value) return;
    const direction = next === 'stencil' ? 1 : -1;
    for (const node of main.value.querySelectorAll<HTMLElement>('[data-mode-motion]')) {
      const key = node.dataset.modeMotion as Cue, cue = cues[key];
      if (!cue || node.closest('[inert]')) continue;
      const carry = interrupted.get(key);
      const distance = direction * cue.travel;
      // On a reversal, carry the actual displacement and brightness forward.
      // No hiding or restarting the panel, even if every click changes direction.
      const pose = carry ?? { x: distance, opacity: cue.opacity };
      const animation = node.animate([
        { translate: `${pose.x}px 0`, opacity: pose.opacity, easing: 'cubic-bezier(.22,.64,.26,1)' },
        { translate: `${-distance * .14}px 0`, opacity: 1, offset: .57, easing: 'cubic-bezier(.28,0,.32,1)' },
        { translate: `${distance * .035}px 0`, opacity: 1, offset: .82, easing: 'ease-out' },
        { translate: '0px 0', opacity: 1 },
      ], { duration: carry ? cue.duration * .78 : cue.duration, delay: carry ? 0 : cue.delay, fill: 'backwards' });
      playing.set(key, { node, animation });
      animation.onfinish = () => { if (playing.get(key)?.animation === animation) playing.delete(key); };
    }
    interrupted.clear();
  }, { flush: 'post' });

  // Direct manipulation takes precedence: settle the surface before the child
  // starts measuring coordinates for a drag, picking a 3D feature, or focusing a field.
  function settleAt(event: Event) {
    if (!(event.target instanceof Element)) return;
    const key = event.target.closest<HTMLElement>('[data-mode-motion]')?.dataset.modeMotion as Cue | undefined;
    if (!key) return;
    playing.get(key)?.animation.cancel(); playing.delete(key);
  }
  onScopeDispose(() => {
    for (const { animation } of playing.values()) animation.cancel();
    playing.clear(); interrupted.clear();
  });
  return { settleAt };
}
