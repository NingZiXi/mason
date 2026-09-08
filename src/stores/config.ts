/**
 * PCB 钢网夹具 - 全局配置 store(v2 结构)
 *
 * 单一状态源,所有参数都从这里读写,组件只读 + 调用 actions。
 * 与 Rust 后端的 ScadParams 结构对齐。
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { PadPolygon } from "../lib/gerber/pads";

export type AppMode = "jig" | "stencil";

export interface AppConfig {
  // 工作模式
  appMode: AppMode;

  // PCB 参数
  pcbSizeX: number;
  pcbSizeY: number;
  pcbThickness: number;

  // 钢网参数(夹具模式用:展示用;窗口由凸台推导)
  stencilSize: number;

  // PCB 钢网(一体式)参数
  /** 槽底钢网层厚度(mm,默认 0.3 / FDM) */
  stencilThickness: number;
  /** 焊盘开孔缩小百分比(0~50,默认 10) */
  padShrink: number;
  /** 钢网边框宽(PCB 到外框边缘,mm,默认 8) */
  stencilFrameWidth: number;
  /** 钢网外框圆角半径(mm,默认 3) */
  stencilCornerRadius: number;
  /** 钢网外框形状:outline=跟随板形 / rect=矩形 */
  stencilFrameShape: "outline" | "rect";
  /** PCB 卡槽间隙(PCB 到卡槽壁单边,mm,默认 0.2) */
  pocketClearance: number;
  /** 喇叭孔:刮刀面开孔放大百分比(100~115,100 = 关闭,默认 105) */
  stencilTaper: number;
  /** 密脚错排开关(相邻密脚焊盘隔位错开,减少连锡) */
  stencilStagger: boolean;
  /** 密脚判定阈值:焊盘中心间距小于该值(mm)视为密脚链 */
  stencilStaggerGap: number;
  /** 密脚错排偏移量(mm) */
  stencilStaggerOffset: number;
  /** 测试点过滤开关:小圆形孤立焊盘(测试探针点)不开锡膏孔 */
  stencilFilterTestPoints: boolean;
  /** 测试点最大直径(mm):超过该值的圆焊盘不视为测试点 */
  stencilTestPointMaxDia: number;
  /** 测试点孤立距离(mm):该范围内有其他焊盘则不视为测试点 */
  stencilTestPointIsolation: number;
  /** 大孔开网格开关(大开口加十字网格条) */
  stencilGrid: boolean;
  /** 网格阈值:单边大于该值(mm)的开孔加网格 */
  stencilGridSize: number;
  /** 网格条宽(mm) */
  stencilGridBar: number;
  /** 顶层(Top Paste)焊盘多边形列表(锡膏层解析结果) */
  stencilPadsTop: PadPolygon[];
  /** 底层(Bottom Paste)焊盘多边形列表(锡膏层解析结果) */
  stencilPadsBottom: PadPolygon[];

  // 螺丝布局
  /** 周圈螺丝间距(B 面配置;0 = 关闭周圈孔) */
  screwSpacing: number;
  /** 周圈螺丝规格(机丝 GB/T 5277,GB/T 6170 六角螺母);切换后
   *  自动套用标准孔径/螺母对边/螺母厚度;4 角固定 M5 不联动 */
  screwSpec: "M2.5" | "M3" | "M3.5" | "M4" | "M5";

  // 几何细节 (高级用户可调)
  baseHeight: number;
  topCoverHeight: number;
  pcbPocketClearance: number;
  /** PCB 插板总厚(默认 8mm,参考设计) */
  insertHeight: number;
  /** 凸台高度(其余为底板) —— 由 baseHeight 自动同步,字段保留作项目兼容 */
  platterHeight: number;
  /** 凸台台阶宽(槽到凸台外缘) —— 派生值 = max(stencilLip, frame_half - slot_half)
   * 由 stencilLip 接管,字段保留仅用于项目文件兼容 */
  platterMargin: number;
  /** 矩形板凸台圆角半径 */
  platterCornerRadius: number;
  /** A/B 框窗口与凸台外缘之间的机械余量(mm,默认 0.5)—— 用户可调,
   * 让 A/B 框窗口比凸台稍大,留装配间隙;不参与物理约束 */
  windowGap: number;
  /** 凸台宽度(mm) —— 用户调节(配合 stencilLip 双向滑动条):
   *   凸台托住 PCB;下限不能小于 max(pcbSizeX, pcbSizeY)
   *   上限不超过 stencilSize(再大唇宽就为负,钢网无唇)
   *   与 stencilLip 总和 = stencilSize(钢网外缘) */
  platterWidth: number;
  /** 钢网外缘压在凸台上的唇宽(mm) —— 用户调节(配合 platterWidth 滑动条):
   *   凸台外再扩出 lip mm 才到钢网外缘(凸台 = 槽 + lip 后取大)
   *   即 stencilLip = stencilSize - platterWidth
   *   与 platterWidth 双向联动(滑块两端),总和保持 stencilSize */
  stencilLip: number;
  /** 底部圆形顶出孔开关(0 = 关闭;孔径随板尺寸自适应) */
  ejectSlotWidth: number;
  /** 取放缺口位置:up / down / left / right 任意组合(空数组 = 关闭) */
  pryNotchSides: Array<'up' | 'down' | 'left' | 'right'>;
  /** 取放缺口大小比例(0.5~1.5,1.0=默认) */
  pryNotchScale: number;
  /** 4 角压钢网螺丝直径(M5) */
  cornerScrewD: number;
  /** 周圈螺丝直径(M3.5) */
  periScrewD: number;
  /** 外缘圆角半径 */
  outerCornerRadius: number;
  /** B 面底座开六角螺母沉孔(机丝+螺母锁紧);关闭则只用自攻底孔 */
  useHexNut: boolean;
  /** M3 螺母对边距 (mm,GB/T 6170 默认 5.5) */
  nutAcrossFlats: number;
  /** M3 螺母厚度 (mm,默认 2.7) */
  nutHeight: number;

  // 夹具整体尺寸 (正方形,按 20mm 步进,自动从窗口推导)
  jigSize: number;

  // Gerber 来源信息 (展示用)
  gerberFilename: string | null;
  /** 实际板框多边形点(已平移到以 bbox 中心为原点) */
  pcbOutlinePoints: Array<[number, number]>;
  /** 板框内孔轮廓(同 pcbOutlinePoints 坐标系;板内开槽的 PCB) */
  pcbOutlineHoles: Array<Array<[number, number]>>;
}

