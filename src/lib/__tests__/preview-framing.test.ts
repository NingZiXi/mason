import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import * as THREE from 'three';
import { getModelPalette } from '../model-palette';
import { createPreviewFramingMotion } from '../preview-camera-motion';

// Exercise the real mesh replacement and camera framing without WebGL or UI.
const source = readFileSync(new URL('../../components/ModelPreview.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
const syntax = createSourceFile('ModelPreview.ts', script, ScriptTarget.Latest, true, ScriptKind.TS);
const names = new Set(['applyStlToMesh', 'applyAssembly', 'framePreviewObject', 'cancelCameraMotion', 'onCameraInteraction']);
const functions = syntax.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text ?? ''));
const javascript = transpileModule(functions.map(node => node.getText(syntax)).join('\n'),
  { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
const resources: Array<{ dispose(): void }> = [];
afterEach(() => resources.splice(0).forEach(resource => resource.dispose()));

function setup(aspect = 4 / 3) {
  const camera = new THREE.PerspectiveCamera(45, aspect, .1, 5000);
  camera.position.set(120, 80, 150);
  const target = new THREE.Vector3();
  const update = vi.fn(() => { camera.lookAt(target); camera.updateMatrixWorld(true); });
  update();
  const settle = vi.fn();
  let now = 0;
  const makeAssembly = () => {
    const group = new THREE.Group();
    const geometry = new THREE.BoxGeometry(180, 30, 160), material = new THREE.MeshBasicMaterial();
    resources.push(geometry, material);
    group.add(new THREE.Mesh(geometry, material));
    return group;
  };
  const create = new Function('THREE', 'cam', 'target', 'update', 'settle', 'palette',
    'createPreviewFramingMotion', 'performance', 'buildJigAssembly', `
    const camera = { value: cam }, controls = { value: { target, update } };
    const modelPalette = { value: palette }, ui = { skin: 'classic' }, activePart = { value: 'insert' };
    const store = { config: { pcbOutlinePoints: [[-20,-15], [20,-15], [20,15], [-20,15]] } };
    const scene = { value: new THREE.Scene() }, currentMesh = { value: null }, currentAssembly = { value: null };
    let currentMeshPart = null, framedBoardOutline = null, cameraMotion = null;
    const settleCameraControls = settle, selectedView = { value: 'iso' };
    const renderer = { value: null }, pcbEnvironment = null;
    const stlCache = { value: { insert: {}, base: {}, cover: {} } }, getOrParseGeometry = () => {};
    const effectiveInsertHeight = () => 10, effectiveJigPrintSide = () => 'top';
    const showAssemblyPcb = { value: true }, showAssemblyStencil = { value: true }, inspectRelief = { value: false };
    const explosionPercent = { value: 0 };
    let displayedExplosion = 0, explosionFrameTime = null;
    const setMeasureMode = () => {}, setJigVisibility = () => {}, setJigReliefInspection = () => {};
    const setJigExplosion = (group, value) => { group.children[0].position.y = value * 120; };
    const resetTopology = () => {}, invalidate = () => {};
    const disposeMesh = () => {
      if (currentMesh.value) { scene.value.remove(currentMesh.value); currentMesh.value.material.dispose(); }
      if (currentAssembly.value) scene.value.remove(currentAssembly.value);
      currentMesh.value = null; currentMeshPart = null; currentAssembly.value = null;
    };
    ${javascript}
    return { apply: applyStlToMesh, mesh: () => currentMesh.value, applyAssembly,
      motion: () => cameraMotion, interact: onCameraInteraction,
      sample: time => {
        if (!cameraMotion) return;
        const offset = new THREE.Vector3();
        const continuing = cameraMotion.sample(time, offset, target);
        cam.position.copy(target).add(offset);
        update();
        if (!continuing) cameraMotion = null;
      },
      board: () => { store.config.pcbOutlinePoints = store.config.pcbOutlinePoints.map(p => [...p]); },
      part: value => { activePart.value = value; },
      assembly: () => { currentAssembly.value = new THREE.Group(); currentMesh.value = null; currentMeshPart = null; },
      dispose: disposeMesh };
  `);
  const harness = create(THREE, camera, target, update, settle, getModelPalette('classic'),
    createPreviewFramingMotion, { now: () => now }, makeAssembly) as {
    apply: (geometry: THREE.BufferGeometry) => void;
    mesh: () => THREE.Mesh;
    board: () => void;
    part: (part: string) => void;
    assembly: () => void;
    applyAssembly: () => void;
    motion: () => ReturnType<typeof createPreviewFramingMotion> | null;
    interact: () => void;
    sample: (now: number) => void;
    dispose: () => void;
  };
  resources.push({ dispose: harness.dispose });
  const geometry = (width: number, depth: number, height = 8) => {
    const result = new THREE.BoxGeometry(width, height, depth);
    resources.push(result);
    return result;
  };
  const expectVisible = () => {
    const box = new THREE.Box3().setFromObject(harness.mesh());
    expect(target.distanceTo(box.getCenter(new THREE.Vector3()))).toBeLessThan(1e-8);
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const projected = new THREE.Vector3(x, y, z).project(camera);
      expect(Math.abs(projected.x)).toBeLessThan(1);
      expect(Math.abs(projected.y)).toBeLessThan(1);
      expect(projected.z).toBeGreaterThan(-1);
      expect(projected.z).toBeLessThan(1);
    }
  };
  const sample = (time: number) => { now = time; harness.sample(time); };
  return { ...harness, sample, camera, target, update, settle, geometry, expectVisible };
}

describe('single-part preview framing', () => {
  it.each([4 / 3, .45, .08])('frames a large first model at viewport aspect %s', aspect => {
    const state = setup(aspect);
    state.apply(state.geometry(600, 420));
    expect(state.motion()).toBeNull();
    state.expectVisible();
  });

  it('frames a newly imported board even when the selected part stays the same', () => {
    const state = setup();
    state.apply(state.geometry(90, 70));
    state.board();
    state.apply(state.geometry(480, 360));
    expect(state.motion()).toBeNull();
    state.expectVisible();
    expect(state.settle).toHaveBeenCalledTimes(2);
  });

  it('reframes on return from an exploded assembly instead of retaining its distant target', () => {
    const state = setup();
    state.assembly();
    state.target.set(0, 120, 0);
    state.camera.position.set(700, 550, 900);
    state.update();
    const oldDistance = state.camera.position.distanceTo(state.target);
    state.apply(state.geometry(100, 80));
    state.expectVisible();
    expect(state.camera.position.distanceTo(state.target)).toBeLessThan(oldDistance / 2);
  });

  it('preserves the user orbit, pan and zoom on ordinary parameter refreshes', () => {
    const state = setup();
    state.apply(state.geometry(120, 100));
    state.target.set(12, 8, -4);
    state.camera.position.set(150, 120, -210);
    state.update();
    const position = state.camera.position.clone(), target = state.target.clone();
    state.apply(state.geometry(122, 100));
    expect(state.camera.position).toEqual(position);
    expect(state.target).toEqual(target);
    expect(state.settle).toHaveBeenCalledOnce();
  });

  it('fits a different part while retaining the current viewing direction', () => {
    const state = setup(.7);
    state.apply(state.geometry(120, 100));
    state.camera.position.copy(state.target).add(new THREE.Vector3(-140, 160, -170));
    state.update();
    const direction = state.camera.position.clone().sub(state.target).normalize();
    state.part('base');
    state.apply(state.geometry(160, 130, 4));
    state.sample(280);
    state.expectVisible();
    expect(state.camera.position.clone().sub(state.target).normalize().distanceTo(direction)).toBeLessThan(1e-8);
  });

  it('smoothly reframes on return from an assembly of the same board', () => {
    const state = setup(.7);
    state.apply(state.geometry(100, 80));
    state.part('assembly');
    const before = state.camera.position.clone(), beforeTarget = state.target.clone();
    state.applyAssembly();
    expect(state.motion()).not.toBeNull();
    expect(state.camera.position).toEqual(before);
    expect(state.target).toEqual(beforeTarget);
    state.sample(280);
    const assemblyPosition = state.camera.position.clone(), assemblyTarget = state.target.clone();
    state.part('insert');
    state.apply(state.geometry(100, 80));
    expect(state.camera.position).toEqual(assemblyPosition);
    expect(state.target).toEqual(assemblyTarget);
    state.sample(420);
    expect(state.camera.position.distanceTo(assemblyPosition)).toBeGreaterThan(1);
    state.sample(560);
    state.expectVisible();
    expect(state.motion()).toBeNull();
  });

  it('starts a rapid part change from the visible framing and keeps drag interruption authoritative', () => {
    const state = setup();
    state.apply(state.geometry(100, 80));
    state.part('assembly');
    state.applyAssembly();
    state.sample(100);
    const position = state.camera.position.clone(), target = state.target.clone();
    state.part('cover');
    state.apply(state.geometry(160, 130, 4));
    state.sample(100);
    expect(state.camera.position).toEqual(position);
    expect(state.target).toEqual(target);
    state.sample(160);
    state.interact();
    state.camera.position.set(100, 200, -300);
    state.target.set(12, 8, -4);
    state.sample(1000);
    expect(state.motion()).toBeNull();
    expect(state.camera.position).toEqual(new THREE.Vector3(100, 200, -300));
    expect(state.target).toEqual(new THREE.Vector3(12, 8, -4));
  });

  it('preserves in-flight framing when the current part gets a parameter refresh', () => {
    const state = setup();
    state.apply(state.geometry(100, 80));
    state.part('base');
    state.apply(state.geometry(160, 130, 4));
    state.sample(100);
    const motion = state.motion();
    const position = state.camera.position.clone(), target = state.target.clone();
    state.apply(state.geometry(161, 130, 4));
    expect(state.motion()).toBe(motion);
    expect(state.camera.position).toEqual(position);
    expect(state.target).toEqual(target);
    state.sample(280);
    state.expectVisible();
  });

  it('immediately frames a newly imported board instead of completing an old transition', () => {
    const state = setup(.45);
    state.apply(state.geometry(100, 80));
    state.part('base');
    state.apply(state.geometry(160, 130, 4));
    state.sample(100);
    expect(state.motion()).not.toBeNull();
    state.board();
    state.apply(state.geometry(600, 420));
    expect(state.motion()).toBeNull();
    state.expectVisible();
    const position = state.camera.position.clone(), target = state.target.clone();
    state.sample(1000);
    expect(state.camera.position).toEqual(position);
    expect(state.target).toEqual(target);
  });
});
