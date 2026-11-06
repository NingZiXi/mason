import * as THREE from "three";
import type { PadPolygon } from "./gerber/pads";
import { createPadTexture } from "./gerber-pad-texture";

type Ring = readonly (readonly [number, number])[];
interface PcbPreviewOptions {
  outline: Ring;
  holes?: readonly Ring[];
  thickness: number;
  topPads?: readonly PadPolygon[];
  bottomPads?: readonly PadPolygon[];
  environmentMap?: THREE.Texture | null;
}

/** Real board outline and paste pads; no fabricated traces or silkscreen. */
export function buildPcbPreview(options: PcbPreviewOptions) {
  const points = options.outline.map(([x, y]) => new THREE.Vector2(x, y));
  const shape = new THREE.Shape(points);
  shape.holes = (options.holes ?? []).filter(ring => ring.length >= 3)
    .map(ring => new THREE.Path(ring.map(([x, y]) => new THREE.Vector2(x, y))));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: options.thickness, bevelEnabled: false, steps: 1 });
  geometry.rotateX(-Math.PI / 2);
  const solderMask = new THREE.MeshLambertMaterial({ color: 0x397fbb });
  const substrate = new THREE.MeshStandardMaterial({ color: 0x99815a, roughness: 0.78, metalness: 0 });
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
      color: 0xc9af70, roughness: 0.3, metalness: 0.6,
      envMap: options.environmentMap ?? null, envMapIntensity: 0.8,
      alphaMap: texture, alphaTest: 0.5, side: THREE.DoubleSide,
    }));
    mesh.name = top ? "pcb-pads-top" : "pcb-pads-bottom";
    mesh.position.set(center.x, top ? options.thickness + 0.012 : -0.012, -center.y);
    pcb.add(mesh);
  };
  if (options.topPads?.length) addPads(options.topPads, true);
  if (options.bottomPads?.length) addPads(options.bottomPads, false);
  return pcb;
}