const DEFAULT: AppConfig = {
  appMode: "jig",
  pcbSizeX: 50,
  pcbSizeY: 50,
  pcbThickness: 1.6,
  stencilSize: 100,
  stencilThickness: 0.3,
  padShrink: 0,
  stencilFrameWidth: 12,
  stencilCornerRadius: 3,
  stencilFrameShape: "outline",
  pocketClearance: 0.1,
  stencilTaper: 105,
  stencilStagger: false,
  stencilStaggerGap: 0.55,
  stencilStaggerOffset: 0.15,
  stencilFilterTestPoints: true,
  stencilTestPointMaxDia: 1.2,
  stencilTestPointIsolation: 1.5,
  stencilGrid: false,
  stencilGridSize: 2.0,
  stencilGridBar: 0.5,
  stencilPadsTop: [],
  stencilPadsBottom: [],
  screwSpacing: 40,
  screwSpec: "M3",
  baseHeight: 4,
  topCoverHeight: 4,
  pcbPocketClearance: 0.15,
  insertHeight: 8,
  platterHeight: 4,
  platterMargin: 5,
  platterCornerRadius: 4.5,
  windowGap: 0.5,
  /** 默认 lip 占 lipMax 上界 60%:stencilSize=100, pcbMax=50 → lipMax=25,
   * 默认 lip=15(60%)→ platterWidth=70,凸台半宽 35mm,窗口=35+0.5=35.5mm。
   * 视觉上凸台有明显"托架台阶",凸台外缘 vs 钢网外缘对比一目了然。*/
  platterWidth: 70,
  stencilLip: 15,
  ejectSlotWidth: 22,
  pryNotchSides: ['down'],
  pryNotchScale: 1.0,
  cornerScrewD: 5,
  periScrewD: 3.2,
  outerCornerRadius: 5,
  useHexNut: true,
  nutAcrossFlats: 5.5,
  nutHeight: 2.4,
  // 自动推导(computeJigSize,5mm 步进):钢网 100 → 角部孔位下限 131.4 → 135
  jigSize: 135,
  gerberFilename: null,
  pcbOutlinePoints: [],
  pcbOutlineHoles: [],
};

