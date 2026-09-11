<script setup lang="ts">
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "vue-i18n";
import { useConfigStore } from "../stores/config";
import type { PadPolygon } from "../lib/gerber/pads";
import { ElMessage } from "element-plus";

const { t } = useI18n();
const store = useConfigStore();
const working = ref(false);

function buildScadParams() {
  const c = store.config;
  return {
    pcb_size_x: c.pcbSizeX,
    pcb_size_y: c.pcbSizeY,
    pcb_thickness: c.pcbThickness,
    pcb_pocket_clearance: c.pcbPocketClearance,
    pcb_outline_points: c.pcbOutlinePoints,
    pcb_outline_holes: c.pcbOutlineHoles,
    stencil_size: c.stencilSize,
    screw_spacing: c.screwSpacing,
    screw_spec: c.screwSpec,
    base_height: c.baseHeight,
    top_cover_height: c.topCoverHeight,
    jig_size: c.jigSize,
    insert_height: c.insertHeight,
    platter_height: c.platterHeight,
    platter_width: c.platterWidth,
    stencil_lip: c.stencilLip,
    window_gap: c.windowGap,
    platter_corner_radius: c.platterCornerRadius,
    eject_slot_width: c.ejectSlotWidth,
    corner_screw_d: c.cornerScrewD,
    peri_screw_d: c.periScrewD,
    outer_corner_radius: c.outerCornerRadius,
    use_hex_nut: c.useHexNut,
    nut_across_flats: c.nutAcrossFlats,
    nut_height: c.nutHeight,
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
    stencil_pads_top: c.stencilPadsTop.map((p) => p.parts),
    stencil_pads_bottom: c.stencilPadsBottom.map((p) => p.parts),
  };
}

