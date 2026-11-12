import * as THREE from "three";
import type { PadPolygon } from "./gerber/pads";
import { createStencilTexture } from "./gerber-pad-texture";
import { buildPcbPreview, recolorPcbPreview } from "./pcb-preview";
import { getModelPalette, type ModelPalette } from "./model-palette";
import { orientBoardPads, type JigPrintSide } from './component-relief';

type Ring = readonly (readonly [number, number])[];
// Visual sheet thickness only; this is not the independent printed-stencil setting.
export const ASSEMBLY_STENCIL_THICKNESS = 0.2;

export interface AssemblyOptions {
  insertHeight: number;
  baseHeight: number;
  topCoverHeight: number;
  screwSpec: string;
  useHexNut: boolean;
  nutAcrossFlats: number;
  nutHeight: number;
  screwPositions: readonly (readonly [number, number])[];
  pcbOutlinePoints?: Ring;
  pcbOutlineHoles?: readonly Ring[];
  pcbThickness?: number;
  environmentMap?: THREE.Texture | null;
  stencilSizeX?: number;
  stencilSizeY?: number;
  stencilPadsTop?: readonly PadPolygon[];
  stencilPadsBottom?: readonly PadPolygon[];
  palette?: ModelPalette;
  jigPrintSide?: JigPrintSide;
}

/** Reveal the tray without discarding layer visibility or the explosion pose. */
export function setJigReliefInspection(group: THREE.Group, enabled: boolean) {
  for (const part of group.children) {
    if (part.name === 'insert') continue;
    part.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => {
        if (material.transparent !== enabled) material.needsUpdate = true;
        material.transparent = enabled;
        material.opacity = enabled ? 0.18 : 1;
        material.depthWrite = !enabled;
      });
    });
  }
}

/** Retint the existing assembly without invalidating its geometry or pose. */
export function recolorJigAssembly(group: THREE.Group, palette: ModelPalette) {
  for (const object of group.children) {
    if (!(object instanceof THREE.Mesh)) continue;
    if (object.name === "pcb") {
      recolorPcbPreview(object, palette);
      continue;
    }
    const part = object.name as keyof ModelPalette["parts"];
    const plastic = Object.prototype.hasOwnProperty.call(palette.parts, part);
    const color = plastic ? palette.parts[part] : ({
      "metal-stencil": palette.metalStencil,
      "screw-shafts": palette.hardware,
      "screw-heads": palette.hardware,
      "screw-sockets": palette.socket,
      nuts: palette.nut,
    } as Record<string, number>)[object.name];
    if (color === undefined) continue;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach(material => {
      if (!(material instanceof THREE.MeshStandardMaterial)) return;
      material.color.setHex(color);
      if (plastic) {
        material.metalness = palette.plastic.metalness;
        material.roughness = palette.plastic.roughness;
      }
    });
  }
}

export function setJigVisibility(group: THREE.Group, pcb: boolean, stencil: boolean) {
  const board = group.getObjectByName("pcb");
  const sheet = group.getObjectByName("metal-stencil");
  if (board) board.visible = pcb;
  if (sheet) sheet.visible = stencil;
}

const explosionStates = new WeakMap<THREE.Group, Array<{ object: THREE.Object3D; y: number; lift: number }>>();

/** Absolute offsets make repeated slider changes reversible without drift. */
export function setJigExplosion(group: THREE.Group, amount: number) {
  const progress = Number.isFinite(amount) ? THREE.MathUtils.clamp(amount, 0, 1) : 0;
  explosionStates.get(group)?.forEach(({ object, y, lift }) => {
    object.position.y = y + lift * progress;
  });
  group.updateMatrixWorld(true);
}