/**
 * 螺丝规格 → 标准孔径 / 螺母对边 / 螺母厚度
 * 数据源:GB/T 5277-1985(机丝过孔)、GB/T 6170-2000(1 型六角螺母)
 * 周圈孔用 clearance 孔(Ø = 螺距 + 0.2~0.3),方便机丝穿过,
 * 机丝锁紧后底面用六角螺母反沉孔固定(不直接拧入塑料)。
 */
export const SCREW_SPECS = {
  "M2.5": { holeD: 2.7, nutAcross: 4.5, nutHeight: 2.0 },
  "M3":   { holeD: 3.2, nutAcross: 5.5, nutHeight: 2.4 },
  "M3.5": { holeD: 3.7, nutAcross: 6.0, nutHeight: 2.8 },
  "M4":   { holeD: 4.3, nutAcross: 7.0, nutHeight: 3.2 },
  "M5":   { holeD: 5.3, nutAcross: 8.0, nutHeight: 4.7 },
} as const;

export type ScrewSpec = keyof typeof SCREW_SPECS;

/** 派生窗口 x/y 半宽(与 Python get_polys 一致,bbox 近似异形板)
 * 凸台/窗口恒为正方形 —— 与 Python get_polys 同步改
 *
 * 物理约束链(自上而下):
 *   jig 螺丝带  ⊃  螺丝孔(jig/2 - 10 圆心) ——
 *   A/B 框窗口(机械余量)  ⊃  凸台(盖住钢网外缘)  ⊃  PCB 槽
 * 即:螺丝夹紧 A/B 框 —— A/B 框窗口比凸台稍大(windowGap,机械余量)
 * 压在钢网外缘上,凸台宽 ≥ PCB 边长(platterWidth),再扩 stencilLip 托住钢网。
 *
 * 数学链:
 *   slot_half_max = max(pcb/2 + clearance)
 *   platter_half  = max(slot_half_max, platterWidth/2)   # 凸台宽度不能比 PCB 小
 *   stencilLip    = stencilSize/2 - platterHalf (用户滑动条控制,
 *                  与 platterWidth 总和 = stencilSize)
 *   window_half   = max(platterHalf, stencilSize/2) + windowGap
 *                  # 窗口要么压在凸台上、要么压在钢网外缘(取更外)
 *
 * 反向钳制:platterMargin(派生) = platterHalf - slotHalf
 * —— 当钢网要求 lip > 实际 lip 时,platter 还得继续外扩才能托住钢网;
 * 该派生值保留在 platterMargin 字段里,用于项目文件兼容 */
export function windowHalfXY(c: AppConfig): { hx: number; hy: number } {
  const windowGap = c.windowGap ?? 0.5;
  const platterHalf = platterHalfFor(c);
  // 窗口 = 凸台外缘 + 机械余量(与 Python get_polys 同源):
  //   钢网坐在凸台顶面 + PCB 上方,唇向外延伸,不穿过 A/B 框中间,
  //   所以窗口不需要跟随 stencilSize,只需要 ≥ 凸台外缘即可。
  const windowHalf = platterHalf + windowGap;
  return { hx: windowHalf, hy: windowHalf };
}

