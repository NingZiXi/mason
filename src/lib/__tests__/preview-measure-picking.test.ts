import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Run the real picking and topology code without mounting a WebGL viewport.
const source = readFileSync(new URL('../../components/ModelPreview.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
const syntax = createSourceFile('ModelPreview.ts', script, ScriptTarget.Latest, true, ScriptKind.TS);
const names = new Set(['ensureTopology', 'resetTopology', 'invalidateScreenCache', 'pickFeature',
  'getFeatureScreens', 'screenSegClosest', 'isMeasurePointVisible']);
const functions = syntax.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text ?? ''));
if (functions.length !== names.size) throw new Error('A viewport picking function is missing from the test harness');
const javascript = transpileModule(functions.map(node => node.getText(syntax)).join('\n'),
  { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;

interface Feature { kind: string; id: string; radius?: number; center?: THREE.Vector3; edgePts?: THREE.Vector3[] }
interface Topology { edgeFeatures: Feature[]; circleFeatures: Feature[] }

function pickingHarness(geometry: THREE.BufferGeometry, below = false) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  camera.position.set(0, 0, below ? -60 : 60);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const raycaster = new THREE.Raycaster();
  const intersect = vi.spyOn(raycaster, 'intersectObject');
  const create = new Function('THREE', 'mesh', 'cameraObject', 'raycaster', `
    const currentMesh = { value: mesh }, camera = { value: cameraObject };
    const canvasEl = { value: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 }) } };
    const ndcPoint = new THREE.Vector2();
    let topo = null, topoMesh = null, screenCache = null;
    ${javascript}
    return { pick: pickFeature, topology: () => { ensureTopology(mesh); return topo; },
      visible: point => isMeasurePointVisible(point, mesh, cameraObject, new Map()),
      replace: geometry => { mesh.geometry = geometry; resetTopology(); } };
  `);
  const handlers = create(THREE, mesh, camera, raycaster) as {
    pick: (event: PointerEvent) => Feature | null;
    topology: () => Topology;
    visible: (point: THREE.Vector3) => boolean;
    replace: (geometry: THREE.BufferGeometry) => void;
  };
  const pickAt = (point: THREE.Vector3) => {
    const screen = point.clone().project(camera);
    return handlers.pick({ clientX: (screen.x * 0.5 + 0.5) * 800,
      clientY: (-screen.y * 0.5 + 0.5) * 800 } as PointerEvent);
  };
  return { ...handlers, pickAt, intersect, camera, mesh };
}

// A manifold block, z=-5..2, with a radius-4 blind pocket opening downward.
// The pocket ceiling at z=0 is entirely hidden when looking at the solid top.
function blindPocket() {
  const top = new THREE.PlaneGeometry(40, 40).translate(0, 0, 2);
  const outline = new THREE.Shape().moveTo(-20, -20).lineTo(20, -20)
    .lineTo(20, 20).lineTo(-20, 20).closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 4, 0, Math.PI * 2, true);
  outline.holes.push(hole);
  const bottom = new THREE.ShapeGeometry(outline, 32).rotateX(Math.PI).translate(0, 0, -5);
  const box = new THREE.BoxGeometry(40, 40, 7).translate(0, 0, -1.5).toNonIndexed();
  const sides = new THREE.BufferGeometry();
  // BoxGeometry's first four groups are the outer vertical walls.
  sides.setAttribute('position', new THREE.Float32BufferAttribute(box.attributes.position.array.slice(0, 72), 3));
  const inner = new THREE.CylinderGeometry(4, 4, 5, 64, 1, true)
    .rotateX(Math.PI / 2).translate(0, 0, -2.5).toNonIndexed();
  // A pocket wall faces its empty interior.
  const positions = inner.attributes.position.array;
  for (let i = 0; i < positions.length; i += 9) {
    for (let axis = 0; axis < 3; axis++) {
      const first = positions[i + axis];
      positions[i + axis] = positions[i + 6 + axis];
      positions[i + 6 + axis] = first;
    }
  }
  const ceiling = new THREE.CircleGeometry(4, 64).rotateX(Math.PI);
  const surfaces = [top, bottom, sides, inner, ceiling].map(surface => {
    const triangles = surface.index ? surface.toNonIndexed() : surface;
    triangles.deleteAttribute('normal');
    triangles.deleteAttribute('uv');
    return triangles;
  });
  const geometry = mergeGeometries(surfaces)!;
  geometry.computeVertexNormals();
  return geometry;
}

