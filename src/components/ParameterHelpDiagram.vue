<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import type en from '../i18n/en';

const props = defineProps<{ topic: keyof typeof en.guide; active: boolean; notchVariant?: 'jig' | 'stencil' }>();
const guide = ref<SVGSVGElement | null>(null);
const playing = ref(false);
const cutoutMaskId = `guide-sheet-${useId()}`;
const visibleRatio = .95;
const pocketProfile = 'M41 16h71l7 7v21H41z';
const notchProfile = computed(() => {
  // Both recesses share the slot midpoint. The tray and stencil flare in opposite directions.
  const [inner, outer] = props.notchVariant === 'jig' ? [11, 15] : [15, 11];
  return `${80 + inner} 43 ${80 + outer} 49 ${80 - outer} 49 ${80 - inner} 43`;
});

// The sidebar may still be scrolling after this illustration is mounted.
// Hold the first pose until the drawing itself is in view.
watch([guide, () => props.active], ([element, active], _, onCleanup) => {
  if (!element || !active || playing.value) return;
  if (typeof IntersectionObserver !== 'function') {
    playing.value = true;
    return;
  }
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry?.isIntersecting || entry.intersectionRatio < visibleRatio) return;
    playing.value = true;
    observer.disconnect();
  }, { threshold: visibleRatio });
  observer.observe(element);
  onCleanup(() => observer.disconnect());
}, { flush: 'post' });
</script>