/**
 * 凸台半宽计算:
 *   1) 优先 platterWidth/2(用户设的凸台宽度);
 *   2) 但必须 ≥ slotHalfMax(凸台不能比 PCB 小,否则 PCB 悬空);
 *   3) 反向钳制:lip 算出的实际凸台半宽 = stencilHalf 时,凸台已到钢网外缘,
/**
 * 凸台半宽(双向滑动条语义):
 *   platter_half = max(platterWidth / 2, slotHalfMax)
 * - 不再用 stencil/2 钳制 —— 那会让任何 ≤ stencilSize 的 platterWidth 都无效
 * - 窗口(window)那边再用 stencil/2 兜底,保证 A/B 框能容纳钢网
 * 与 Python `plater_radius` 完全同源。
 */
export function platterHalfFor(c: AppConfig): number {
  const slotHX = c.pcbSizeX / 2 + c.pcbPocketClearance;
  const slotHY = c.pcbSizeY / 2 + c.pcbPocketClearance;
  const slotHalfMax = Math.max(slotHX, slotHY);
  const userPlatterHalf = (c.platterWidth ?? 0) / 2;
  // platterMargin 作为最低外扩量兜底(老项目文件兼容):
  // platterWidth 不够大时自动补齐 margin
  const marginMin = c.platterMargin ?? 0;
  return Math.max(userPlatterHalf, slotHalfMax + marginMin);
}

/** 窗口最大半宽(方形近似,用于 jig 尺寸推导/角螺丝钳位) */
export function windowHalf(c: AppConfig): number {
  const { hx, hy } = windowHalfXY(c);
  return Math.max(hx, hy);
}

/**
 * 派生 platterMargin(项目文件兼容字段):等于有效台阶宽
 *   = platterHalf - slotHalf
 * 与 Python plater_radius 的 margin_eff 同源
 * @deprecated platterMargin 已是派生展示字段,由 watch 自动写入;不再建议组件直接读
 */
export function effectivePlatterMargin(c: AppConfig): number {
  const slot = Math.max(c.pcbSizeX / 2 + c.pcbPocketClearance,
                        c.pcbSizeY / 2 + c.pcbPocketClearance);
  return Math.max(0, platterHalfFor(c) - slot);
}

/**
 * 按 20mm 步进计算最小容纳尺寸
 * 输入:窗口 + 周圈孔带 + 边框(与 compute_perimeter_screw_positions 的 limit 一致)
 */
/**
 * 自动推荐夹具边长 —— 由两个独立约束取大,20mm 步进取整:
 *
 *   约束 A · 窗口容纳:
 *     jig/2 ≥ win + 14
 *     → jig ≥ 2*win + 28
 *     (win 到螺丝圆心 4mm + 螺丝圆心到外缘 10mm + 螺丝外缘结构保护 14mm)
 *     这是 screwPositions bandX = max(jig/2-10, win+4) 的临界点:
 *     当 jig ≥ 2*win+28,螺丝靠外缘排列;小于则贴窗口 → 不可再小
 *
 *   约束 B · 结构边:
 *     jig ≥ stencil + 20
 *     (每边 10mm 留给 A/B 盖板完整压住钢网四边)
 *
 *   约束 C · 4 角定位柱不撞凸台:
 *     凸台是圆角矩形 R=corner_radius,4 角定位柱圆心(s,s)沿对角线
 *     必须落在凸台圆角面外(留 r_post 余量)且在窗口轴向壁外(留 r_hole)
 *     —— 否则 insert 上的 post 圆柱面侵入凸台圆角面,base/cover 上的
 *     孔与窗口壁相交(几何不可成形)。
 *     推导(沿对角线方向最紧约束):
 *       s_post ≥ platter_half + r_post/√2 - r_corner·(1 - 1/√2)
 *       s_post ≤ jig/2 - (r_outer + r_post + 1)
 *       s_post ≥ win + r_hole
 *       → jig ≥ 2·(platter_half + r_post/√2 - r_corner·(1 - 1/√2)
 *                  + r_outer + r_post + 1)
 *       → jig ≥ 2·(win + r_hole + r_outer + r_post + 1)
 *     取大
 *
 * 注:孔带末端内收 14mm(limit = jig/2-14)由 screwPositions 内部自动适配,
 * 角定位柱让位(jig/2 - (r_outer+r_post+1))落在 jig/2-14 内,自动兼容。
 */
