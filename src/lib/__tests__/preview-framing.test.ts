import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import * as THREE from 'three';
import { getModelPalette } from '../model-palette';

// Exercise the real mesh replacement and camera framing without WebGL or UI.
const source = readFileSync(new URL('../../components/ModelPreview.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
const syntax = createSourceFile('ModelPreview.ts', script, ScriptTarget.Latest, true, ScriptKind.TS);
const names = new Set(['applyStlToMesh', 'framePreviewObject']);
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
  const create = new Function('THREE', 'cam', 'target', 'update', 'settle', 'palette', `
    const camera = { value: cam }, controls = { value: { target, update } };
    const modelPalette = { value: palette }, ui = { skin: 'classic' }, activePart = { value: 'insert' };
    const store = { config: { pcbOutlinePoints: [[-20,-15], [20,-15], [20,15], [-20,15]] } };
    const scene = { value: new THREE.Scene() }, currentMesh = { value: null }, currentAssembly = { value: null };
    let currentMeshPart = null, framedBoardOutline = null;
    const cancelCameraMotion = () => {}, settleCameraControls = settle, selectedView = { value: 'iso' };
    const resetTopology = () => {}, invalidate = () => {};
    const disposeMesh = () => {
      if (currentMesh.value) { scene.value.remove(currentMesh.value); currentMesh.value.material.dispose(); }
      currentMesh.value = null; currentMeshPart = null; currentAssembly.value = null;
    };
    ${javascript}
    return { apply: applyStlToMesh, mesh: () => currentMesh.value,
      board: () => { store.config.pcbOutlinePoints = store.config.pcbOutlinePoints.map(p => [...p]); },
      part: value => { activePart.value = value; },
      assembly: () => { currentAssembly.value = new THREE.Group(); currentMesh.value = null; currentMeshPart = null; },
      dispose: disposeMesh };
  `);
  const harness = create(THREE, camera, target, update, settle, getModelPalette('classic')) as {
    apply: (geometry: THREE.BufferGeometry) => void;
    mesh: () => THREE.Mesh;
    board: () => void;
    part: (part: string) => void;
    assembly: () => void;
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
  return { ...harness, camera, target, update, settle, geometry, expectVisible };
}

describe('single-part preview framing', () => {
  it.each([4 / 3, .45, .08])('frames a large first model at viewport aspect %s', aspect => {
    const state = setup(aspect);
    state.apply(state.geometry(600, 420));
    state.expectVisible();
  });

  it('frames a newly imported board even when the selected part stays the same', () => {
    const state = setup();
    state.apply(state.geometry(90, 70));
    state.board();
    state.apply(state.geometry(480, 360));
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
    state.expectVisible();
    expect(state.camera.position.clone().sub(state.target).normalize().distanceTo(direction)).toBeLessThan(1e-8);
  });
});
