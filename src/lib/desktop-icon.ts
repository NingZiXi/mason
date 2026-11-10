import { invoke, isTauri } from '@tauri-apps/api/core';
import { watch } from 'vue';
import type { Skin } from '../stores/ui';

interface SkinIconState {
  readonly skin: Skin;
  readonly skinCelebrationActive: boolean;
}

interface DesktopIconOptions {
  native?: boolean;
  writeIcon?: (skin: Skin) => Promise<void>;
  onError?: (error: unknown) => void;
}

/** Keep native icons at the settled skin, without changing them during the reveal. */
export function watchDesktopSkinIcon(state: SkinIconState, options: DesktopIconOptions = {}): () => void {
  if (!(options.native ?? isTauri())) return () => {};

  const writeIcon = options.writeIcon ?? ((skin: Skin) => invoke('set_skin_icon', { skin }).then(() => {}));
  const onError = options.onError ?? ((error: unknown) => console.warn('[desktop-icon] Could not update the app icon:', error));
  let requested: Skin | undefined;
  let applied: Skin | undefined;
  let running = false;
  let disposed = false;

  async function drain() {
    if (running) return;
    running = true;
    try {
      // Shell updates may finish out of order if each click invokes directly.
      // Only one native write runs at a time; pending clicks keep the last skin.
      while (!disposed && requested !== undefined && requested !== applied) {
        const destination = requested;
        try {
          await writeIcon(destination);
          applied = destination;
        } catch (error) {
          // A failed native command may already have updated one shell surface.
          // Treat it as unknown so a queued return to the old skin still writes.
          applied = undefined;
          onError(error);
          // Do not retry a failing shell update continuously. A later selection
          // can retry, and an already queued different skin still gets applied.
          if (requested === destination) requested = undefined;
        }
      }
    } finally {
      running = false;
    }
  }

  const stop = watch(() => [state.skin, state.skinCelebrationActive] as const, ([skin, celebrating]) => {
    // The live skin changes at view-transition capture, before the crew paints.
    // The native shell has no matching reveal, so wait until it is committed.
    if (celebrating) {
      requested = undefined;
      return;
    }
    requested = skin;
    void drain();
  }, { immediate: true });

  return () => {
    disposed = true;
    requested = undefined;
    stop();
  };
}