/** 钢网夹紧下限:A/B 盖(=底板,同 jigSize)要夹住钢网四边,
 * 且钢网外缘必须落在周圈螺丝孔(圆心距外缘 10mm)的内侧、不碰孔壁:
 *   jig/2 ≥ stencilHalf + 10(螺丝圆心) + periScrewD/2(孔半径) + 1.5(净距)
 *   → jig ≥ stencilSize + 20 + periScrewD + 3
 * 底板与 A/B 盖同尺寸,同一约束。
 */
export function stencilClampFloor(c: AppConfig): number {
  return c.stencilSize + 20 + (c.periScrewD ?? 3.2) + 3;
}

function computeJigSize(c: AppConfig): number {
  const win = windowHalf(c);
  const winFloor = 2 * win + 28;
  const stencilFloor = stencilClampFloor(c);
  // 约束 C:4 角定位柱不撞凸台/窗口
  const rPost = (c.cornerScrewD ?? 5) / 2 + 2;
  const rHole = (c.cornerScrewD ?? 5) / 2 + 2.2;
  const rOut = c.outerCornerRadius ?? 5;
  const rCorner = c.platterCornerRadius ?? 4.5;
  // 凸台半宽直接用 platterHalfFor(新语义):platterWidth/2 与 slotHalfMax、stencilHalf 取大
  const platterHalf = platterHalfFor(c);
  // s_post ≥ platter_half + r_post/√2 - r_corner·(1 - 1/√2)
  // (凸台对角线方向最紧约束,推导见 docstring)
  const sPlatter = platterHalf + rPost / Math.sqrt(2) - rCorner * (1 - 1 / Math.sqrt(2));
  const sOuter = rOut + rPost + 1;
  const postFloor = 2 * (sPlatter + sOuter);
  // s_post ≥ win + r_hole(窗口轴向壁约束,base/cover 上的孔不能与窗口壁相交)
  const winHoleFloor = 2 * (win + rHole + sOuter);
  // 5mm 步进取整:贴近结构下限,避免 20mm 步进白多出一圈边料
  return Math.max(60, Math.ceil(Math.max(winFloor, stencilFloor, postFloor, winHoleFloor) / 5) * 5);
}

