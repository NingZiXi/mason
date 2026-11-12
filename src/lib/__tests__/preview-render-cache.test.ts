import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Execute the real render, mesh replacement and teardown paths with an in-memory
// Three.js scene. No WebGL context or desktop interaction is needed.
const source = readFileSync(new URL('../../components/ModelPreview.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
const syntax = createSourceFile('ModelPreview.ts', script, ScriptTarget.Latest, true, ScriptKind.TS);
const names = new Set(['renderCurrent', 'getOrParseGeometry', 'applyStlToMesh', 'framePreviewObject', 'disposeMesh']);
const functions = syntax.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text ?? ''));
if (functions.length !== names.size) throw new Error('A preview render function is missing from the test harness');
const javascript = transpileModule(functions.map(node => node.getText(syntax)).join('\n'),
  { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;

type Part = 'insert' | 'base';
function setup() {
  const camera = new THREE.PerspectiveCamera(45, 4 / 3, .1, 5000);
  camera.position.set(120, 80, 150);
  // Unconnected controls run the real camera/target math without DOM listeners.
  const controls = new OrbitControls(camera);
  const clearMeasure = vi.fn();
  const resetTopology = vi.fn();
  const schedulePreload = vi.fn();
  const ensurePart = vi.fn(async () => {});
  const cancelPreviewTasks = vi.fn();
  const create = new Function('THREE', 'cam', 'orbit', 'clearMeasureSpy', 'resetTopology', 'schedulePreload', 'ensurePart', 'cancelPreviewTasks', `
    const scene = { value: new THREE.Scene() }, currentMesh = { value: null }, currentAssembly = { value: null };
    const camera = { value: cam }, controls = { value: orbit };
    const cancelCameraMotion = () => {}, settleCameraControls = () => {}, selectedView = { value: 'iso' };
    let currentMeshPart = null, framedBoardOutline = null, disposed = false, renderSeq = 0, cacheGeneration = 0, renderTimer = null;
    const inspectionOpen = { value: false }, hasData = { value: true };
    const store = { pythonDetected: true, config: { pcbOutlinePoints: [[-15,-10], [15,-10], [15,10], [-15,10]] } };
    const activePart = { value: 'insert' }, loading = { value: false }, errorMsg = { value: null };
    const retiredGeometry = new Set(), stlCache = { value: {} };
    let selected = ['edge A', 'edge B'], wholeHash = 'whole-before';
    const clearMeasure = () => { clearMeasureSpy(); selected = []; };
    const paramsHash = () => wholeHash, partHash = part => part + '-hash';
    const buildScadParams = () => ({}), canCacheResult = () => true;
    const isGenerationCancelled = () => false, t = key => key;
    const invalidate = () => {}, disposeJigAssembly = () => {}, applyAssembly = () => {};
    const ui = { skin: 'classic' }, modelPalette = { value: { parts: { insert: 0x777777, base: 0x888888 },
      plastic: { metalness: 0, roughness: .7 } } };
    ${javascript}
    const cache = (part, geometry) => { stlCache.value[part] = { paramsHash: partHash(part),
      bytes: new ArrayBuffer(0), geometry }; };
    const geometry = new THREE.BoxGeometry(30, 3, 20);
    cache('insert', geometry); cache('base', new THREE.BoxGeometry(40, 4, 30));
    applyStlToMesh(geometry);
    clearMeasureSpy.mockClear(); resetTopology.mockClear();
    selected = ['edge A', 'edge B'];
    return { render: renderCurrent, cache, select: part => activePart.value = part,
      editOtherPart: () => wholeHash = 'whole-after-nut-change',
      importBoard: () => { store.config.pcbOutlinePoints = store.config.pcbOutlinePoints.map(point => [...point]); },
      pending: () => { loading.value = true; errorMsg.value = 'old request failed'; },
      inspect: () => ({ mesh: currentMesh.value, part: currentMeshPart, loading: loading.value,
        error: errorMsg.value, selected, geometry: currentMesh.value?.geometry }),
      dispose: disposeMesh };
  `);
  const harness = create(THREE, camera, controls, clearMeasure, resetTopology, schedulePreload, ensurePart, cancelPreviewTasks) as {
    render: (force?: boolean) => Promise<boolean>;
    cache: (part: Part, geometry: THREE.BufferGeometry) => void;
    select: (part: Part) => void;
    editOtherPart: () => void;
    importBoard: () => void;
    pending: () => void;
    inspect: () => { mesh: THREE.Mesh | null; geometry: THREE.BufferGeometry; part: Part | null;
      loading: boolean; error: string | null; selected: string[] };
    dispose: () => void;
  };
  return { ...harness, camera, controls, clearMeasure, resetTopology, schedulePreload, ensurePart, cancelPreviewTasks };
}

describe('preview cache hit mesh identity', () => {
  it('keeps the current mesh and selected measurements after another part changes', async () => {
    const preview = setup();
    const original = preview.inspect();
    preview.controls.target.set(12, 8, -4);
    preview.camera.position.set(150, 120, -210);
    preview.controls.update();
    const position = preview.camera.position.clone(), target = preview.controls.target.clone();
    preview.editOtherPart();
    expect(await preview.render()).toBe(true);
    expect(preview.inspect().mesh).toBe(original.mesh);
    expect(preview.inspect().selected).toEqual(['edge A', 'edge B']);
    expect(preview.camera.position.distanceTo(position)).toBeLessThan(1e-8);
    expect(preview.controls.target.distanceTo(target)).toBeLessThan(1e-8);
    expect(preview.clearMeasure).not.toHaveBeenCalled();
    expect(preview.resetTopology).not.toHaveBeenCalled();
    expect(preview.ensurePart).not.toHaveBeenCalled();
    expect(preview.schedulePreload).toHaveBeenCalledOnce();
  });

  it('reframes a newly imported board when the same cached geometry is reused', async () => {
    const preview = setup();
    const original = preview.inspect();
    const framedTarget = preview.controls.target.clone();
    const framedDistance = preview.camera.position.distanceTo(framedTarget);
    preview.controls.target.set(250, 180, -140);
    preview.camera.position.copy(preview.controls.target).add(new THREE.Vector3(12, 8, 15));
    preview.controls.update();
    preview.importBoard();

    expect(await preview.render()).toBe(true);
    expect(preview.inspect().geometry).toBe(original.geometry);
    expect(preview.controls.target.distanceTo(framedTarget)).toBeLessThan(1e-8);
    expect(preview.camera.position.distanceTo(preview.controls.target)).toBeCloseTo(framedDistance, 8);
    expect(preview.clearMeasure).toHaveBeenCalledOnce();
    expect(preview.ensurePart).not.toHaveBeenCalled();
  });

  it('settles an older loading/error state even when it retains the current mesh', async () => {
    const preview = setup();
    preview.pending();
    expect(await preview.render()).toBe(true);
    expect(preview.inspect()).toMatchObject({ loading: false, error: null, selected: ['edge A', 'edge B'] });
    expect(preview.cancelPreviewTasks).toHaveBeenCalledWith(['preview']);
  });

  it('reinstalls a different selected part even when both entries share a geometry reference', async () => {
    const preview = setup();
    const original = preview.inspect();
    preview.cache('base', original.geometry);
    preview.select('base');
    expect(await preview.render()).toBe(true);
    expect(preview.inspect().mesh).not.toBe(original.mesh);
    expect(preview.inspect().part).toBe('base');
    expect(preview.clearMeasure).toHaveBeenCalledOnce();
  });

  it('reinstalls a forced refresh even if generation returns the current geometry', async () => {
    const preview = setup();
    const original = preview.inspect();
    expect(await preview.render(true)).toBe(true);
    expect(preview.ensurePart).toHaveBeenCalledWith('insert', 0, {}, true);
    expect(preview.inspect().mesh).not.toBe(original.mesh);
    expect(preview.clearMeasure).toHaveBeenCalledOnce();
  });

  it('reinstalls replaced geometry under the same part and hash', async () => {
    const preview = setup();
    const original = preview.inspect();
    const replacement = new THREE.BoxGeometry(30, 5, 20);
    preview.cache('insert', replacement);
    expect(await preview.render()).toBe(true);
    expect(preview.inspect().mesh).not.toBe(original.mesh);
    expect(preview.inspect().geometry).toBe(replacement);
    expect(preview.clearMeasure).toHaveBeenCalledOnce();
  });

  it('reinstalls cached geometry after the previous mesh was disposed', async () => {
    const preview = setup();
    preview.dispose();
    expect(preview.inspect().part).toBeNull();
    expect(await preview.render()).toBe(true);
    expect(preview.inspect().mesh).not.toBeNull();
    expect(preview.inspect().part).toBe('insert');
  });
});
