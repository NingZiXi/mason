export interface ModelPalette {
  parts: Record<"insert" | "base" | "cover" | "stencil_top" | "stencil_bottom", number>;
  assembly: number;
  pcb: number;
  substrate: number;
  pads: number;
  metalStencil: number;
  hardware: number;
  socket: number;
  nut: number;
  plastic: { metalness: number; roughness: number };
  measurement: { direct: number; horizontal: number; vertical: number };
  selection: { a: number; b: number };
}

const CLASSIC: ModelPalette = {
  parts: { insert: 0x5a9b7f, base: 0x4c6f94, cover: 0xd9913d, stencil_top: 0xd9913d, stencil_bottom: 0x4c6f94 },
  assembly: 0x929daf,
  pcb: 0x397fbb,
  substrate: 0x99815a,
  pads: 0xc9af70,
  metalStencil: 0xc5ced2,
  hardware: 0xb5bdc8,
  socket: 0x27303a,
  nut: 0xc5cbd1,
  // Preserve the original assembly material. Standalone classic parts use 0.7.
  plastic: { metalness: 0.1, roughness: 0.65 },
  measurement: { direct: 0x15a877, horizontal: 0xd9913d, vertical: 0x4c6f94 },
  selection: { a: 0xe07a3c, b: 0x4c8fd6 },
};

const SAKURA: ModelPalette = {
  parts: { insert: 0xf3d9e4, base: 0x8ca8e0, cover: 0xe49ab5, stencil_top: 0xe49ab5, stencil_bottom: 0x8ca8e0 },
  assembly: 0x8c97a0,
  pcb: 0x3e5fa4,
  substrate: 0xb49b7b,
  pads: 0xdcc6a4,
  metalStencil: 0xc5ced2,
  hardware: 0x58616c,
  socket: 0x29313a,
  nut: 0x58616c,
  plastic: { metalness: 0.05, roughness: 0.72 },
  measurement: { direct: 0xb63f70, horizontal: 0x4169d8, vertical: 0x78658b },
  selection: { a: 0xb63f70, b: 0x4169d8 },
};

/** Model colours remain independent of the light / dark UI preference. */
export function getModelPalette(skin: "classic" | "sakura"): ModelPalette {
  return skin === "sakura" ? SAKURA : CLASSIC;
}