export const useConfigStore = defineStore("config", () => {
  const config = ref<AppConfig>({ ...DEFAULT });

  // 派生:周圈螺丝位置(与 Python compute_perimeter_screw_positions 同算法)
  // 孔带靠外:螺丝圆心距外缘 10mm,窗口→螺丝的内侧带完整留给钢网夹紧;
  // 行/列末端内收(jig/2-14)让位 4 角定位柱孔
  const screwPositions = computed(() => {
    const c = config.value;
    const positions: Array<[number, number]> = [];
    if (c.screwSpacing <= 0) return positions;

    const { hx, hy } = windowHalfXY(c);
    const bandX = Math.max(c.jigSize / 2 - 10, hx + 4);
    const bandY = Math.max(c.jigSize / 2 - 10, hy + 4);
    const limit = c.jigSize / 2 - 14;
    if (limit < c.screwSpacing) {
      // 小夹具:每边只放中点一颗
      if (limit > 0) {
        positions.push([0, bandY], [0, -bandY], [bandX, 0], [-bandX, 0]);
      }
      return positions;
    }
    const n = Math.floor(limit / c.screwSpacing);
    const seen = new Set<string>();
    for (let i = -n; i <= n; i++) {
      const cc = i * c.screwSpacing;
      if (Math.abs(cc) > limit) continue;
      for (const [x, y] of [
        [cc, bandY], [cc, -bandY], [bandX, cc], [-bandX, cc],
      ] as Array<[number, number]>) {
        const key = `${x.toFixed(3)},${y.toFixed(3)}`;
        if (!seen.has(key)) {
          seen.add(key);
          positions.push([x, y]);
        }
      }
    }
    return positions;
  });

  // 板子尺寸变化 → 触发"自动钳制到下界"(反向钳制下界抬高):
  //   - stencilSize < pcb_max+0.1 时,自动推荐 = pcb_max+20(10mm 步进)
  //     —— 避免空值/默认值 0 让后续推导失真
  //   - platterMargin:派生写入 = effectivePlatterMargin(项目兼容字段)
  //   - jigSize:按 20mm 步进取整(窗口 + 螺丝带 + 外缘)
  // 触发依赖:pcb/stencil/lip/windowGap 任一变化都重算(下界同步联动)
  watch(
    () => [
      config.value.pcbSizeX,
      config.value.pcbSizeY,
      config.value.stencilSize,
      config.value.stencilLip,
      config.value.platterWidth,
      config.value.windowGap,
      // 螺丝相关参数影响夹紧下限/角柱约束,变化时重算 jigSize
      config.value.periScrewD,
      config.value.cornerScrewD,
      config.value.outerCornerRadius,
      config.value.platterCornerRadius,
    ],
    () => {
      const c = config.value;
      const pcbMax = Math.max(c.pcbSizeX, c.pcbSizeY);
      if (c.stencilSize < pcbMax + 0.1) {
        c.stencilSize = Math.ceil((pcbMax + 20) / 10) * 10;
      }
      // 双向联动:platterWidth + 2*stencilLip = stencilSize
      //   凸台宽 ≥ max(pcbMax, stencilSize/2);即 lip ≤ (stencilSize - pcbMax)/2
      //   若 stencilSize < pcbMax 时(此时 lip = 0,凸台至少等于钢网外缘),也允许
      const lipMax = Math.max(0, (c.stencilSize - pcbMax) / 2);
      // 同步唇宽 = (stencilSize - platterWidth)/2,但保证 platterWidth ≥ pcbMax
      const halfLip = (c.stencilSize - c.platterWidth) / 2;
      c.stencilLip = Math.max(0, Math.min(lipMax, halfLip));
      // platterMargin 派生写入(项目文件兼容)
      c.platterMargin = effectivePlatterMargin(c);
      c.jigSize = computeJigSize(c);
    },
    { immediate: true }
  );

  // 监听窗口相关参数变化,自动重算 jig 尺寸(正方形)
  watch(
    () => [
      config.value.pcbSizeX,
      config.value.pcbSizeY,
      config.value.stencilSize,
      config.value.stencilLip,
      config.value.platterWidth,
      config.value.windowGap,
    ],
    () => {
      config.value.jigSize = computeJigSize(config.value);
    }
  );

  // 凸台高度 ≡ 底座板厚:B 面翻转装配时凸台套进底座窗口,
  // 两者相等才能让底座顶面与 PCB B 面齐平 → 钢网零间隙贴住板子
  watch(
    () => config.value.baseHeight,
    (h) => {
      config.value.platterHeight = h;
    },
    { immediate: true }
  );

  // 螺丝规格 → 周圈孔径 / 螺母尺寸(单向联动:换规格时覆写三个高级参数,
  // 用户后续改回规格或手动改高级参数都不会被反向覆盖)
  watch(
    () => config.value.screwSpec,
    (spec) => {
      const s = SCREW_SPECS[spec as ScrewSpec];
      if (!s) return;
      config.value.periScrewD = s.holeD;
      config.value.nutAcrossFlats = s.nutAcross;
      config.value.nutHeight = s.nutHeight;
    },
    { immediate: true }
  );

  // 参数校验:非阻塞警告(key 为 i18n 键,组件层负责展示)
  const warnings = computed(() => {
    const c = config.value;
    const list: Array<{ key: string; params?: Record<string, number | string> }> = [];
    const win = windowHalf(c);

    // 钢网必须盖住整块板子,且窗口外留出盖板压紧边
    // (盖板窗口 = 板 + 4mm,钢网每边至少再宽 2mm 才压得住 → 板 + 8mm)
    const pcbMax = Math.max(c.pcbSizeX, c.pcbSizeY);
    if (c.stencilSize < pcbMax + 8) {
      list.push({
        key: "config.warnings.stencilTooSmall",
        params: { s: c.stencilSize, n: pcbMax + 8 },
      });
    }

    // 夹具必须能夹住钢网:钢网外缘落在周圈螺丝孔内侧且不碰孔壁
    // (A/B 盖与底板同尺寸,同一约束)
    if (c.jigSize < stencilClampFloor(c)) {
      list.push({
        key: "config.warnings.jigLTstencil",
        params: { j: c.jigSize, s: c.stencilSize, n: Math.ceil(stencilClampFloor(c) / 5) * 5 },
      });
    }

    // PCB 必须放得进夹具(窗口 + 周圈孔带 + 外缘):
    //   约束 band = max(jig/2 - 10, win_half + 4) —— 周圈孔带靠外时距外缘 10mm;
    //   要让周圈孔带真正靠外(band = jig/2-10,不贴窗口),需 jig/2-10 ≥ win_half+4
    //   → jig ≥ 2*win + 28(窗口到螺丝圆心 4mm + 螺丝圆心到外缘 10mm +
    //     螺丝外缘结构保护 14mm = 4 + 10 + 14,与 Python
    //     compute_perimeter_screw_positions 的 band/limit 同源)
    if (2 * win + 28 > c.jigSize + 0.01) {
      list.push({
        key: "config.warnings.jigTooSmall",
        params: { j: Math.ceil((2 * win + 28) / 5) * 5 },
      });
    }
    // 凸台高度:至少 2mm 台阶面压钢网,槽深后还要剩壁
    if (c.platterHeight < c.pcbThickness + 1.0) {
      list.push({
        key: "config.warnings.platterTooThin",
        params: { h: c.platterHeight, n: c.pcbThickness + 1.0 },
      });
    }
    // 插板总厚必须大于凸台高
    if (c.insertHeight <= c.platterHeight) {
      list.push({
        key: "config.warnings.insertLTplatter",
        params: { i: c.insertHeight, p: c.platterHeight },
      });
    }
    // 顶盖沉孔深 2mm,盖太薄会穿透
    if (c.topCoverHeight < 3.0) {
      list.push({
        key: "config.warnings.coverTooThin",
        params: { h: c.topCoverHeight },
      });
    }
    // 凸台台阶太窄压不住钢网
    if (c.platterMargin < 1.5) {
      list.push({
        key: "config.warnings.marginTooSmall",
        params: { m: c.platterMargin },
      });
    }
    // 角螺丝 boss 被窗口挤出角部(内收保护触发,距角变远)
    if (win + 3.5 > c.jigSize / 2 - 7) {
      list.push({ key: "config.warnings.cornerScrewOutside" });
    }
    return list;
  });

  // Actions
  function applyGerberSize(
    width: number,
    height: number,
    filename: string,
    outlinePoints: Array<[number, number]> = [],
    holes: Array<Array<[number, number]>> = []
  ) {
    const c = config.value;
    c.pcbSizeX = width;
    c.pcbSizeY = height;
    c.gerberFilename = filename;
    c.pcbOutlinePoints = outlinePoints;
    c.pcbOutlineHoles = holes;
    // 导入新 Gerber:滑块自动落到 60% 位置(中间靠右),台阶有合理默认值
    //   滑动条本身仍可调到偏移 0(lip = lipMax,台阶 = 0),由用户主动选择
    //   stencilSize 下界 = ceil((pcbMax+20)/10)*10(与 watch 同式,只放大不缩小)
    const pcbMax = Math.max(width, height);
    const stencilFloor = Math.ceil((pcbMax + 20) / 10) * 10;
    c.stencilSize = Math.max(c.stencilSize, stencilFloor);
    const lipMax = Math.max(0, (c.stencilSize - pcbMax) / 2);
    const lip = 0.6 * lipMax;
    c.stencilLip = Math.round(lip * 10) / 10;
    c.platterWidth = c.stencilSize - 2 * c.stencilLip;
  }

  /** 钢网模式:导入板框 + 双面锡膏层结果 */
  function applyStencilGerber(
    width: number,
    height: number,
    outlinePoints: Array<[number, number]>,
    topPads: PadPolygon[],
    bottomPads: PadPolygon[]
  ) {
    const c = config.value;
    c.pcbSizeX = width;
    c.pcbSizeY = height;
    c.pcbOutlinePoints = outlinePoints;
    c.stencilPadsTop = topPads;
    c.stencilPadsBottom = bottomPads;
    // 导入新 Gerber:滑块自动落到 60% 位置(同 applyGerberSize)
    const pcbMax = Math.max(width, height);
    const stencilFloor = Math.ceil((pcbMax + 20) / 10) * 10;
    c.stencilSize = Math.max(c.stencilSize, stencilFloor);
    const lipMax = Math.max(0, (c.stencilSize - pcbMax) / 2);
    const lip = 0.6 * lipMax;
    c.stencilLip = Math.round(lip * 10) / 10;
    c.platterWidth = c.stencilSize - 2 * c.stencilLip;
  }

  function setMode(mode: AppMode) {
    config.value.appMode = mode;
  }

  /** 重置高级参数为默认值;基础区(PCB 尺寸/厚度/钢网/缺口位置/
   *  Gerber 轮廓)保留 —— 重置按钮在高级区内,只管高级参数。
   *  注意必须 Object.assign 原地改:整体替换 config.value 会触发
   *  pcbSizeX/Y 联动 watcher(数组引用变化被误判为值变化),
   *  把用户手填的钢网尺寸覆盖成自动推荐值 */
  function reset() {
    Object.assign(config.value, {
      screwSpacing: DEFAULT.screwSpacing,
      screwSpec: DEFAULT.screwSpec,
      baseHeight: DEFAULT.baseHeight,
      topCoverHeight: DEFAULT.topCoverHeight,
      pcbPocketClearance: DEFAULT.pcbPocketClearance,
      insertHeight: DEFAULT.insertHeight,
      platterMargin: DEFAULT.platterMargin,
      platterCornerRadius: DEFAULT.platterCornerRadius,
      ejectSlotWidth: DEFAULT.ejectSlotWidth,
      cornerScrewD: DEFAULT.cornerScrewD,
      periScrewD: DEFAULT.periScrewD,
      outerCornerRadius: DEFAULT.outerCornerRadius,
      useHexNut: DEFAULT.useHexNut,
      nutAcrossFlats: DEFAULT.nutAcrossFlats,
      nutHeight: DEFAULT.nutHeight,
    });
    // 派生参数重算(margin 影响窗口→jig 尺寸;platterHeight 随 baseHeight)
    config.value.platterMargin = effectivePlatterMargin(config.value);
    config.value.jigSize = computeJigSize(config.value);
  }

  // Python 引擎状态(python + CAD 依赖)
  const pythonPath = ref<string | null>(null);
  const pythonDetected = ref(false); // = 找到 python 且依赖齐全
  const depsMissing = ref<string[]>([]);
  const pythonError = ref<string | null>(null);
  const engineLoading = ref(false);
  const bundledEngine = ref(false); // 使用随应用打包的内置引擎

  async function detectPython() {
    pythonError.value = null;
    engineLoading.value = true;
    try {
      const st = await invoke<{
        python_path: string | null;
        deps_ok: boolean;
        missing: string[];
        bundled: boolean;
      }>("get_engine_status");
      pythonPath.value = st.python_path;
      depsMissing.value = st.missing ?? [];
      bundledEngine.value = !!st.bundled;
      // 只有 python + 依赖全齐才算就绪(否则常驻 server 起不来)
      pythonDetected.value = !!st.python_path && st.deps_ok;
    } catch (e) {
      pythonPath.value = null;
      pythonDetected.value = false;
      depsMissing.value = [];
      bundledEngine.value = false;
      pythonError.value = e instanceof Error ? e.message : String(e);
    } finally {
      engineLoading.value = false;
    }
  }

  return {
    config,
    screwPositions,
    warnings,
    pythonPath,
    pythonDetected,
    depsMissing,
    pythonError,
    engineLoading,
    bundledEngine,
    applyGerberSize,
    applyStencilGerber,
    setMode,
    reset,
    detectPython,
  };
});