async function saveProject() {
  const path = await save({
    title: t("project.saveTitle"),
    defaultPath: "stencil-jig-project.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return;

  working.value = true;
  try {
    await invoke("save_project", {
      path,
      config: buildScadParams(),
      gerberFilename: store.config.gerberFilename,
    });
    ElMessage.success(t("project.saved", { path }));
  } catch (e) {
    ElMessage.error(t("project.saveFailed", { msg: e }));
  } finally {
    working.value = false;
  }
}

async function loadProject() {
  const path = await open({
    title: t("project.loadTitle"),
    multiple: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path || Array.isArray(path)) return;

  working.value = true;
  try {
    const project = await invoke<{
      version: number;
      config: any;
      gerber_filename: string | null;
    }>("load_project", { path });

    // 把后端字段映射回前端 camelCase(带默认值,兼容旧项目文件)
    const cfg = project.config;
    store.config.pcbSizeX = cfg.pcb_size_x;
    store.config.pcbSizeY = cfg.pcb_size_y;
    store.config.pcbThickness = cfg.pcb_thickness;
    store.config.pcbPocketClearance = cfg.pcb_pocket_clearance ?? 0.15;
    store.config.stencilSize = cfg.stencil_size;
    store.config.screwSpacing = cfg.screw_spacing;
    store.config.screwSpec = cfg.screw_spec ?? "M3";
    store.config.baseHeight = cfg.base_height;
    store.config.topCoverHeight = cfg.top_cover_height;
    store.config.jigSize = cfg.jig_size;
    store.config.insertHeight = cfg.insert_height ?? 8;
    store.config.platterHeight = cfg.platter_height ?? 4;
    // 优先读 stencil_lip(新字段);旧项目文件仅有 platter_margin 时把它当作 lip 兜底
    if (cfg.stencil_lip !== undefined) {
      store.config.stencilLip = cfg.stencil_lip;
    } else if (cfg.platter_margin !== undefined) {
      store.config.stencilLip = cfg.platter_margin;
    } else {
      // 默认 lip 占 lipMax 上界 60%:与 store 默认值保持一致
      store.config.stencilLip = 15;
    }
    store.config.platterWidth = cfg.platter_width ?? Math.max(cfg.pcb_size_x, cfg.pcb_size_y);
    store.config.windowGap = cfg.window_gap ?? 0.5;
    store.config.platterCornerRadius = cfg.platter_corner_radius ?? 4.5;
    store.config.ejectSlotWidth = cfg.eject_slot_width ?? 22;
    // 旧项目文件的 pry_notch_side 单值也兼容:转成数组
    if (Array.isArray(cfg.pry_notch_sides)) {
      store.config.pryNotchSides = cfg.pry_notch_sides;
    } else if (typeof cfg.pry_notch_side === "string" && cfg.pry_notch_side !== "auto" && cfg.pry_notch_side !== "off") {
      store.config.pryNotchSides = [cfg.pry_notch_side];
    } else {
      store.config.pryNotchSides = ["down"];
    }
    store.config.pryNotchScale = cfg.pry_notch_scale ?? 1.0;
    store.config.cornerScrewD = cfg.corner_screw_d ?? 5;
    store.config.periScrewD = cfg.peri_screw_d ?? 3.5;
    store.config.outerCornerRadius = cfg.outer_corner_radius ?? 5;
    store.config.useHexNut = cfg.use_hex_nut ?? true;
    store.config.nutAcrossFlats = cfg.nut_across_flats ?? 5.5;
    store.config.nutHeight = cfg.nut_height ?? 2.7;
    store.config.pcbOutlinePoints = cfg.pcb_outline_points ?? [];
    store.config.pcbOutlineHoles = cfg.pcb_outline_holes ?? [];
    // 双面焊盘;旧项目文件的 stencil_pads 归入 Top 面。
    // 每项兼容两种格式:新 = parts 数组(元素为对象),旧 = 顶点数组
    const toPad = (entry: unknown): PadPolygon => {
      if (Array.isArray(entry) && entry.length > 0 && typeof entry[0] === "object") {
        return { type: "macro", cx: 0, cy: 0, polarity: "D", parts: entry as PadPolygon["parts"] };
      }
      const pts = entry as Array<[number, number]>;
      return { type: "rect", cx: 0, cy: 0, polarity: "D", parts: [{ polarity: "D", points: pts }] };
    };
    store.config.stencilPadsTop = (cfg.stencil_pads_top ?? cfg.stencil_pads ?? []).map(toPad);
    store.config.stencilPadsBottom = (cfg.stencil_pads_bottom ?? []).map(toPad);
    store.config.stencilThickness = cfg.stencil_thickness ?? 0.3;
    store.config.padShrink = cfg.pad_shrink ?? 0;
    store.config.stencilFrameWidth = cfg.stencil_frame_width ?? 12;
    store.config.stencilCornerRadius = cfg.stencil_corner_radius ?? 3;
    store.config.stencilFrameShape = cfg.stencil_frame_shape === "rect" ? "rect" : "outline";
    store.config.pocketClearance = cfg.pocket_clearance ?? 0.1;
    store.config.stencilTaper = cfg.stencil_taper ?? 105;
    store.config.stencilStagger = cfg.stencil_stagger ?? false;
    store.config.stencilStaggerGap = cfg.stencil_stagger_gap ?? 0.55;
    store.config.stencilStaggerOffset = cfg.stencil_stagger_offset ?? 0.15;
    store.config.stencilFilterTestPoints = cfg.stencil_filter_test_points ?? true;
    store.config.stencilTestPointMaxDia = cfg.stencil_test_point_max_dia ?? 1.9;
    store.config.stencilTestPointIsolation = cfg.stencil_test_point_isolation ?? 1.5;
    store.config.stencilGrid = cfg.stencil_grid ?? false;
    store.config.stencilGridSize = cfg.stencil_grid_size ?? 2.0;
    store.config.stencilGridBar = cfg.stencil_grid_bar ?? 0.5;
    store.config.gerberFilename = project.gerber_filename;

    ElMessage.success(t("project.loaded"));
  } catch (e) {
    ElMessage.error(t("project.loadFailed", { msg: e }));
  } finally {
    working.value = false;
  }
}
</script>

<template>
  <div class="project-menu">
    <el-button-group class="project-menu__actions">
      <el-button :loading="working" size="small" @click="loadProject">
        {{ t('project.load') }}
      </el-button>
      <el-button
        :loading="working"
        size="small"
        type="primary"
        @click="saveProject"
      >
        {{ t('project.save') }}
      </el-button>
    </el-button-group>
    <span
      v-if="store.config.gerberFilename"
      class="project-menu__filename"
    >
      Gerber: <code>{{ store.config.gerberFilename }}</code>
    </span>
  </div>
</template>

<style scoped>
.project-menu {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--spacer-12);
  font-family: var(--font-family-default);
}

.project-menu__filename {
  font-size: var(--body-sm-font-size);
  color: var(--text-tertiary);
  line-height: var(--body-sm-line-height);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}

.project-menu__filename code {
  font-family: var(--font-family-mono);
  font-size: var(--body-sm-font-size);
  background: var(--bg-overlay-l1);
  padding: var(--spacer-1, 1px) var(--spacer-6);
  border-radius: var(--radius-4);
  color: var(--text-secondary);
}
</style>
