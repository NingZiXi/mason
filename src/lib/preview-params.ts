import { computed, watch, type ComputedRef, type WatchStopHandle } from 'vue';
import type { AppConfig } from '../stores/config';
import { activeReliefRegions } from './component-relief';
import { apertureSnapshot } from './pad-overrides';
import { buildScadParams, enginePads, modelParamsHash, scadPartHash, type ImportedGeometryKeys } from './model-params';

/** Rendering, preloading and metrics repeatedly check the same geometry while
 * asynchronous work completes. Serialize each reactive snapshot once instead
 * of rescanning thousands of pad vertices for every freshness check. */
export function createPreviewParameterCache(config: () => AppConfig) {
  const top = computed(() => enginePads(config().stencilPadsTop));
  const bottom = computed(() => enginePads(config().stencilPadsBottom));
  const outlineKey = computed(() => JSON.stringify(config().pcbOutlinePoints));
  const holesKey = computed(() => JSON.stringify(config().pcbOutlineHoles));
  const topKey = computed(() => JSON.stringify(top.value));
  const bottomKey = computed(() => JSON.stringify(bottom.value));
  // Getters keep part keys subscribed only to geometry used by that part.
  const keys: ImportedGeometryKeys = {
    get outline() { return outlineKey.value; }, get holes() { return holesKey.value; },
    get top() { return topKey.value; }, get bottom() { return bottomKey.value; },
  };
  const params = computed(() => buildScadParams(config(), top.value, bottom.value));
  const hash = computed(() => modelParamsHash(config(), keys));
  const parts = new Map<string, ComputedRef<string>>();
  function partHash(part: string, snapshot = params.value) {
    // Exports and in-flight requests may carry an older, captured snapshot.
    // Their key must never be taken from the current live configuration.
    if (snapshot !== params.value) return scadPartHash(snapshot, part);
    let key = parts.get(part);
    if (!key) {
      key = computed(() => scadPartHash(params.value, part, keys));
      parts.set(part, key);
    }
    return key.value;
  }
  return { params: () => params.value, hash: () => hash.value, partHash };
}

/** Track geometry inputs without traversing the imported pad/outline arrays on
 * each slider movement. Relief plans are small and need a value key: editing a
 * different face, or a default already resolved on existing regions, is visual
 * state rather than a change to the current model. */
function reliefGeometryKey(c: AppConfig): string | null {
  return c.appMode === 'jig' && c.componentReliefEnabled
    ? JSON.stringify([c.jigPrintSide, activeReliefRegions(c).map(region => ({
      ...region, through: region.through === true,
      depth: region.through ? undefined : region.depth ?? c.componentReliefDepth,
    }))]) : null;
}

export function previewGeometrySource(c: AppConfig,
  apertureKey = JSON.stringify(apertureSnapshot(c.stencilPadsTop, c.stencilPadsBottom)),
  reliefKey = reliefGeometryKey(c),
): readonly unknown[] {
  return [
    c.appMode,
    c.pcbSizeX, c.pcbSizeY, c.pcbThickness, c.pcbPocketClearance,
    c.pcbOutlinePoints, c.pcbOutlineHoles, c.stencilSizeX, c.stencilSizeY,
    c.screwSpacing, c.screwSpec, c.useHexNut, c.nutAcrossFlats, c.nutHeight, c.nutPocketClearance,
    c.baseHeight, c.topCoverHeight, c.jigSize, c.insertHeight, c.platterHeight,
    c.platterCornerRadius, c.ejectSlotWidth,
    c.appMode === 'jig' && c.ejectSlotWidth > 0 ? c.ejectHoleDiameter : 0,
    c.cornerScrewD, c.postClearance, c.periScrewD, c.outerCornerRadius, c.stencilLip, c.windowGap,
    c.pryNotchSides.join(','), c.pryNotchScale, reliefKey,
    c.stencilThickness, c.padShrink, c.stencilFrameWidth, c.stencilCornerRadius,
    c.stencilFrameShape, c.pocketClearance,
    c.stencilTaper, c.stencilStagger, c.stencilStaggerGap, c.stencilStaggerOffset,
    c.stencilFilterTestPoints, c.stencilTestPointMaxDia, c.stencilTestPointIsolation,
    c.stencilGrid, c.stencilGridSize, c.stencilGridBar,
    c.stencilPadsTop, c.stencilPadsBottom, apertureKey,
  ];
}

/** A no-op must not cancel generation, replace meshes or clear measurements. */
export function watchPreviewGeometryChanges(config: () => AppConfig, changed: () => void): WatchStopHandle {
  // Manual opening decisions change in place, including during undo/redo.
  // Cache their sparse signature separately: parameter sliders must not rescan
  // every pad, and no geometry vertices are needed to observe these decisions.
  const apertureKey = computed(() => {
    const c = config();
    return JSON.stringify(apertureSnapshot(c.stencilPadsTop, c.stencilPadsBottom));
  });
  const reliefKey = computed(() => reliefGeometryKey(config()));
  const source = computed(() => previewGeometrySource(config(), apertureKey.value, reliefKey.value));
  return watch(source, (current, previous) => {
    if (current.length === previous.length && current.every((value, index) => Object.is(value, previous[index]))) return;
    changed();
  });
}
