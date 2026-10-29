import type { AppConfig } from "../stores/config";
import type { PadPolygon } from "./gerber/pads";

// Image polarity applies to the whole pad; part polarity and holes apply inside it.
const enginePads = (pads: PadPolygon[]) => pads.map(({ polarity, parts }) => ({ polarity, parts }));

// 计算当前参数的 hash(用于判断是否需要重新生成)
export function modelParamsHash(c: AppConfig) {
  // 只 hash 跟几何相关的参数(避免无关改动触发重渲染)
  // pcbOutlinePoints 用完整点列表:同点数的异形板框也要正确失效
  // mode 必须入 hash:钢网/治具模式下同一钢网尺寸生成不同外框
  return JSON.stringify({
    mode: c.appMode,
    pcb: [c.pcbSizeX, c.pcbSizeY, c.pcbThickness, c.pcbPocketClearance, c.pcbOutlinePoints, c.pcbOutlineHoles, c.stencilSizeX, c.stencilSizeY],
    screw: [c.screwSpacing, c.screwSpec, c.useHexNut, c.nutAcrossFlats, c.nutHeight],
    dims: [c.baseHeight, c.topCoverHeight, c.jigSize, c.insertHeight, c.platterHeight, c.platterCornerRadius, c.ejectSlotWidth, c.cornerScrewD, c.postClearance, c.periScrewD, c.outerCornerRadius, c.stencilLip, c.windowGap],
    notch: [c.pryNotchSides, c.pryNotchScale],
    stencil: [c.stencilThickness, c.padShrink, c.stencilFrameWidth, c.stencilCornerRadius, c.stencilFrameShape, c.pocketClearance,
      c.stencilTaper, c.stencilStagger, c.stencilStaggerGap, c.stencilStaggerOffset,
      c.stencilFilterTestPoints, c.stencilTestPointMaxDia, c.stencilTestPointIsolation,
      c.stencilGrid, c.stencilGridSize, c.stencilGridBar,
      enginePads(c.stencilPadsTop), enginePads(c.stencilPadsBottom)],
  });
}
export function buildScadParams(c: AppConfig) {
  return {
    pcb_size_x: c.pcbSizeX,
    pcb_size_y: c.pcbSizeY,
    pcb_thickness: c.pcbThickness,
    pcb_pocket_clearance: c.pcbPocketClearance,
    pcb_outline_points: c.pcbOutlinePoints,
    pcb_outline_holes: c.pcbOutlineHoles,
    // 治具模式:钢网外缘由 X/Y 两轴给定(可为矩形),凸台/窗口逐轴推导;
    // 钢网模式:独立钢网外框由 板框+边框宽/外框形状 推导,两轴置 0
    // (compute_frame_poly 里 stencil_size_x/y > 0 会短路,忽略 frame_shape/frame_width)
    stencil_size_x: c.appMode === "stencil" ? 0 : c.stencilSizeX,
    stencil_size_y: c.appMode === "stencil" ? 0 : c.stencilSizeY,
    screw_spacing: c.screwSpacing,
    screw_spec: c.screwSpec,
    base_height: c.baseHeight,
    top_cover_height: c.topCoverHeight,
    jig_size: c.jigSize,
    insert_height: c.insertHeight,
    platter_height: c.platterHeight,
    stencil_lip: c.stencilLip,
    window_gap: c.windowGap,
    platter_corner_radius: c.platterCornerRadius,
    eject_slot_width: c.ejectSlotWidth,
    pry_notch_sides: c.pryNotchSides,
    pry_notch_scale: c.pryNotchScale,
    corner_screw_d: c.cornerScrewD,
    post_clearance: c.postClearance,
    peri_screw_d: c.periScrewD,
    outer_corner_radius: c.outerCornerRadius,
    use_hex_nut: c.useHexNut,
    nut_across_flats: c.nutAcrossFlats,
    nut_height: c.nutHeight,
    // PCB 钢网(一体式)参数
    stencil_thickness: c.stencilThickness,
    pad_shrink: c.padShrink,
    stencil_frame_width: c.stencilFrameWidth,
    stencil_corner_radius: c.stencilCornerRadius,
    stencil_frame_shape: c.stencilFrameShape,
    pocket_clearance: c.pocketClearance,
    stencil_taper: c.stencilTaper,
    stencil_stagger: c.stencilStagger,
    stencil_stagger_gap: c.stencilStaggerGap,
    stencil_stagger_offset: c.stencilStaggerOffset,
    stencil_filter_test_points: c.stencilFilterTestPoints,
    stencil_test_point_max_dia: c.stencilTestPointMaxDia,
    stencil_test_point_isolation: c.stencilTestPointIsolation,
    stencil_grid: c.stencilGrid,
    stencil_grid_size: c.stencilGridSize,
    stencil_grid_bar: c.stencilGridBar,
    stencil_pads_top: enginePads(c.stencilPadsTop),
    stencil_pads_bottom: enginePads(c.stencilPadsBottom),
  };
}