<template>
  <svg ref="guide" class="guide" :class="{ 'is-playing': playing }" viewBox="0 0 160 60" aria-hidden="true" focusable="false">
    <!-- Keep the reference part still; move only the part the setting changes. -->
    <g v-if="topic === 'lip'">
      <rect class="lip-sheet" x="30" y="6" width="100" height="48" rx="3" />
      <!-- Both outlines move 7 units per side, preserving their independent gap. -->
      <rect class="lip-window motion" style="--start:scale(1.175,1.5)" x="40" y="16" width="80" height="28" rx="2" />
      <rect class="lip-platform motion" style="--start:scale(1.194444,1.7)" x="44" y="20" width="72" height="20" rx="2" />
      <rect class="pcb" x="60" y="23" width="40" height="14" rx="2" />
    </g>
    <g v-else-if="topic === 'post'">
      <circle class="guide-line clearance-edge motion" style="--start:scale(.68)" cx="80" cy="30" r="25" />
      <circle class="plate" cx="80" cy="30" r="17" />
      <path class="dimension dimension-reveal" d="M97 30h8m-8-3v6m8-6v6" />
    </g>
    <g v-else-if="topic === 'nut'">
      <path class="guide-line clearance-edge motion" style="--start:scale(.62)" d="M80 5 102 17.5v25L80 55 58 42.5v-25z" />
      <path class="metal" d="M80 14 94 22v16l-14 8-14-8V22z" />
      <circle class="well" cx="80" cy="30" r="5.5" />
      <path class="dimension dimension-reveal" d="M94 30h8m-8-3v6m8-6v6" />
    </g>
    <g v-else-if="topic === 'nutPocket'">
      <!-- Both sections keep the same through bore. Only the lower face receives the hex recess. -->
      <path class="nut-pocket-axis" d="M42 10v43m76-43v43" />
      <path class="metal" d="M16 17h22v26H16zM46 17h22v26H46z" />
      <path class="metal" d="M92 17h22v12h-9v14H92zM122 17h22v26h-13V29h-9z" />
      <g class="nut-pocket-seat motion" style="--start:translateY(16px)">
        <path class="plate" d="M113 30.5h-3l-3.5 2.5v6l3.5 2.5h3zm10 0h3l3.5 2.5v6l-3.5 2.5h-3z" />
        <path class="nut-pocket-seam" d="M107 36h5.5m11 0h5.5" />
      </g>
    </g>
    <g v-else-if="topic === 'pocket'">
      <!-- Rounded strokes offset the actual board profile evenly, including its cut corner. -->
      <path class="pocket-rim pocket-clearance motion" :d="pocketProfile" />
      <path class="pocket-band pocket-clearance motion" :d="pocketProfile" />
      <path class="pcb" :d="pocketProfile" />
      <circle class="well" cx="47.5" cy="22.5" r="2" />
      <path class="dimension dimension-reveal" d="M119 30h9m-9-3v6m9-6v6" />
    </g>
    <g v-else-if="topic === 'relief'">
      <path class="metal" d="M24 56V29h8v6h25v15h46V35h25v-6h8v27Z" />
      <g class="motion relief-lower">
        <!-- Flip about the board centre before lowering the board and its attached component. -->
        <g transform="translate(80 32)">
          <g class="motion relief-flip">
            <rect class="pcb" x="-48" y="-3" width="96" height="6" rx=".8" />
            <path class="stroke relief-leads" d="M-17 3v4h4m30-4v4h-4" />
            <rect class="ink" x="-13" y="3" width="26" height="11" rx="1.6" />
            <path class="relief-package-mark" d="M-8 7h3" />
            <path class="dimension relief-print-pads" d="M-31 -3h6m8 0h6m8 0h6m8 0h6m8 0h6" />
          </g>
        </g>
      </g>
    </g>
    <g v-else-if="topic === 'height'">
      <!-- The pocket keeps its depth while material grows below its floor. -->
      <path class="metal tray-floor motion" style="--start:scaleY(.24)" d="M24 41.5V52h112V41.5" />
      <path class="metal" d="M24 42V19h8v6h24v17h48V25h24v-6h8v23" />
      <rect class="pcb" x="32" y="19" width="96" height="6" rx=".8" />
      <rect class="ink" x="65" y="25" width="30" height="11" rx="1.5" />
      <path class="dimension" d="M17 19h125" />
      <path class="dimension dimension-reveal" d="M146 19v33m-3-33h6m-6 33h6" />
    </g>
    <g v-else-if="topic === 'eject'">
      <path class="metal" d="M24 23h6v11h42v11H24zm112 0h-6v11H88v11h48z"/>
      <path class="stroke motion eject-push" d="M80 40V22m-5 5 5-5 5 5" />
      <rect class="pcb motion eject-lift" x="33" y="16" width="94" height="6" rx="1.5" />
    </g>
    <g v-else-if="topic === 'padShrink'">
      <rect class="metal" x="28" y="8" width="104" height="44" rx="4" />
      <g v-for="center in [50, 80, 110]" :key="center">
        <rect class="guide-line" :x="center - 9" y="14" width="18" height="32" rx="2.5" stroke-opacity=".55" />
        <rect class="bore motion" style="--start:scale(1.25)" :x="center - 7.2" y="17.2"
          width="14.4" height="25.6" rx="2" vector-effect="non-scaling-stroke" />
      </g>
    </g>
    <g v-else-if="topic === 'testPointFilter'">
      <!-- Same pin row on both sides of the comparison; only the isolated aperture fills in. -->
      <g v-for="(left, index) in [12, 92]" :key="left" :transform="`translate(${left} 0)`">
        <rect class="metal" y="9" width="56" height="42" rx="4" />
        <circle v-for="pin in [11, 20, 29, 38]" :key="pin" class="bore" :cx="pin" cy="20" r="2.7" />
        <circle class="bore" :class="{ 'motion filtered-opening': index === 1 }" cx="44" cy="39" r="4" />
      </g>
      <path class="stroke" d="M73 30h14m-4-4 4 4-4 4" />
    </g>
    <g v-else-if="topic === 'pryNotch'" transform="translate(0 -4)">
      <path class="notch-tray-edge" d="M15 47h130v4q0 4-4 4H19q-4 0-4-4Z" />
      <path class="metal notch-rim" d="M29 18h102q2 0 3 2l11 27q1.2 3.5-3.5 3.5h-123Q13.8 50.5 15 47l11-27q1-2 3-2Z" />
      <!-- The recess is a continuous part of the inner boundary; the outer edge stays intact. -->
      <path class="well notch-pocket" :d="`M41 21H119L127 43 ${notchProfile} 33 43Z`" />
      <path class="notch-recess motion" :d="`M${notchProfile}`" />
      <g class="notch-board motion">
        <path class="notch-pcb-edge" d="M35 41.5h90v1.75H35Z" />
        <path class="pcb notch-pcb-face" d="M43 22.5h74l8 19H35Z" />
        <circle class="notch-pcb-detail" cx="48" cy="28" r="1.7" />
        <circle class="notch-pcb-detail" cx="112" cy="28" r="1.7" />
        <path class="notch-pcb-detail" d="M66 28h11l3 3h12m-15 4h6" />
      </g>
      <path class="dimension notch-lift-cue motion" d="M80 46V35m-3 3 3-3 3 3" />
    </g>
    <g v-else-if="topic === 'windowGap'">
      <rect class="metal" x="24" y="5" width="112" height="50" rx="4" />
      <rect class="well motion" style="--start:scale(.8,.6)" x="40" y="10" width="80" height="40" rx="2"
        vector-effect="non-scaling-stroke" />
      <rect class="plate" x="48" y="18" width="64" height="24" rx="2" />
      <path class="dimension dimension-reveal" d="M112 30h8m-8-3v6m8-6v6" />
    </g>
    <g v-else-if="topic === 'reliefAllowance'">
      <rect class="pcb" x="26" y="5" width="108" height="50" rx="4" />
      <rect class="relief-outline motion" style="--start:scale(.666667,.5)" x="50" y="10" width="60" height="40" rx="2"
        vector-effect="non-scaling-stroke" />
      <rect class="guide-line" x="60" y="20" width="40" height="20" rx="1" stroke-opacity=".55" />
      <g v-for="x in [60, 71, 82, 93]" :key="x" class="ink">
        <rect :x="x" y="20" width="7" height="5" rx="1" />
        <rect :x="x" y="35" width="7" height="5" rx="1" />
      </g>
      <path class="dimension dimension-reveal" d="M100 30h10m-10-3v6m10-6v6" />
    </g>
    <g v-else-if="topic === 'stagger' || topic === 'grid'">
      <defs>
        <mask :id="cutoutMaskId" maskUnits="userSpaceOnUse" width="160" height="60" x="0" y="0">
          <rect width="160" height="60" fill="white" />
          <g v-if="topic === 'stagger'" fill="black">
            <rect v-for="pin in 7" :key="pin" class="motion"
              :style="{ '--start': `translateY(${pin % 2 ? 6 : -6}px)` }"
              :x="13 + pin * 12" :y="pin % 2 ? 15 : 27" width="7" height="18" rx="1.5" />
            <rect x="125" y="21" width="7" height="18" rx="1.5" />
          </g>
          <template v-else>
            <g fill="black">
              <rect x="25" y="14" width="32" height="32" rx="2" />
              <rect x="68" y="23" width="46" height="14" rx="2" />
              <circle cx="130" cy="30" r="5.5" />
            </g>
            <!-- Reveal remaining sheet material across each eligible axis. -->
            <g fill="white">
              <rect class="motion" style="--start:scaleX(0)" x="39.25" y="13" width="3.5" height="34" />
              <rect class="motion" style="--start:scaleY(0)" x="24" y="28.25" width="34" height="3.5" />
              <rect class="motion" style="--start:scaleX(0)" x="89.25" y="22" width="3.5" height="16" />
            </g>
          </template>
        </mask>
      </defs>
      <g :mask="`url(#${cutoutMaskId})`">
        <rect class="aperture-sheet" x="14" y="7" width="132" height="46" rx="4" />
        <path v-if="topic === 'stagger'" class="guide-line aperture-alignment" d="M20 30h90" />
      </g>
    </g>
    <g v-else-if="topic === 'gerberImport'">
      <path class="metal" d="M26 9h23l8 8v34H26Z" />
      <path class="stroke" d="M49 9v8h8" />
      <text class="frame-label" x="41.5" y="34">ZIP</text>
      <path class="guide-line" d="M64 30h11M75 30V17h9m-9 13v13h9" />
      <g class="reveal">
        <g class="motion" style="--start:translateX(-7px)">
          <path class="pcb" d="M93 7h32l8 7v13H93Z" />
          <circle class="well" cx="100" cy="14" r="1.75" />
          <g class="ink">
            <rect v-for="x in [95, 105, 115, 125]" :key="x" :x="x" y="35" width="5" height="5.5" rx=".8" />
            <rect v-for="x in [95, 105, 115, 125]" :key="x" :x="x" y="46" width="5" height="5.5" rx=".8" />
          </g>
        </g>
      </g>
    </g>
    <g v-else-if="topic === 'stencilSize'">
      <!-- The PCB outline is a reference; both sizes span the steel sheet's outside edges. -->
      <rect class="metal" x="36" y="16" width="86" height="36" rx="2.5" />
      <rect class="guide-line stencil-size-board" x="53" y="24" width="52" height="20" rx="1.5" />
      <g class="ink">
        <rect v-for="x in [64, 71, 78, 85, 92]" :key="x" :x="x" y="29" width="3" height="4" rx=".6" />
        <rect v-for="x in [64, 71, 78, 85, 92]" :key="x" :x="x" y="35" width="3" height="4" rx=".6" />
      </g>
      <path class="dimension size-extents dimension-reveal" d="M36 13V5m86 8V5m3 11h10m-10 36h10" />
      <path class="dimension trace-dimension motion" pathLength="1" d="M36 8h86" />
      <path class="dimension trace-dimension motion" pathLength="1" d="M132 16v36" />
      <path class="dimension dimension-reveal" d="m40 5-4 3 4 3m78-6 4 3-4 3m11 9 3-4 3 4m-6 28 3 4 3-4" />
    </g>
    <g v-else-if="topic === 'reliefCut'">
      <defs>
        <mask :id="cutoutMaskId" maskUnits="userSpaceOnUse" width="160" height="60" x="0" y="0">
          <rect width="160" height="60" fill="white" />
          <rect x="29" y="23" width="25" height="13.5" fill="black" />
          <rect class="motion cut-depth" style="--start:scaleY(.5)" x="106" y="23" width="25" height="27" fill="black" />
        </mask>
      </defs>
      <!-- Identical boards and components; only the right-hand tray loses its floor. -->
      <g :mask="`url(#${cutoutMaskId})`">
        <rect class="aperture-sheet" x="13" y="24" width="57" height="24" rx="1.5" />
        <rect class="aperture-sheet" x="90" y="24" width="57" height="24" rx="1.5" />
      </g>
      <rect class="pcb" x="17" y="17" width="49" height="7" rx="1" />
      <rect class="pcb" x="94" y="17" width="49" height="7" rx="1" />
      <rect class="ink" x="34" y="24" width="15" height="8" rx="1" />
      <rect class="ink" x="111" y="24" width="15" height="8" rx="1" />
      <path class="dimension dimension-reveal" d="M118.5 37v17m-3.5-4 3.5 4 3.5-4" />
    </g>
    <g v-else-if="topic === 'reliefMerge'">
      <rect class="pcb" x="26" y="7" width="108" height="46" rx="3" />
      <rect class="plate relief-merge-area motion" x="40" y="16" width="80" height="28" />
      <g class="plate relief-merge-source motion">
        <rect x="40" y="16" width="23" height="13" rx="1.5" />
        <rect x="99" y="33" width="21" height="11" rx="1.5" />
      </g>
      <g class="guide-line relief-merge-reference reveal">
        <rect x="40" y="16" width="23" height="13" rx="1.5" />
        <rect x="99" y="33" width="21" height="11" rx="1.5" />
      </g>
    </g>
    <g v-else-if="topic === 'hardware'">
      <!-- Section through one perimeter fastener. The sheet stops before the bore. -->
      <path class="metal" d="M20 33h24v10h-8v9H20zM54 33h84v19H62v-9h-8z" />
      <path class="fastener" d="M38 44h7v7h-7zm22 0h-7v7h7z" />
      <path class="dimension" d="M66 32h80" />
      <text class="frame-label" x="121" y="42.5">B</text>
      <g class="motion" style="--start:translateY(-9px)">
        <path class="plate" d="M20 22h24v9H20zM54 22h84v9H54z" />
        <text class="frame-label" x="121" y="26.5">A</text>
        <path class="fastener" d="M39 15h20v7H39zm6 7h8v29h-8z" />
        <path class="fastener-detail" d="M47 15v2h4v-2m-6 22 8-2m-8 7 8-2m-8 7 8-2" />
      </g>
    </g>
    <g v-else-if="topic === 'screw'">
      <rect class="metal" x="29" y="10" width="44" height="40" rx="4" />
      <circle class="bore motion" style="--start:scale(.65)" cx="51" cy="30" r="11.5" />
      <path class="guide-line" d="M78 30h12" />
      <g class="motion" style="--start:scale(.7)">
        <path class="fastener" d="M98 18.5 105.5 6h15L128 18.5 120.5 31h-15z" />
        <circle class="well" cx="113" cy="18.5" r="5.5" />
      </g>
      <g class="motion" style="--start:scale(.7,.62)">
        <rect class="fastener" x="98" y="37" width="30" height="12" rx="2" />
        <path class="fastener-detail" d="M105.5 37v12m15-12v12" />
      </g>
      <path class="dimension dimension-reveal" d="M135 37v12m-3-12h6m-6 12h6" />
    </g>
    <g v-else-if="topic === 'structure'">
      <path class="metal" d="M23 40h45v6H23zm0-7h45v4H23zM94 34h44v12H94z"/><path class="stroke" d="M72 30h14m-4-4 4 4-4 4"/>
      <g class="motion" style="--start:translateY(-9px)"><path class="plate" d="M103 14h18v6h-18zm6 6h6v20h-6z"/></g>
    </g>
    <g v-else-if="topic === 'presets'">
      <path class="guide-line" d="M24 16h41m-41 14h41m-41 14h41"/><g class="plate"><circle cx="37" cy="16" r="4"/><circle cx="54" cy="30" r="4"/><circle cx="42" cy="44" r="4"/></g>
      <path class="stroke" d="M74 30h15m-4-4 4 4-4 4"/><rect class="metal" x="99" y="11" width="35" height="38" rx="4"/><path class="stroke reveal" d="m107 30 6 6 11-12"/>
    </g>
  </svg>