describe('3D measurement feature visibility', () => {
  it('does not select a blind pocket through the opaque top surface', () => {
    const { pickAt, topology } = pickingHarness(blindPocket());
    expect(topology().circleFeatures).toHaveLength(2);
    expect(pickAt(new THREE.Vector3(4, 0, 0))?.kind).toBe('plane');
  });

  it('does not snap to a hit triangle vertex hidden behind another surface', () => {
    const triangle = new THREE.Shape().moveTo(20.6, 0).lineTo(30, -20).lineTo(30, 20).closePath();
    const back = new THREE.ExtrudeGeometry(triangle, { depth: 1, bevelEnabled: false }).translate(0, 0, -1);
    back.deleteAttribute('uv');
    const { pickAt } = pickingHarness(mergeGeometries([blindPocket(), back])!);
    // The pointer sees the rear triangle, but its nearest corner at x=20.6 is
    // behind the front block due to perspective. The visible block edge wins.
    expect(pickAt(new THREE.Vector3(20.75, 0, 0))?.kind).toBe('edge');
  });

  it('still snaps to a visible circular rim from the adjacent surface', () => {
    const disc = new THREE.CylinderGeometry(4, 4, 0.2, 64)
      .rotateX(Math.PI / 2).translate(0, 0, 4).toNonIndexed();
    disc.deleteAttribute('uv');
    const { pickAt } = pickingHarness(mergeGeometries([blindPocket(), disc])!);
    // The pointer hits the broad plate behind the disc, away from its vertices.
    const selected = pickAt(new THREE.Vector3(4.2, 0, 4.1));
    expect(selected?.kind).toBe('circle');
    expect(selected?.radius).toBeCloseTo(4);
    expect(selected?.center?.z).toBeCloseTo(4.1);
  });

  it('keeps the actual visible pocket rim selectable from below', () => {
    const { visible } = pickingHarness(blindPocket(), true);
    expect(visible(new THREE.Vector3(4, 0, -5))).toBe(true);
  });

  it('keeps a shared outer edge selectable without mistaking its own faces for occluders', () => {
    const { pickAt } = pickingHarness(blindPocket());
    expect(pickAt(new THREE.Vector3(19.95, 0, 2))?.kind).toBe('edge');
  });

  it('continues to the visible edge after a closer hidden feature', () => {
    const { pickAt, topology } = pickingHarness(blindPocket());
    const features = topology();
    // Place the pointer exactly on a hidden pocket rim and a nearby visible
    // front-face edge 0.2 mm away. Keep the actual solid as the occluder.
    features.edgeFeatures = [{ kind: 'edge', id: 'visible',
      edgePts: [new THREE.Vector3(4.2, -10, 2), new THREE.Vector3(4.2, 10, 2)] }];
    expect(pickAt(new THREE.Vector3(4, 0, 0))?.id).toBe('visible');
  });

  it('reuses visibility checks for an unchanged camera and candidate point', () => {
    const { pickAt, intersect } = pickingHarness(blindPocket());
    const point = new THREE.Vector3(4, 0, 0);
    pickAt(point);
    const initialCalls = intersect.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(1);
    pickAt(point);
    // The initial pointer ray is still needed; candidate occlusion is cached.
    expect(intersect.mock.calls.length).toBe(initialCalls + 1);
  });

  it('invalidates cached visibility when topology or camera projection changes', () => {
    const { pickAt, replace, camera, intersect } = pickingHarness(blindPocket());
    const point = new THREE.Vector3(4, 0, 0);
    pickAt(point);
    const beforeReplacement = intersect.mock.calls.length;
    replace(blindPocket());
    pickAt(point);
    expect(intersect.mock.calls.length - beforeReplacement).toBeGreaterThan(1);
    const beforeProjectionChange = intersect.mock.calls.length;
    camera.zoom = 1.1;
    camera.updateProjectionMatrix();
    pickAt(point);
    expect(intersect.mock.calls.length - beforeProjectionChange).toBeGreaterThan(1);
  });

  it('does not let a surface before the camera near plane occlude a visible feature', () => {
    const { visible, camera } = pickingHarness(blindPocket());
    camera.near = 59;
    camera.updateProjectionMatrix();
    expect(visible(new THREE.Vector3(4, 0, 0))).toBe(true);
  });

  it('rejects feature points outside the camera clipping planes', () => {
    const { visible, camera } = pickingHarness(blindPocket());
    camera.far = 59;
    camera.updateProjectionMatrix();
    expect(visible(new THREE.Vector3(4, 0, 0))).toBe(false);
  });
});
