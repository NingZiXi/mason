import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { buildJigAssembly, disposeJigAssembly, recolorJigAssembly, setJigExplosion, setJigVisibility, type AssemblyOptions } from "../jig-assembly";
import { buildPcbPreview, recolorPcbPreview } from "../pcb-preview";
import { getModelPalette } from "../model-palette";
import { createPadTexture, createStencilTexture } from "../gerber-pad-texture";
import type { PadPolygon } from "../gerber/pads";

// Texture drawing belongs to its own tests; these identity checks ensure that
// changing a skin cannot rerasterize a Gerber mask or replace its resources.
vi.mock("../gerber-pad-texture", async () => {
  const three = await import("three");
  return {
    createPadTexture: vi.fn(() => new three.Texture()),
    createStencilTexture: vi.fn(() => new three.Texture()),
  };
});

const outline: [number, number][] = [[-10, -6], [10, -6], [10, 6], [-10, 6]];
const pads: PadPolygon[] = [{ type: "rect", cx: 0, cy: 0, polarity: "D", parts: [
  { polarity: "D", points: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
] }];
const options: AssemblyOptions = {
  insertHeight: 8, baseHeight: 4, topCoverHeight: 4, screwSpec: "M3",
  useHexNut: true, nutAcrossFlats: 5.5, nutHeight: 2.4,
  screwPositions: [[0, 20], [0, -20]],
  pcbOutlinePoints: outline, pcbThickness: 1.6,
  stencilPadsTop: pads, stencilPadsBottom: pads, stencilSizeX: 40, stencilSizeY: 35,
};

function fixture() {
  return {
    insert: new THREE.BoxGeometry(50, 8, 50),
    base: new THREE.BoxGeometry(50, 4, 50),
    cover: new THREE.BoxGeometry(50, 4, 50),
  };
}

function materialOf(group: THREE.Object3D, name: string) {
  return (group.getObjectByName(name) as THREE.Mesh).material as THREE.MeshStandardMaterial;
}

function assemblyColors(group: THREE.Group) {
  const board = group.getObjectByName("pcb") as THREE.Mesh;
  const [mask, edge] = board.material as [THREE.MeshLambertMaterial, THREE.MeshStandardMaterial];
  const namedColors = Object.fromEntries(["insert", "base", "cover", "metal-stencil", "screw-shafts", "screw-heads", "screw-sockets", "nuts", "pcb-pads-top", "pcb-pads-bottom"]
    .map(name => [name, materialOf(group, name).color.getHex()]));
  return { ...namedColors, pcb: mask.color.getHex(), substrate: edge.color.getHex() };
}

afterEach(() => vi.clearAllMocks());

describe("model skin palette", () => {
  it("retains the existing classic assembly, PCB, and fastener appearance by default", () => {
    const parts = fixture();
    const group = buildJigAssembly(parts, options);
    expect(assemblyColors(group)).toEqual({
      insert: 0x5a9b7f, base: 0x4c6f94, cover: 0xd9913d,
      "metal-stencil": 0xc5ced2, "screw-shafts": 0xb5bdc8, "screw-heads": 0xb5bdc8,
      "screw-sockets": 0x27303a, nuts: 0xc5cbd1,
      pcb: 0x397fbb, substrate: 0x99815a, "pcb-pads-top": 0xc9af70, "pcb-pads-bottom": 0xc9af70,
    });
    for (const name of ["insert", "base", "cover"]) {
      expect(materialOf(group, name).metalness).toBe(0.1);
      expect(materialOf(group, name).roughness).toBe(0.65);
    }
    expect(materialOf(group, "screw-heads").metalness).toBe(0.8);
    expect(materialOf(group, "metal-stencil").roughness).toBe(0.38);
    recolorJigAssembly(group, getModelPalette("classic"));
    expect(materialOf(group, "base").color.getHex()).toBe(0x4c6f94);
    disposeJigAssembly(group);
    Object.values(parts).forEach(geometry => geometry.dispose());
  });

  it("uses distinct Sakura part, board, and hardware colours with a softer plastic material", () => {
    const parts = fixture();
    const group = buildJigAssembly(parts, { ...options, palette: getModelPalette("sakura") });
    expect(assemblyColors(group)).toEqual({
      insert: 0xf3d9e4, base: 0x8ca8e0, cover: 0xe49ab5,
      "metal-stencil": 0xc5ced2, "screw-shafts": 0x58616c, "screw-heads": 0x58616c,
      "screw-sockets": 0x29313a, nuts: 0x58616c,
      pcb: 0x3e5fa4, substrate: 0xb49b7b, "pcb-pads-top": 0xdcc6a4, "pcb-pads-bottom": 0xdcc6a4,
    });
    for (const name of ["insert", "base", "cover"]) {
      expect(materialOf(group, name).metalness).toBe(0.05);
      expect(materialOf(group, name).roughness).toBe(0.72);
    }
    const palette = getModelPalette("sakura");
    expect(palette.parts.stencil_top).toBe(palette.parts.cover);
    expect(palette.parts.stencil_bottom).toBe(palette.parts.base);
    expect(new Set(Object.values(palette.measurement)).size).toBe(3);
    expect(palette.selection.a).not.toBe(palette.selection.b);
    disposeJigAssembly(group);
    Object.values(parts).forEach(geometry => geometry.dispose());
  });

  it("recolours an exploded assembly in place without changing masks, pose, visibility, or resource ownership", () => {
    const parts = fixture();
    const group = buildJigAssembly(parts, options);
    const originalColors = assemblyColors(group);
    setJigExplosion(group, 0.62);
    setJigVisibility(group, false, true);
    const snapshots: Array<{
      mesh: THREE.Mesh; geometry: THREE.BufferGeometry; materials: THREE.Material[];
      position: THREE.Vector3; matrix: number[]; instanceMatrix?: number[];
    }> = [];
    const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
    group.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      snapshots.push({ mesh: object, geometry: object.geometry, materials, position: object.position.clone(),
        matrix: object.matrix.toArray(), instanceMatrix: object instanceof THREE.InstancedMesh ? Array.from(object.instanceMatrix.array) : undefined });
      resources.add(object.geometry);
      materials.forEach(material => {
        resources.add(material);
        if (material instanceof THREE.MeshStandardMaterial && material.alphaMap) resources.add(material.alphaMap);
      });
    });
    const disposal = [...resources].map(resource => vi.spyOn(resource, "dispose"));
    const topTexture = materialOf(group, "pcb-pads-top").alphaMap;
    const steelTexture = materialOf(group, "metal-stencil").alphaMap;
    const drawCount = vi.mocked(createPadTexture).mock.calls.length;
    const steelDrawCount = vi.mocked(createStencilTexture).mock.calls.length;
    for (const skin of ["sakura", "classic", "sakura"] as const) recolorJigAssembly(group, getModelPalette(skin));
    snapshots.forEach(({ mesh, geometry, materials, position, matrix, instanceMatrix }) => {
      expect(mesh.geometry).toBe(geometry);
      expect(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).toEqual(materials);
      expect(mesh.position).toEqual(position);
      expect(mesh.matrix.toArray()).toEqual(matrix);
      if (mesh instanceof THREE.InstancedMesh) expect(Array.from(mesh.instanceMatrix.array)).toEqual(instanceMatrix);
    });
    expect(materialOf(group, "pcb-pads-top").alphaMap).toBe(topTexture);
    expect(materialOf(group, "metal-stencil").alphaMap).toBe(steelTexture);
    expect(vi.mocked(createPadTexture).mock.calls).toHaveLength(drawCount);
    expect(vi.mocked(createStencilTexture).mock.calls).toHaveLength(steelDrawCount);
    expect(group.getObjectByName("pcb")!.visible).toBe(false);
    expect(group.getObjectByName("metal-stencil")!.visible).toBe(true);
    disposal.forEach(spy => expect(spy).not.toHaveBeenCalled());
    recolorJigAssembly(group, getModelPalette("classic"));
    expect(assemblyColors(group)).toEqual(originalColors);
    expect(materialOf(group, "cover").roughness).toBe(0.65);
    setJigExplosion(group, 0);
    expect(group.getObjectByName("cover")!.position.y).toBeCloseTo(8.2);
    disposeJigAssembly(group);
    disposal.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    Object.values(parts).forEach(geometry => geometry.dispose());
  });

  it("recolours a standalone PCB while retaining the matte mask, pad textures and environment settings", () => {
    const environmentMap = new THREE.Texture();
    const pcb = buildPcbPreview({ outline, thickness: 1.6, topPads: pads, bottomPads: pads, environmentMap });
    const geometry = pcb.geometry;
    const mask = pcb.material[0];
    const top = materialOf(pcb, "pcb-pads-top");
    const bottom = materialOf(pcb, "pcb-pads-bottom");
    const textures = [top.alphaMap, bottom.alphaMap];
    expect(mask.color.getHex()).toBe(0x397fbb);
    recolorPcbPreview(pcb, getModelPalette("sakura"));
    expect(pcb.geometry).toBe(geometry);
    expect(pcb.material[0]).toBe(mask);
    expect(mask).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(mask.color.getHex()).toBe(0x3e5fa4);
    expect([top.alphaMap, bottom.alphaMap]).toEqual(textures);
    expect(top.envMap).toBe(environmentMap);
    expect(top.envMapIntensity).toBe(0.8);
    expect(top.roughness).toBe(0.3);
    expect(top.metalness).toBe(0.6);
    expect(createPadTexture).toHaveBeenCalledTimes(2);
    const holder = new THREE.Group();
    holder.add(pcb);
    disposeJigAssembly(holder);
    environmentMap.dispose();
  });
});