/** STL coordinates are already Y-up. Keep cached originals untouched. */
export function buildJigAssembly(
  parts: Record<"insert" | "base" | "cover", THREE.BufferGeometry>,
  options: AssemblyOptions,
) {
  const palette = options.palette ?? getModelPalette("classic");
  const group = new THREE.Group();
  group.name = "jig-assembly";
  const addPart = (name: keyof typeof parts) => {
    const mesh = new THREE.Mesh(parts[name].clone(), new THREE.MeshStandardMaterial({
      color: palette.parts[name], ...palette.plastic,
    }));
    mesh.name = name;
    group.add(mesh);
    return mesh;
  };
  addPart("insert");
  const base = addPart("base");
  // The generated base already has its nut recesses at Y=0. Do not flip it:
  // the recesses must open downwards, toward the tray.
  base.position.y = options.insertHeight - options.baseHeight;
  const sheetThickness = options.stencilSizeX && options.stencilSizeY ? ASSEMBLY_STENCIL_THICKNESS : 0;
  addPart("cover").position.y = options.insertHeight + sheetThickness;

  if (options.pcbOutlinePoints && options.pcbOutlinePoints.length >= 3) {
    const thickness = options.pcbThickness ?? 1.6;
    const pcb = buildPcbPreview({
      outline: options.pcbOutlinePoints, holes: options.pcbOutlineHoles,
      thickness, topPads: options.stencilPadsTop, bottomPads: options.stencilPadsBottom,
      environmentMap: options.environmentMap,
      palette,
    });
    pcb.name = "pcb";
    if (options.jigPrintSide === 'bottom') {
      pcb.rotation.x = Math.PI;
      pcb.position.y = options.insertHeight;
    } else pcb.position.y = options.insertHeight - thickness;
    group.add(pcb);
  }
  if (sheetThickness) {
    const width = options.stencilSizeX!, height = options.stencilSizeY!;
    const selectedPads = options.jigPrintSide === 'bottom'
      ? options.stencilPadsBottom ?? []
      : options.jigPrintSide === 'top' ? options.stencilPadsTop ?? []
        : options.stencilPadsTop?.length ? options.stencilPadsTop : options.stencilPadsBottom ?? [];
    const pads = orientBoardPads(selectedPads, options.jigPrintSide ?? 'top');
    const geometry = new THREE.PlaneGeometry(width, height);
    geometry.rotateX(-Math.PI / 2);
    const stencil = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: palette.metalStencil, roughness: 0.38, metalness: 0.45, side: THREE.DoubleSide,
      alphaMap: createStencilTexture(width, height, pads), alphaTest: 0.5,
    }));
    stencil.name = "metal-stencil";
    stencil.position.y = options.insertHeight + sheetThickness / 2;
    group.add(stencil);
  }

  // Only the perimeter holes receive screws. The four corner posts belong to
  // the tray STL and must stay hollow; fasteners never extend through the tray.
  const diameter = Number(options.screwSpec.slice(1)) || 3;
  const bottom = options.insertHeight - options.baseHeight + 0.2;
  const top = options.insertHeight + sheetThickness + options.topCoverHeight;
  const headHeight = diameter * 0.65;
  const metal = new THREE.MeshStandardMaterial({ color: palette.hardware, metalness: 0.8, roughness: 0.3 });
  const socket = new THREE.MeshStandardMaterial({ color: palette.socket, metalness: 0.5, roughness: 0.5 });
  const addInstances = (name: string, geometry: THREE.BufferGeometry, y: number, material = metal) => {
    const instances = new THREE.InstancedMesh(geometry, material, options.screwPositions.length);
    instances.name = name;
    const matrix = new THREE.Matrix4();
    options.screwPositions.forEach(([x, boardY], index) => {
      instances.setMatrixAt(index, matrix.makeTranslation(x, y, -boardY));
    });
    instances.instanceMatrix.needsUpdate = true;
    instances.computeBoundingSphere();
    group.add(instances);
  };
  if (options.screwPositions.length) {
    addInstances("screw-shafts", new THREE.CylinderGeometry(diameter / 2, diameter / 2, top - bottom, 16), (top + bottom) / 2);
    addInstances("screw-heads", new THREE.CylinderGeometry(diameter * 0.85, diameter * 0.85, headHeight, 24), top + headHeight / 2);
    addInstances("screw-sockets", new THREE.CylinderGeometry(diameter * 0.4, diameter * 0.4, 0.015, 6), top + headHeight, socket);
    if (options.useHexNut) {
      const radius = options.nutAcrossFlats / Math.sqrt(3);
      // Match the actual hex pocket, with an open bore rather than a solid hex prism.
      const shape = new THREE.Shape(Array.from({ length: 6 }, (_, i) =>
        new THREE.Vector2(radius * Math.cos(i * Math.PI / 3), radius * Math.sin(i * Math.PI / 3))));
      const bore = new THREE.Path();
      bore.absarc(0, 0, diameter * 0.52, 0, Math.PI * 2, true);
      shape.holes.push(bore);
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: options.nutHeight, bevelEnabled: false, steps: 1, curveSegments: 16,
      });
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, -options.nutHeight / 2, 0);
      const nutMetal = new THREE.MeshStandardMaterial({
        color: palette.nut, metalness: 0.65, roughness: 0.4,
        envMap: options.environmentMap ?? null, envMapIntensity: 0.65,
      });
      addInstances("nuts", geometry, options.insertHeight - options.baseHeight + options.nutHeight / 2, nutMetal);
    }
  } else {
    metal.dispose();
    socket.dispose();
  }
  parts.insert.computeBoundingBox();
  const size = parts.insert.boundingBox!.getSize(new THREE.Vector3());
  // Leave room for the nuts to clear both the tray and the base when exploded.
  const gap = Math.max(16, Math.max(size.x, size.z) * 0.14,
    options.baseHeight + options.topCoverHeight, 2 * Math.max(options.baseHeight, options.nutHeight) + 4);
  const levels: Record<string, number> = {
    insert: 0, pcb: 0.5, base: 1, "metal-stencil": 2, cover: 3,
    "screw-shafts": 4, "screw-heads": 4, "screw-sockets": 4, nuts: 0.5,
  };
  explosionStates.set(group, group.children.map(object => ({ object, y: object.position.y, lift: gap * levels[object.name] })));
  recolorJigAssembly(group, palette);
  group.updateMatrixWorld(true);
  return group;
}

/** Assembly owns its clones and fasteners, never the STL cache's geometry. */
export function disposeJigAssembly(group: THREE.Group) {
  explosionStates.delete(group);
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
    if (object instanceof THREE.InstancedMesh) object.dispose();
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  materials.forEach(material => {
    if (material instanceof THREE.MeshStandardMaterial) material.alphaMap?.dispose();
  });
}
