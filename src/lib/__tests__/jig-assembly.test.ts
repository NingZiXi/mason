import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import * as padTextures from '../gerber-pad-texture';
import type { PadPolygon } from '../gerber/pads';
import { buildJigAssembly, disposeJigAssembly, setJigExplosion, setJigVisibility, setJigReliefInspection, ASSEMBLY_STENCIL_THICKNESS, type AssemblyOptions } from "../jig-assembly";

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

  it("omits hardware when perimeter screws are disabled and nuts for self-tapping screws", () => {
    const noScrews = buildJigAssembly(fixture(), { ...options, screwPositions: [] });
    expect(noScrews.children.map(child => child.name)).toEqual(["insert", "base", "cover"]);
    disposeJigAssembly(noScrews);
    const selfTapping = buildJigAssembly(fixture(), { ...options, useHexNut: false });
    expect(selfTapping.getObjectByName("nuts")).toBeUndefined();
    disposeJigAssembly(selfTapping);
  });
});