</template>

<style scoped>
.guide { display: block; width: 100%; height: 64px; fill: none; stroke-linejoin: round; stroke-linecap: round; stroke-width: 1.5; }
.lip-sheet { fill: var(--grip-fill); stroke: var(--grip-ink); }
.lip-window { fill: var(--surface-raised); stroke: var(--grip-ink); stroke-opacity: .6; }
.lip-platform { stroke: var(--text-brand); stroke-dasharray: 3 2; }
.lip-window, .lip-platform { vector-effect: non-scaling-stroke; }
.pcb { fill: var(--pcb-fill); stroke: var(--pcb-ink); }
.plate { fill: var(--control-selection-surface); stroke: var(--interaction-ink); }
.frame-label { fill: var(--text-default); font-size: 7.5px; font-weight: var(--font-weight-strong); text-anchor: middle; dominant-baseline: central; }
.fastener { fill: color-mix(in srgb, var(--text-secondary) 20%, var(--surface-raised)); stroke: var(--text-secondary); }
.fastener-detail { fill: none; stroke: var(--text-secondary); stroke-width: 1; }
.bore { fill: var(--surface-raised); stroke: var(--interaction-ink); }
.aperture-sheet { fill: color-mix(in srgb, var(--text-secondary) 30%, var(--surface-raised)); stroke: var(--text-secondary); stroke-opacity: .62; }
.aperture-alignment { stroke: var(--text-secondary); stroke-opacity: .52; stroke-width: 1; }
.metal { fill: var(--surface-well); stroke: var(--text-secondary); }
.well { fill: var(--surface-raised); stroke: var(--text-tertiary); }
.nut-pocket-axis { stroke: var(--text-tertiary); stroke-opacity: .6; stroke-width: 1; stroke-dasharray: 2 2.5; }
.nut-pocket-seam { stroke: var(--interaction-ink); stroke-opacity: .62; stroke-width: 1; }
.ink { fill: var(--interaction-ink); }
.stroke, .guide-line { fill: none; stroke: var(--interaction-ink); }
.guide-line { stroke-dasharray: 3 3; }
.clearance-edge { fill: color-mix(in srgb, var(--accent-ink) 12%, var(--surface-raised)); }
.dimension { stroke: color-mix(in srgb, var(--accent-ink) 72%, var(--text-default)); stroke-width: 1.6; }
.motion { transform-box: fill-box; transform-origin: center; animation: illustrate 1.55s var(--ease-out) both; }
.relief-lower { animation-name: lower-for-print; }
.relief-flip { transform-box: view-box; transform-origin: 0 0; animation-name: flip-for-print; animation-timing-function: ease-in-out; }
.relief-leads, .relief-print-pads { stroke-width: 1.25; }
.relief-package-mark { stroke: var(--surface-raised); stroke-width: 1; }
@keyframes flip-for-print {
  0%, 16% { transform: scaleY(-1); }
  53%, 100% { transform: none; }
}
@keyframes lower-for-print {
  0%, 53% { transform: translateY(-14px); }
  87%, 100% { transform: none; }
}
.tray-floor { transform-origin: top; vector-effect: non-scaling-stroke; }
.pocket-clearance { stroke-width: var(--wide); animation-name: expand-pocket; }
.pocket-rim { --narrow: 4.5px; --wide: 19.5px; stroke: var(--interaction-ink); }
.pocket-band { --narrow: 1.5px; --wide: 16.5px; stroke: color-mix(in srgb, var(--interaction-ink) 12%, var(--surface-raised)); }
@keyframes expand-pocket { 0%, 18% { stroke-width: var(--narrow); } 72%, 100% { stroke-width: var(--wide); } }
.eject-push { animation-name: push-eject; }
.eject-lift { animation-name: lift-pcb; }
@keyframes push-eject {
  0%, 12% { transform: translateY(19px); }
  34% { transform: translateY(12px); }
  72%, 100% { transform: none; }
}
@keyframes lift-pcb {
  0%, 34% { transform: translateY(12px); }
  72%, 100% { transform: none; }
}
.filtered-opening { opacity: 0; animation-name: filter-opening; }
@keyframes filter-opening { 0%, 24% { opacity: 1; } 68%, 100% { opacity: 0; } }
.notch-tray-edge { fill: var(--surface-line); stroke: var(--text-tertiary); stroke-width: 1.1; }
.notch-rim, .notch-pocket, .notch-pcb-edge, .notch-pcb-face { stroke-width: 1.2; }
.notch-recess { fill: var(--control-selection-surface); stroke: var(--text-brand); stroke-width: 1.35; animation-name: focus-notch; }
.notch-board { transform-origin: center top; transform: scaleY(.6); animation-name: lift-at-notch; }
.notch-pcb-edge { fill: color-mix(in srgb, var(--pcb-ink) 25%, var(--pcb-fill)); stroke: var(--pcb-ink); }
.notch-pcb-detail { stroke: var(--pcb-ink); stroke-opacity: .68; stroke-width: .9; }
.notch-lift-cue { transform-origin: center bottom; animation-name: track-notch-lift; }
@keyframes focus-notch { 0%, 10% { opacity: .25; } 34%, 100% { opacity: 1; } }
@keyframes lift-at-notch { 0%, 38% { transform: none; } 86%, 100% { transform: scaleY(.6); } }
@keyframes track-notch-lift {
  0%, 18% { opacity: 0; transform: scaleY(.25); }
  38% { opacity: 1; transform: scaleY(.25); }
  86%, 100% { opacity: 1; transform: none; }
}
.relief-outline { fill: color-mix(in srgb, var(--surface-raised) 75%, transparent); stroke: var(--interaction-ink); }
.reveal { animation: reveal 1.55s var(--ease-out) both; }
@keyframes illustrate { 0%, 18% { transform: var(--start); } 72%, 100% { transform: none; } }
@keyframes reveal { 0%, 18% { opacity: .12; } 72%, 100% { opacity: 1; } }
.dimension-reveal { animation: mark-clearance 1.55s var(--ease-out) both; }
@keyframes mark-clearance { 0%, 60% { opacity: 0; } 80%, 100% { opacity: 1; } }
.stencil-size-board { stroke: var(--pcb-ink); stroke-opacity: .8; }
.size-extents { stroke-width: 1; stroke-opacity: .62; }
.trace-dimension { stroke-dasharray: 1; animation-name: trace-dimension; }
@keyframes trace-dimension { 0%, 18% { stroke-dashoffset: 1; opacity: 0; } 28% { opacity: 1; } 74%, 100% { stroke-dashoffset: 0; opacity: 1; } }
.cut-depth { transform-origin: top; }
.relief-merge-area { animation-name: reveal-merge; }
.relief-merge-source { opacity: 0; animation-name: merge-source; }
.relief-merge-reference { stroke-width: 1; stroke-opacity: .64; }
@keyframes reveal-merge {
  0%, 18% { opacity: 0; transform: scaleX(.65); }
  74%, 100% { opacity: 1; transform: none; }
}
@keyframes merge-source { 0%, 22% { opacity: 1; } 74%, 100% { opacity: 0; } }
.guide:not(.is-playing) :is(.motion, .reveal, .dimension-reveal) { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) { .motion, .reveal, .dimension-reveal { animation: none; } }
</style>
