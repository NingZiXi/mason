import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import * as padTextures from '../gerber-pad-texture';
import type { PadPolygon } from '../gerber/pads';
import { animateJigVisibility, buildJigAssembly, disposeJigAssembly, inheritJigVisibility, setJigExplosion,
  setJigPartsOpacity, setJigVisibility, setJigReliefInspection, stepJigVisibility, ASSEMBLY_STENCIL_THICKNESS,
  type AssemblyOptions } from "../jig-assembly";

const options: AssemblyOptions = {
  insertHeight: 8, baseHeight: 4, topCoverHeight: 4, screwSpec: "M3",
  useHexNut: true, nutAcrossFlats: 5.5, nutHeight: 2.4,
  screwPositions: [[0, 65], [0, -65], [65, 0], [-65, 0]],
};
function fixture() {
  const slab = (height: number) => new THREE.BoxGeometry(150, height, 150).translate(0, height / 2, 0);
  return { insert: slab(8), base: slab(4), cover: slab(4) };
}
const bounds = (group: THREE.Group, name: string) => new THREE.Box3().setFromObject(group.getObjectByName(name)!);

describe("jig assembly", () => {
  it('uses the selected printing face without substituting the opposite face, and mirrors bottom apertures', () => {
    const bottomPads: PadPolygon[] = [{ type: 'rect', cx: 3, cy: 7, polarity: 'D',
      parts: [{ polarity: 'D', points: [[2, 6], [4, 6], [4, 8], [2, 8]] }] }];
    const texture = vi.spyOn(padTextures, 'createStencilTexture').mockReturnValue(null);
    try {
      const top = buildJigAssembly(fixture(), { ...options, jigPrintSide: 'top',
        stencilSizeX: 100, stencilSizeY: 100, stencilPadsTop: [], stencilPadsBottom: bottomPads });
      expect(texture).toHaveBeenLastCalledWith(100, 100, []);
      disposeJigAssembly(top);
      const bottom = buildJigAssembly(fixture(), { ...options, jigPrintSide: 'bottom',
        stencilSizeX: 100, stencilSizeY: 100, stencilPadsBottom: bottomPads });
      const maskPads = texture.mock.calls[texture.mock.calls.length - 1][2];
      expect(maskPads[0].cy).toBe(-7);
      expect(maskPads[0].parts[0].points[0]).toEqual([2, -6]);
      expect(bottomPads[0].cy).toBe(7);
      disposeJigAssembly(bottom);
    } finally { texture.mockRestore(); }
  });
  it('flips an asymmetric PCB for bottom printing and preserves the common printing plane', () => {
    const group = buildJigAssembly(fixture(), { ...options, insertHeight: 12.8, jigPrintSide: 'bottom', pcbThickness: 1.6,
      pcbOutlinePoints: [[0, 0], [20, 0], [0, 12]] });
    const pcb = group.getObjectByName('pcb') as THREE.Mesh;
    expect(bounds(group, 'pcb').max.y).toBeCloseTo(12.8, 5);
    expect(bounds(group, 'pcb').min.y).toBeCloseTo(11.2, 5);
    expect(bounds(group, 'pcb').min.z).toBeCloseTo(0, 5);
    expect(bounds(group, 'pcb').max.z).toBeCloseTo(12, 5);
    expect(bounds(group, 'base').max.y).toBeCloseTo(12.8, 5);
    const ray = new THREE.Raycaster(new THREE.Vector3(2, 30, 2), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(pcb).length).toBeGreaterThan(0);
    setJigReliefInspection(group, true);
    const baseMaterial = (group.getObjectByName('base') as THREE.Mesh).material as THREE.Material;
    expect(baseMaterial.opacity).toBeCloseTo(.18);
    expect(baseMaterial.depthWrite).toBe(false);
    expect(((group.getObjectByName('insert') as THREE.Mesh).material as THREE.Material).opacity).toBe(1);
    setJigVisibility(group, false, false);
    setJigReliefInspection(group, false);
    expect(pcb.visible).toBe(false);
    expect(baseMaterial.opacity).toBe(1);
    expect(baseMaterial.depthWrite).toBe(true);
    disposeJigAssembly(group);
  });
  it("explodes vertically without moving the tray or misaligning hardware and restores exactly", () => {
    const group = buildJigAssembly(fixture(), options);
    const originals = group.children.map(object => object.position.clone());
    const shaft = group.getObjectByName("screw-shafts") as THREE.InstancedMesh;
    const matrices = Array.from(shaft.instanceMatrix.array);
    setJigExplosion(group, 1);
    expect(group.getObjectByName("insert")!.position.y).toBe(0);
    expect(bounds(group, "base").min.y).toBeGreaterThan(bounds(group, "insert").max.y);
    expect(bounds(group, "cover").min.y).toBeGreaterThan(bounds(group, "base").max.y);
    expect(bounds(group, "screw-shafts").min.y).toBeGreaterThan(bounds(group, "cover").max.y);
    const fullHeight = bounds(group, "cover").min.y;
    for (const amount of [0.4, 0.8, 0.1, 1, 0.5]) setJigExplosion(group, amount);
    expect(bounds(group, "cover").min.y).toBeCloseTo(8 + (fullHeight - 8) / 2);
    expect(Array.from(shaft.instanceMatrix.array)).toEqual(matrices);
    setJigExplosion(group, 0);
    group.children.forEach((object, index) => expect(object.position).toEqual(originals[index]));
    setJigExplosion(group, -1);
    expect(bounds(group, "cover").min.y).toBeCloseTo(8);
    setJigExplosion(group, 2);
    expect(bounds(group, "cover").min.y).toBeCloseTo(fullHeight);
    disposeJigAssembly(group);
  });

  it("stacks actual parts at a common interface without changing cached STL coordinates", () => {
    const parts = fixture();
    const original = Array.from(parts.base.getAttribute("position").array);
    const group = buildJigAssembly(parts, options);
    expect(bounds(group, "insert").min.y).toBe(0);
    expect(bounds(group, "base").min.y).toBeCloseTo(4);
    expect(bounds(group, "base").max.y).toBeCloseTo(8);
    expect(bounds(group, "cover").min.y).toBeCloseTo(8);
    expect(bounds(group, "cover").max.y).toBeCloseTo(12);
    expect(Array.from(parts.base.getAttribute("position").array)).toEqual(original);
    const normal = new THREE.Vector3(0, 1, 0).transformDirection(group.getObjectByName("base")!.matrixWorld);
    // STL Y=0 is the underside with nut recesses. Its outward normal must
    // still face downward in the assembly, rather than being flipped upward.
    expect(normal.y).toBeCloseTo(1);
    const underside = new THREE.Vector3(0, -1, 0).transformDirection(group.getObjectByName("base")!.matrixWorld);
    expect(underside.y).toBeCloseTo(-1);
    expect(bounds(group, "nuts").min.y).toBeCloseTo(bounds(group, "base").min.y, 5);
    expect(bounds(group, "nuts").max.y).toBeLessThan(bounds(group, "base").max.y);
    disposeJigAssembly(group);
  });

  it.each([4, 12])("reveals hollow nuts below the exploded base of height %s and seats them again", (baseHeight) => {
    const parts = fixture();
    parts.base.dispose();
    parts.base = new THREE.BoxGeometry(150, baseHeight, 150).translate(0, baseHeight / 2, 0);
    const group = buildJigAssembly(parts, { ...options, baseHeight, insertHeight: baseHeight + 4 });
    const nuts = group.getObjectByName("nuts") as THREE.InstancedMesh;
    expect(nuts.count).toBe(options.screwPositions.length);
    const seated = bounds(group, "nuts").clone();
    setJigExplosion(group, 1);
    expect(bounds(group, "nuts").min.y).toBeGreaterThan(bounds(group, "insert").max.y);
    expect(bounds(group, "nuts").max.y).toBeLessThan(bounds(group, "base").min.y);
    const nutTop = bounds(group, "nuts").max.y;
    const [x, y] = options.screwPositions[0];
    const ray = new THREE.Raycaster(new THREE.Vector3(x, nutTop + 1, -y), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(nuts)).toHaveLength(0); // The center is a real hole.
    ray.set(new THREE.Vector3(x + 2.2, nutTop + 1, -y), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(nuts).length).toBeGreaterThan(0); // Metal surrounds the bore.
    setJigExplosion(group, 0);
    expect(bounds(group, "nuts").min.y).toBeCloseTo(seated.min.y, 5);
    expect(bounds(group, "nuts").max.y).toBeCloseTo(seated.max.y, 5);
    disposeJigAssembly(group);
    Object.values(parts).forEach(geometry => geometry.dispose());
  });

  it("uses only configured perimeter screws, maps board Y to -Z, and stops above the tray", () => {
    const group = buildJigAssembly(fixture(), { ...options, insertHeight: 12, baseHeight: 5, topCoverHeight: 3, screwSpec: "M4" });
    const shafts = group.getObjectByName("screw-shafts") as THREE.InstancedMesh;
    expect(shafts.count).toBe(4);
    const matrix = new THREE.Matrix4();
    shafts.getMatrixAt(0, matrix);
    expect(matrix.elements[12]).toBe(0);
    expect(matrix.elements[14]).toBe(-65);
    expect(bounds(group, "screw-shafts").min.y).toBeCloseTo(7.2, 4);
    expect(bounds(group, "screw-shafts").max.y).toBeCloseTo(15, 4);
    expect(bounds(group, "screw-heads").min.y).toBeCloseTo(15, 4);
    disposeJigAssembly(group);
  });

  it("releases owned resources once while retaining originals across refreshes", () => {
    const parts = fixture();
    const originals = Object.values(parts).map(geometry => vi.spyOn(geometry, "dispose"));
    const group = buildJigAssembly(parts, options);
    const clone = group.getObjectByName("base") as THREE.Mesh;
    const disposeClone = vi.spyOn(clone.geometry, "dispose");
    const shafts = group.getObjectByName("screw-shafts") as THREE.Mesh;
    const disposeMetal = vi.spyOn(shafts.material as THREE.Material, "dispose");
    disposeJigAssembly(group);
    expect(disposeClone).toHaveBeenCalledTimes(1);
    expect(disposeMetal).toHaveBeenCalledTimes(1);
    originals.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });

  it("seats the imported PCB in its pocket and the metal sheet between base and cover", () => {
    const group = buildJigAssembly(fixture(), {
      ...options, pcbThickness: 1.6,
      pcbOutlinePoints: [[-30, -20], [30, -20], [30, 20], [-30, 20]],
      pcbOutlineHoles: [[[-3, -3], [3, -3], [3, 3], [-3, 3]]],
      stencilSizeX: 100, stencilSizeY: 90,
    });
    const pcb = group.getObjectByName("pcb") as THREE.Mesh;
    const sheet = group.getObjectByName("metal-stencil") as THREE.Mesh;
    expect(bounds(group, "pcb").max.y).toBeCloseTo(8, 5);
    expect(bounds(group, "pcb").min.y).toBeCloseTo(6.4, 5);
    expect(bounds(group, "metal-stencil").max.y).toBeCloseTo(8 + ASSEMBLY_STENCIL_THICKNESS / 2);
    expect(bounds(group, "cover").min.y).toBeCloseTo(8 + ASSEMBLY_STENCIL_THICKNESS);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(pcb)).toHaveLength(0); // Imported hole remains open.
    ray.set(new THREE.Vector3(10, 20, 0), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(pcb).length).toBeGreaterThan(0);
    setJigVisibility(group, false, true);
    setJigExplosion(group, 1);
    expect(pcb.visible).toBe(false);
    expect(sheet.visible).toBe(true);
    expect(bounds(group, "metal-stencil").min.y).toBeGreaterThan(bounds(group, "base").max.y);
    expect(bounds(group, "cover").min.y).toBeGreaterThan(bounds(group, "metal-stencil").max.y);
    setJigVisibility(group, true, false);
    setJigExplosion(group, 0);
    expect(pcb.visible).toBe(true);
    expect(sheet.visible).toBe(false);
    expect(bounds(group, "pcb").max.y).toBeCloseTo(8, 5);
    disposeJigAssembly(group);
  });

  it("fades each requested layer independently and reverses from its last visible amount", () => {
    const group = buildJigAssembly(fixture(), {
      ...options, pcbOutlinePoints: [[-30, -20], [30, -20], [30, 20], [-30, 20]],
      stencilSizeX: 100, stencilSizeY: 90,
    });
    const pcb = group.getObjectByName("pcb") as THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>;
    const sheet = group.getObjectByName("metal-stencil") as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
    expect(animateJigVisibility(group, true, true, 0)).toBe(false);
    expect(animateJigVisibility(group, false, true, 10)).toBe(true);
    expect(stepJigVisibility(group, 70)).toBe(true);
    expect(pcb.visible).toBe(true);
    const opacity = pcb.material[0].opacity;
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
    expect(pcb.material[1]).toMatchObject({ opacity, transparent: true, depthWrite: false });
    expect(sheet.material).toMatchObject({ opacity: 1, transparent: false, depthWrite: true });

    expect(animateJigVisibility(group, true, false, 75)).toBe(true);
    expect(stepJigVisibility(group, 75)).toBe(true);
    expect(pcb.material[0].opacity).toBe(opacity);
    expect(stepJigVisibility(group, 110)).toBe(true);
    expect(pcb.material[0].opacity).toBeGreaterThan(opacity);
    expect(sheet.material.opacity).toBeLessThan(1);
    expect(stepJigVisibility(group, 300)).toBe(false);
    expect(pcb.visible).toBe(true);
    expect(sheet.visible).toBe(false);
    for (const material of [...pcb.material, sheet.material]) {
      expect(material).toMatchObject({ opacity: 1, transparent: false, depthWrite: true });
    }

    expect(animateJigVisibility(group, true, true, 350)).toBe(true);
    expect(sheet.visible).toBe(false);
    expect(stepJigVisibility(group, 405)).toBe(true);
    expect(sheet.visible).toBe(true);
    expect(sheet.material.opacity).toBeGreaterThan(0);
    expect(sheet.material.opacity).toBeLessThan(1);
    setJigVisibility(group, true, false);
    expect(sheet.visible).toBe(false);
    expect(sheet.material).toMatchObject({ opacity: 1, transparent: false, depthWrite: true });
    expect(stepJigVisibility(group, 500)).toBe(false);
    disposeJigAssembly(group);
  });

  it("carries the existing fade and hidden state onto a new assembly", () => {
    const layerOptions = { ...options, pcbOutlinePoints: [[-30, -20], [30, -20], [30, 20], [-30, 20]] as const,
      stencilSizeX: 100, stencilSizeY: 90 };
    const parts = fixture();
    const previous = buildJigAssembly(parts, { ...layerOptions, stencilSizeX: undefined });
    const current = buildJigAssembly(parts, layerOptions);
    try {
      animateJigVisibility(previous, false, false, 10);
      expect(stepJigVisibility(previous, 70)).toBe(true);
      const materials = (group: THREE.Group) => (group.getObjectByName("pcb") as
        THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>).material;
      const faded = materials(previous)[0].opacity;
      expect(inheritJigVisibility(current, previous)).toBe(true);
      expect(current.getObjectByName("pcb")!.visible).toBe(true);
      expect(current.getObjectByName("metal-stencil")!.visible).toBe(false);
      expect(materials(current)[0].opacity).toBe(faded);
      expect(stepJigVisibility(current, 100)).toBe(true);
      expect(materials(current)[0].opacity).toBeLessThan(faded);
      expect(materials(previous)[0].opacity).toBe(faded);
      expect(stepJigVisibility(current, 200)).toBe(false);
      expect(current.getObjectByName("pcb")!.visible).toBe(false);
      expect(materials(current)[0].opacity).toBe(1);
    } finally {
      disposeJigAssembly(previous);
      disposeJigAssembly(current);
      Object.values(parts).forEach(geometry => geometry.dispose());
    }
  });

  it("preserves pad and stencil cutoff, original flags, and relief while fading", () => {
    const pads: PadPolygon[] = [{ type: "rect", cx: 0, cy: 0, polarity: "D",
      parts: [{ polarity: "D", points: [[-1, -1], [1, -1], [1, 1], [-1, 1]] }] }];
    const padMask = new THREE.CanvasTexture();
    const sheetMask = new THREE.CanvasTexture();
    const padTexture = vi.spyOn(padTextures, "createPadTexture").mockReturnValue(padMask);
    const stencilTexture = vi.spyOn(padTextures, "createStencilTexture").mockReturnValue(sheetMask);
    const group = buildJigAssembly(fixture(), {
      ...options, pcbOutlinePoints: [[-30, -20], [30, -20], [30, 20], [-30, 20]],
      stencilSizeX: 100, stencilSizeY: 90, stencilPadsTop: pads,
    });
    try {
      const pad = (group.getObjectByName("pcb-pads-top") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material;
      const sheet = (group.getObjectByName("metal-stencil") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material;
      const materialOf = (name: string) => (group.getObjectByName(name) as
        THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material;
      const tray = materialOf("insert");
      const base = materialOf("base");
      const cover = materialOf("cover");
      const hardware = materialOf("screw-heads");
      pad.opacity = 0.9;
      pad.transparent = true;
      pad.depthWrite = false;
      setJigExplosion(group, 0.5);
      const pose = group.children.map(object => object.position.y);
      animateJigVisibility(group, false, false, 0);
      expect(stepJigVisibility(group, 60)).toBe(true);
      const layerAmount = sheet.opacity;
      expect(pad.opacity).toBeCloseTo(0.9 * layerAmount);
      expect(pad.alphaTest).toBeCloseTo(0.5 * layerAmount);
      expect(sheet.alphaTest).toBeCloseTo(0.5 * layerAmount);
      expect(pad.alphaMap).toBe(padMask);
      expect(sheet.alphaMap).toBe(sheetMask);

      setJigPartsOpacity(group, ["insert", "base"], 0.86);
      expect(tray).toMatchObject({ opacity: 0.86, transparent: true, depthWrite: true });
      expect(base).toMatchObject({ opacity: 0.86, transparent: true, depthWrite: true });
      expect(cover.opacity).toBe(1);
      expect(hardware.opacity).toBe(1);
      expect(sheet.opacity).toBe(layerAmount);

      setJigReliefInspection(group, true);
      expect(pad.opacity).toBeCloseTo(0.9 * 0.18 * layerAmount);
      expect(sheet.alphaTest).toBeCloseTo(0.5 * 0.18 * layerAmount);
      expect(tray.opacity).toBe(0.86);
      expect(base.opacity).toBeCloseTo(0.86 * 0.18);
      expect(base.depthWrite).toBe(false);
      expect(cover.opacity).toBeCloseTo(0.18);
      expect(hardware.opacity).toBeCloseTo(0.18);
      setJigPartsOpacity(group, ["base"], 1);
      expect(base.opacity).toBeCloseTo(0.18);
      expect(tray.opacity).toBe(0.86);

      expect(stepJigVisibility(group, 200)).toBe(false);
      expect(group.getObjectByName("pcb")!.visible).toBe(false);
      expect(group.getObjectByName("metal-stencil")!.visible).toBe(false);
      setJigPartsOpacity(group, ["insert"], 1);
      expect(tray).toMatchObject({ opacity: 1, transparent: false, depthWrite: true });
      expect(pad.opacity).toBeCloseTo(0.9 * 0.18);
      expect(sheet.alphaTest).toBeCloseTo(0.5 * 0.18);
      setJigReliefInspection(group, false);
      expect(pad).toMatchObject({ opacity: 0.9, alphaTest: 0.5, transparent: true, depthWrite: false });
      expect(sheet).toMatchObject({ opacity: 1, alphaTest: 0.5, transparent: false, depthWrite: true });
      expect(group.children.map(object => object.position.y)).toEqual(pose);
    } finally {
      disposeJigAssembly(group);
      padTexture.mockRestore();
      stencilTexture.mockRestore();
    }
  });

  it("omits hardware when perimeter screws are disabled and nuts for self-tapping screws", () => {
    const noScrews = buildJigAssembly(fixture(), { ...options, screwPositions: [] });
    expect(noScrews.children.map(child => child.name)).toEqual(["insert", "base", "cover"]);
    disposeJigAssembly(noScrews);
    const selfTapping = buildJigAssembly(fixture(), { ...options, useHexNut: false });
    expect(selfTapping.getObjectByName("nuts")).toBeUndefined();
    disposeJigAssembly(selfTapping);
  });
});
