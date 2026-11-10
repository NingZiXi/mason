import * as THREE from "three";
import type { PadPolygon } from "./gerber/pads";
import { createPadTexture } from "./gerber-pad-texture";
import { getModelPalette, type ModelPalette } from "./model-palette";

type Ring = readonly (readonly [number, number])[];
export interface PcbPreviewOptions {
  outline: Ring;
  holes?: readonly Ring[];
  thickness: number;
  topPads?: readonly PadPolygon[];
  bottomPads?: readonly PadPolygon[];
  environmentMap?: THREE.Texture | null;
  palette?: ModelPalette;
}

/** Keep Gerber geometry and raster masks intact when the skin changes. */
export function recolorPcbPreview(mesh: THREE.Mesh, palette: ModelPalette) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (materials[0] instanceof THREE.MeshLambertMaterial) materials[0].color.setHex(palette.pcb);
  if (materials[1] instanceof THREE.MeshStandardMaterial) materials[1].color.setHex(palette.substrate);
  for (const child of mesh.children) {
    if (!(child instanceof THREE.Mesh) || !["pcb-pads-top", "pcb-pads-bottom"].includes(child.name)) continue;
    const padsMaterials = Array.isArray(child.material) ? child.material : [child.material];
    padsMaterials.forEach(material => {
      if (material instanceof THREE.MeshStandardMaterial) material.color.setHex(palette.pads);
    });
  }
}

/** Real board outline and paste pads; no fabricated traces or silkscreen. */
export function buildPcbPreview(options: PcbPreviewOptions) {
  const palette = options.palette ?? getModelPalette("classic");
  const points = options.outline.map(([x, y]) => new THREE.Vector2(x, y));
  const shape = new THREE.Shape(points);
  shape.holes = (options.holes ?? []).filter(ring => ring.length >= 3)
    .map(ring => new THREE.Path(ring.map(([x, y]) => new THREE.Vector2(x, y))));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: options.thickness, bevelEnabled: false, steps: 1 });
  geometry.rotateX(-Math.PI / 2);
  const solderMask = new THREE.MeshLambertMaterial({ color: palette.pcb });
  const substrate = new THREE.MeshStandardMaterial({ color: palette.substrate, roughness: 0.78, metalness: 0 });
  // ExtrudeGeometry group 0 = flat faces, group 1 = perimeter and hole walls.
  const pcb = new THREE.Mesh(geometry, [solderMask, substrate]);
  pcb.name = "pcb";
  const bounds = new THREE.Box2().setFromPoints(points);
  const size = bounds.getSize(new THREE.Vector2());
  const center = bounds.getCenter(new THREE.Vector2());
  const addPads = (pads: readonly PadPolygon[], top: boolean) => {
    const texture = createPadTexture(size.x, size.y, pads, center.x, center.y, options.outline, options.holes);
    if (!texture) return;
    const geometry = new THREE.PlaneGeometry(size.x, size.y);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: palette.pads, roughness: 0.3, metalness: 0.6,
      envMap: options.environmentMap ?? null, envMapIntensity: 0.8,
      alphaMap: texture, alphaTest: 0.5, side: THREE.DoubleSide,
    }));
    mesh.name = top ? "pcb-pads-top" : "pcb-pads-bottom";
    mesh.position.set(center.x, top ? options.thickness + 0.012 : -0.012, -center.y);
    pcb.add(mesh);
  };
  if (options.topPads?.length) addPads(options.topPads, true);
  if (options.bottomPads?.length) addPads(options.bottomPads, false);
  recolorPcbPreview(pcb, palette);
  return pcb;
}
