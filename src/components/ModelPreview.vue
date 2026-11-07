<script setup lang="ts">
import { ref, computed, defineAsyncComponent, h, onMounted, onBeforeUnmount, watch, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ElMessage, ElMessageBox } from "element-plus";
import { useI18n } from "vue-i18n";
import { useConfigStore } from "../stores/config";
import { useUiStore } from "../stores/ui";
import { useWorkSessionStore } from "../stores/work-session";
import { buildScadParams as createScadParams, modelParamsHash, scadPartHash } from "../lib/model-params";
import { GenerationTasks, isGenerationCancelled } from "../lib/generation-tasks";
import { cacheStlPart, clearStlCache, type StlCacheEntry } from "../lib/stl-cache";
import { buildJigAssembly, disposeJigAssembly, setJigExplosion, setJigVisibility } from "../lib/jig-assembly";
import { usePartMetrics, type PartMetrics } from "../composables/usePartMetrics";
import { reviewStencilSizeForExport } from "../lib/stencil-export-review";
import { defaultExportName, validExportName } from "../lib/export-name";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

type PartName = "base" | "insert" | "cover" | "stencil_top" | "stencil_bottom";
type PreviewName = PartName | "assembly";

const StencilInspection = defineAsyncComponent(() => import("./StencilInspection.vue"));

const store = useConfigStore();
const workSession = useWorkSessionStore();
const emit = defineEmits<{ reviewStencilSize: [] }>();
const ui = useUiStore();
const { t } = useI18n();
const canvasEl = ref<HTMLCanvasElement | null>(null);
const containerEl = ref<HTMLElement | null>(null);
// Imports or a mode switch may finish before this async component mounts.
const activePart = ref<PreviewName>(store.config.appMode === "stencil"
  ? (store.config.stencilPadsTop.length || !store.config.stencilPadsBottom.length ? "stencil_top" : "stencil_bottom")
  : "insert");
const loading = ref(false);
const exporting = ref(false);
const inspectionOpen = ref(false);
// Keep the inspected board and viewport mounted after the first visit.
const inspectionLoaded = ref(false);
const generationTasks = new GenerationTasks(invoke);
const errorMsg = ref<string | null>(null);

const PART_TO_RUST: Record<PartName, string> = {
  base: "base",
  insert: "pcb_insert",
  cover: "top_cover",
  stencil_top: "stencil_top",
  stencil_bottom: "stencil_bottom",
};

const appMode = computed(() => store.config.appMode);

// 数据就绪才渲染:治具模式需导入板框轮廓,钢网模式需导入焊盘;
// 否则不生成默认 demo,预览区只显示引导卡片
const hasData = computed(() =>
  appMode.value === "stencil"
    ? store.config.stencilPadsTop.length > 0 || store.config.stencilPadsBottom.length > 0
    : store.config.pcbOutlinePoints.length > 0
);
watch(hasData, ready => { if (!ready) inspectionOpen.value = false; });

// three.js 引用(shallowRef 避免响应式包装影响性能)
const scene = shallowRef<THREE.Scene | null>(null);
const camera = shallowRef<THREE.PerspectiveCamera | null>(null);
const renderer = shallowRef<THREE.WebGLRenderer | null>(null);
const controls = shallowRef<OrbitControls | null>(null);
const currentMesh = shallowRef<THREE.Mesh | null>(null);
const currentAssembly = shallowRef<THREE.Group | null>(null);
const explosionPercent = ref(0);
const showAssemblyPcb = ref(true);
const showAssemblyStencil = ref(true);
watch([showAssemblyPcb, showAssemblyStencil], () => {
  if (currentAssembly.value) setJigVisibility(currentAssembly.value, showAssemblyPcb.value, showAssemblyStencil.value);
  invalidate();
});
let displayedExplosion = 0;
let explosionFrameTime: number | null = null;
watch(explosionPercent, () => invalidate());
const hasPreview = computed(() => !!currentMesh.value || !!currentAssembly.value);
const animationId = ref<number | null>(null);

// STL 字节缓存:key 是 part 名称(insert/cover/base),value 是 {bytes, paramsHash, geometry?}
// 切换 tab 时如果参数没变,直接用缓存的 bytes 跳过 Python 调用
// bytes 是 ArrayBuffer(Rust 端 tauri::ipc::Response 二进制通道,避免 JSON 数字数组膨胀)
// geometry 是解析后的 BufferGeometry(切 tab 复用,零解析开销);整体替换写入,用 shallowRef
const stlCache = shallowRef<Record<string, StlCacheEntry<THREE.BufferGeometry>>>({});
let disposed = false;
let cacheGeneration = 0;
let pcbEnvironment: THREE.WebGLRenderTarget | null = null;

const paramsHash = () => modelParamsHash(store.config);
const buildScadParams = () => createScadParams(store.config);
const partHash = (part: string, params = buildScadParams()) => scadPartHash(params, part);
// A mesh remains valid while the next generation is building, even if its
// cache entry has already been replaced. Release only after scene replacement.
const retiredGeometry = new Set<THREE.BufferGeometry>();
function releaseGeometry(geometry: THREE.BufferGeometry) {
  if (currentMesh.value?.geometry === geometry) retiredGeometry.add(geometry);
  else geometry.dispose();
}

function initThreeScene() {
  if (!canvasEl.value) return;

  const canvas = canvasEl.value;
  const container = canvas.parentElement!;
  const w = container.clientWidth;
  const h = container.clientHeight;

  const s = new THREE.Scene();
  // 背景交由 CSS 径向渐变(renderer alpha),场景只负责模型与网格

  // 相机:斜俯视(参考 Dream_maker 风格,约 30° 俯视,既看布局又看高度)
  const cam = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
  cam.position.set(120, 80, 150);  // X 远, Y 中, Z 中 = 倾斜俯视
  cam.lookAt(0, 0, 0);

  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  // Let CSS own the display size; only the drawing buffer needs resizing.
  r.setSize(w, h, false);
  // HiDPI 屏 cap 到 2x:3x 的像素增益肉眼不可辨,填充率/显存开销却翻倍
  r.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // 灯光
  s.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(100, 200, 100);
  s.add(dirLight);
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
  dirLight2.position.set(-100, 50, -100);
  s.add(dirLight2);

  // 坐标轴
  const axesHelper = new THREE.AxesHelper(30);
  s.add(axesHelper);

  // 网格地板(颜色随主题)
  const gridHelper = new THREE.GridHelper(
    400, 20,
    ui.resolvedTheme === "dark" ? 0x5C5C5F : 0x737373,
    ui.resolvedTheme === "dark" ? 0x3A3A3D : 0xD4D4D4,
  );
  s.add(gridHelper);

  // 控制器(支持自动旋转)
  const ctrl = new OrbitControls(cam, canvas);
  ctrl.enableDamping = true;
  ctrl.dampingFactor = 0.08;
  ctrl.autoRotate = false;
  ctrl.autoRotateSpeed = 0.8;
  // 相机变化(拖拽/惯性)时唤醒渲染循环
  ctrl.addEventListener("change", invalidate);

  scene.value = s;
  camera.value = cam;
  renderer.value = r;
  controls.value = ctrl;

  animate();
}

// 按需渲染:静止时不画也不跑 RAF(暂停动画循环,空闲零 CPU),
// 场景变化(invalidate)或相机运动(update 返回 true)时再唤醒
let needsRender = true;

function invalidate() {
  if (disposed) return;
  needsRender = true;
  if (animationId.value === null) animate();
}

function animate() {
  if (disposed) return;
  animationId.value = requestAnimationFrame(animate);
  if (!scene.value || !camera.value || !renderer.value) return;
  const now = performance.now();
  const targetExplosion = explosionPercent.value / 100;
  let exploding = false;
  if (currentAssembly.value && displayedExplosion !== targetExplosion) {
    const dt = explosionFrameTime === null ? 16 : Math.min(now - explosionFrameTime, 50);
    displayedExplosion += (targetExplosion - displayedExplosion) * (1 - Math.exp(-dt / 65));
    if (Math.abs(displayedExplosion - targetExplosion) < 0.0005) displayedExplosion = targetExplosion;
    setJigExplosion(currentAssembly.value, displayedExplosion);
    needsRender = true;
    exploding = displayedExplosion !== targetExplosion;
  }
  explosionFrameTime = exploding ? now : null;
  const moved = controls.value ? controls.value.update() : false;
  if (moved || needsRender) {
    renderer.value.render(scene.value, camera.value);
    // 相机或场景变化后重投影测量标签,保证文字始终贴住测量线
    if (measureTags.value.length) updateMeasureTags();
    needsRender = false;
  }
  // 完全静止 → 暂停循环,等待下一次 invalidate 唤醒
  if (!moved && !needsRender && !exploding && animationId.value !== null) {
    cancelAnimationFrame(animationId.value);
    animationId.value = null;
  }
}

function disposeMesh() {
  clearMeasure();
  resetTopology();
  if (currentAssembly.value) {
    scene.value?.remove(currentAssembly.value);
    disposeJigAssembly(currentAssembly.value);
    currentAssembly.value = null;
    invalidate();
  }
  if (currentMesh.value) {
    scene.value?.remove(currentMesh.value);
    // geometry 由 stlCache 持有(切 tab 时复用),不在此释放
    if (Array.isArray(currentMesh.value.material)) {
      currentMesh.value.material.forEach((m) => m.dispose());
    } else {
      currentMesh.value.material.dispose();
    }
    currentMesh.value = null;
    retiredGeometry.forEach(geometry => geometry.dispose());
    retiredGeometry.clear();
    invalidate();
  }
}

// 渲染序号:切 tab / 参数变化后,丢弃仍在途的旧请求结果,防止旧模型覆盖新 tab
let renderSeq = 0;

async function renderCurrent(force = false) {
  if (disposed || inspectionOpen.value) return;
  cancelPreviewTasks(["preview"]);
  if (!scene.value || !store.pythonDetected) {
    if (!store.pythonDetected) {
      errorMsg.value = t("preview.noPythonRender");
    }
    return;
  }

  // 未导入数据:不渲染 demo,清掉旧模型让引导卡片显示
  if (!hasData.value) {
    ++renderSeq; // 让在途的旧渲染结果作废
    disposeMesh();
    loading.value = false;
    errorMsg.value = null;
    return;
  }

  const seq = ++renderSeq;
  const generation = cacheGeneration;
  const partName = activePart.value; // 捕获请求发起时的部件,await 后不再读响应式值

  // 查缓存:同 part + 同 params → 直接用缓存 bytes,跳过 Python 调用
  const cached = partName === "assembly" ? undefined : stlCache.value[partName];
  const hash = paramsHash();
  if (!force && cached && cached.paramsHash === partHash(partName)) {
    applyStlToMesh(getOrParseGeometry(partName, cached.bytes, cached.paramsHash));
    // 接管 loading:本次渲染已同步完成,而在途的旧请求(seq 已过期)
    // 的 finally 不会清 loading —— 不接管会永久转圈
    loading.value = false;
    errorMsg.value = null;
    schedulePreload();
    return;
  }

  loading.value = true;
  errorMsg.value = null;
  let rendered = false;

  try {
    const parts: PartName[] = partName === "assembly" ? ["insert", "base", "cover"] : [partName];
    const params = buildScadParams();
    // Sequential generation keeps the Python worker responsive and shares any
    // in-flight preload rather than generating the same part a second time.
    for (const part of parts) {
      await ensurePart(part, generation, params, force);
      if (!canCacheResult(hash, generation) || seq !== renderSeq || activePart.value !== partName) return;
    }
    if (partName === "assembly") {
      applyAssembly();
    } else {
      applyStlToMesh(getOrParseGeometry(partName, stlCache.value[partName].bytes, partHash(partName, params)));
    }
    rendered = true;
  } catch (e) {
    if (seq === renderSeq && !isGenerationCancelled(e)) {
      errorMsg.value = t("preview.renderFailed", { msg: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    if (seq === renderSeq) {
      loading.value = false;
      if (rendered) schedulePreload();
    }
  }
}

// 解析 STL 为 BufferGeometry;同 hash 已解析过则直接复用(切 tab 零解析、瞬间上屏)
function getOrParseGeometry(partName: string, bytes: ArrayBuffer, hash: string): THREE.BufferGeometry {
  const entry = stlCache.value[partName];
  if (entry && entry.paramsHash === hash && entry.geometry) return entry.geometry;
  const geometry = new STLLoader().parse(bytes);
  // Preserve the common CAD origin for assembly. Single-part display is
  // centered by its Mesh transform instead of mutating the cached geometry.
  geometry.computeVertexNormals();
  if (entry && entry.paramsHash === hash) entry.geometry = geometry;
  return geometry;
}

// 写入/覆盖部件缓存;hash 变化时释放旧 geometry 防显存泄漏
function cachePart(partName: string, bytes: ArrayBuffer, hash: string, replaceSameHash = false) {
  stlCache.value = cacheStlPart(stlCache.value, partName, bytes, hash, replaceSameHash, releaseGeometry);
}

function canCacheResult(hash: string, generation: number) {
  return !disposed && generation === cacheGeneration && store.pythonDetected && hasData.value && paramsHash() === hash;
}

const pendingParts = new Map<string, { promise: Promise<void>; kind: "preview" | "preload" }>();
function cancelPreviewTasks(kinds: Array<"preview" | "preload" | "metrics">, interrupt = false) {
  generationTasks.cancel(kinds, interrupt);
  for (const [key, pending] of pendingParts) {
    if (kinds.includes(pending.kind)) pendingParts.delete(key);
  }
}

function ensurePart(part: PartName, generation: number, params: ReturnType<typeof buildScadParams>, force = false, background = false) {
  const hash = partHash(part, params);
  const key = `${generation}:${hash}:${part}`;
  const pending = pendingParts.get(key);
  if (pending) return pending.promise;
  if (!force && stlCache.value[part]?.paramsHash === hash) return Promise.resolve();
  const kind = background ? "preload" : "preview";
  const request = generationTasks.run<ArrayBuffer>("generate_stl", { params, part: PART_TO_RUST[part] }, kind).then(bytes => {
    if (!disposed && generation === cacheGeneration && store.pythonDetected && hasData.value && partHash(part) === hash) cachePart(part, bytes, hash, force);
  }).finally(() => {
    if (pendingParts.get(key)?.promise === request) pendingParts.delete(key);
  });
  pendingParts.set(key, { promise: request, kind });
  return request;
}

function applyAssembly() {
  if (!pcbEnvironment && renderer.value) {
    const room = new RoomEnvironment();
    const generator = new THREE.PMREMGenerator(renderer.value);
    pcbEnvironment = generator.fromScene(room, 0.06);
    room.dispose();
    generator.dispose();
  }
  const group = buildJigAssembly({
    insert: getOrParseGeometry("insert", stlCache.value.insert.bytes, stlCache.value.insert.paramsHash),
    base: getOrParseGeometry("base", stlCache.value.base.bytes, stlCache.value.base.paramsHash),
    cover: getOrParseGeometry("cover", stlCache.value.cover.bytes, stlCache.value.cover.paramsHash),
  }, { ...store.config, screwPositions: store.screwPositions, environmentMap: pcbEnvironment?.texture });
  const entering = !currentAssembly.value;
  setMeasureMode(false);
  disposeMesh();
  scene.value?.add(group);
  currentAssembly.value = group;
  setJigVisibility(group, showAssemblyPcb.value, showAssemblyStencil.value);
  displayedExplosion = explosionPercent.value / 100;
  explosionFrameTime = null;
  if (entering && camera.value && controls.value) {
    // Frame the full travel once, so dragging never moves the camera or clips
    // the raised screws. Keep the user's orbit/zoom on parameter refreshes.
    setJigExplosion(group, 1);
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    const cam = camera.value;
    const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * Math.min(cam.aspect, 1));
    controls.value.target.copy(center);
    cam.position.copy(center).addScaledVector(new THREE.Vector3(120, 80, 150).normalize(), radius / Math.sin(halfFov) * 1.12);
    controls.value.update();
  }
  setJigExplosion(group, displayedExplosion);
  invalidate();
}

// 把 geometry 应用到 mesh(独立函数,缓存命中时直接用)
function applyStlToMesh(geometry: THREE.BufferGeometry) {

  // 部件配色:insert=青瓷绿(品牌主部件)、base=石板蓝、cover=琥珀、
  // 钢网顶层=琥珀、底层=石板蓝(与 tab 色标一致)
  const color =
    activePart.value === "base" || activePart.value === "stencil_bottom"
      ? 0x4C6F94
      : activePart.value === "insert"
      ? 0x5A9B7F
      : 0xD9913D;
  const material = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.7,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // 让模型坐在地板上
  geometry.computeBoundingBox();
  if (geometry.boundingBox) {
    const center = geometry.boundingBox.getCenter(new THREE.Vector3());
    mesh.position.x = -center.x;
    mesh.position.z = -center.z;
    mesh.position.y = -geometry.boundingBox.min.y;
  }

  disposeMesh();
  if (scene.value) scene.value.add(mesh);
  currentMesh.value = mesh;
  resetTopology(); // 新几何 → 拓扑缓存与测量状态作废
  invalidate();
}

// ---------------------------------------------------------------------------
// 测量工具(按 PrusaSlicer/Bambu Studio 的 Measure gizmo 源码实现):
// - 几何识别:三角面按"法向相同 + 共边"聚成平面簇(BFS,法向分量差<0.001),
//   簇边界=可选的"边"(共线段合并成整条);边界闭环拟合成圆=孔缘"圆"特征;
//   悬停命中三角面 → 整个平面高亮,靠近边界 → 选边,靠近顶点 → 选顶点
// - 选择状态机(同 Bambu):点击同一特征=取消;两个都选时点第 1 个=第 2 个提升为第 1 个;
//   点新特征=替换第 2 个;面板上每个选中对象可单独 ✕ 删除后重选
// - 点-点测量画三色直角三角形:直线(绿)/水平(琥珀)/垂直(蓝);
//   点-边/点-面画垂线;边-边画公垂线段;其余组合在面板给数值
// ---------------------------------------------------------------------------
const MEASURE_HOVER_OPACITY = 0.45;

// 可选特征:顶点 / 边(共线合并后的整条) / 圆(孔缘) / 平面(共面簇)
interface MeasureFeature {
  kind: "point" | "edge" | "circle" | "plane";
  id: string;              // 特征唯一 id(判"同一特征"用)
  // point
  pos?: THREE.Vector3;
  // edge:整条边的端点(通常 2 个;共线合并后仍是直线段)
  edgePts?: THREE.Vector3[];
  // circle
  center?: THREE.Vector3;
  radius?: number;
  circlePts?: THREE.Vector3[]; // 闭环采样点(画环用)
  // plane
  planeTris?: Float32Array;     // 簇三角形的扁平顶点(画高亮叠层用,世界坐标)
  planeOutline?: THREE.Vector3[]; // 簇边界顶点序列(画轮廓用)
  planeNormal?: THREE.Vector3;
  planeArea?: number;
}

// 三色距离线配色:直线/水平/垂直各一种颜色(同拓竹)
type MeasureColorKey = "direct" | "horizontal" | "vertical";
const MEASURE_COLORS: Record<MeasureColorKey, number> = {
  direct: 0x15a877, // 直线距离:绿
  horizontal: 0xd9913d, // 水平距离(XZ 平面):琥珀
  vertical: 0x4c6f94, // 垂直距离(Y 轴):石板蓝
};

// 面板中的测量结果行
interface MeasureRow {
  label: string;
  value: string;
}

// 锚定标签:挂在某条测量线的中点,随相机投影移动
interface MeasureLabel {
  id: string;
  text: string;
  kind: MeasureColorKey;
  anchorWorld: THREE.Vector3;
  x: number; y: number;
}

const measureMode = ref(false);
// 两个选中特征 + 各自的面板行(类型徽标 + 几何信息)
const selA = shallowRef<MeasureFeature | null>(null);
const selB = shallowRef<MeasureFeature | null>(null);
let hoverFeature: MeasureFeature | null = null;
const measureRows = ref<MeasureRow[]>([]);
const measureTags = ref<MeasureLabel[]>([]);
const measureGroup = shallowRef<THREE.Group | null>(null);

// 特征的面板描述(类型名 + 几何信息行)
function featureKindLabel(f: MeasureFeature): string {
  switch (f.kind) {
    case "point": return t("preview.measurePoint");
    case "edge": return t("preview.measureEdge");
    case "circle": return t("preview.measureCircle");
    default: return t("preview.measurePlane");
  }
}
function featureInfo(f: MeasureFeature): string {
  switch (f.kind) {
    case "point":
      return `X ${fmtMm(f.pos!.x)} · Y ${fmtMm(f.pos!.y)} · Z ${fmtMm(f.pos!.z)}`;
    case "edge":
      return `${t("preview.measureLength")} ${fmtMm(edgeLength(f))} mm`;
    case "circle":
      return `Ø ${fmtMm(f.radius! * 2)} mm · R ${fmtMm(f.radius!)} mm`;
    default:
      return `${t("preview.measureArea")} ${fmtMm(f.planeArea!)} mm²`;
  }
}
function edgeLength(f: MeasureFeature): number {
  const p = f.edgePts!;
  return p[0].distanceTo(p[p.length - 1]);
}

// 每种颜色的成套材质(实线/虚线/实心球/半透明球),懒创建,clearMeasure 统一释放
interface MeasureMatSet {
  dot: THREE.MeshBasicMaterial;
  dotDim: THREE.MeshBasicMaterial;
  line: THREE.LineBasicMaterial;
  dash: THREE.LineDashedMaterial;
  overlay: THREE.MeshBasicMaterial;      // 平面高亮叠层(半透明)
  overlayDim: THREE.MeshBasicMaterial;   // 悬停平面叠层(更淡)
}
let measureMats: Record<MeasureColorKey, MeasureMatSet> | null = null;

function makeMeasureMatSet(color: number, span: number): MeasureMatSet {
  return {
    dot: new THREE.MeshBasicMaterial({ color }),
    dotDim: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: MEASURE_HOVER_OPACITY }),
    line: new THREE.LineBasicMaterial({ color }),
    dash: new THREE.LineDashedMaterial({
      color,
      dashSize: Math.max(span * 0.008, 0.8),
      gapSize: Math.max(span * 0.006, 0.6),
    }),
    overlay: new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.32,
      side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    overlayDim: new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
  };
}

function disposeMeasureMatSet(set: MeasureMatSet) {
  set.dot.dispose();
  set.dotDim.dispose();
  set.line.dispose();
  set.dash.dispose();
  set.overlay.dispose();
  set.overlayDim.dispose();
}

function getMeasureMats(span: number): Record<MeasureColorKey, MeasureMatSet> {
  if (measureMats) return measureMats;
  measureMats = {
    direct: makeMeasureMatSet(MEASURE_COLORS.direct, span),
    horizontal: makeMeasureMatSet(MEASURE_COLORS.horizontal, span),
    vertical: makeMeasureMatSet(MEASURE_COLORS.vertical, span),
  };
  return measureMats;
}

const raycaster = new THREE.Raycaster();
const ndcPoint = new THREE.Vector2();

// mesh 拓扑缓存:STL 是三角形 soup(顶点重复),先按位置合并顶点再建边表,
// 悬停时才能把"命中三角形的一条边"还原成整条几何边
// 特征库(世界坐标):mesh 首次进入测量时一次性构建
interface MeasureTopology {
  verts: THREE.Vector3[];        // 合并后顶点
  triVert: Uint32Array;          // 每角对应的合并顶点索引
  clusterOf: Int32Array;         // 每三角形的簇号
  clusters: {
    tris: number[];              // 簇内三角形序号
    normal: THREE.Vector3;
    area: number;
    feature: MeasureFeature;     // 簇对应的"平面"特征
  }[];
  edgeFeatures: MeasureFeature[];   // 全部"边"特征(共线合并后)
  circleFeatures: MeasureFeature[]; // 全部"圆"特征(孔缘)
  clusterAt: MeasureFeature[];      // 簇号 → 平面特征(快速查表)
}
let topoMesh: THREE.Mesh | null = null;
let topo: MeasureTopology | null = null;

function resetTopology() {
  topoMesh = null;
  topo = null;
  invalidateScreenCache(); // 特征库已换,旧屏幕坐标不可复用
}

// 构建:顶点合并 → 共面簇 BFS(法向分量差<0.001,同 PrusaSlicer) →
// 簇边界提取 → 闭环拟合圆(孔缘) → 其余边界共线合并成边
function ensureTopology(mesh: THREE.Mesh) {
  if (topoMesh === mesh && topo) return;
  mesh.updateMatrixWorld();
  const attr = mesh.geometry.getAttribute("position");
  const count = attr.count;
  const triCount = count / 3;

  // 1) 合并重复顶点(世界坐标)
  const mergeMap = new Map<string, number>();
  const verts: THREE.Vector3[] = [];
  const triVert = new Uint32Array(count);
  {
    const v = new THREE.Vector3();
    const w = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(attr as THREE.BufferAttribute, i);
      w.copy(v).applyMatrix4(mesh.matrixWorld);
      // 1μm 精度合并:CAD 导出的 STL 同一顶点浮点完全一致,3 位小数足够
      const key = `${Math.round(w.x * 1000)},${Math.round(w.y * 1000)},${Math.round(w.z * 1000)}`;
      let idx = mergeMap.get(key);
      if (idx === undefined) {
        idx = verts.length;
        verts.push(w.clone());
        mergeMap.set(key, idx);
      }
      triVert[i] = idx;
    }
  }

  // 2) 邻接:边 key → 两侧三角形(带方向)
  const edgeTris = new Map<number, number[]>();
  const edgeKey = (p: number, q: number) => (p < q ? p * count + q : q * count + p);
  for (let f = 0; f < count; f += 3) {
    const ia = triVert[f], ib = triVert[f + 1], ic = triVert[f + 2];
    const t = f / 3;
    for (const [p, q] of [[ia, ib], [ib, ic], [ic, ia]] as const) {
      const k = edgeKey(p, q);
      const arr = edgeTris.get(k);
      if (arr) arr.push(t);
      else edgeTris.set(k, [t]);
    }
  }

  // 3) 三角形法向
  const normals: THREE.Vector3[] = [];
  {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let f = 0; f < count; f += 3) {
      a.copy(verts[triVert[f]]);
      b.copy(verts[triVert[f + 1]]);
      c.copy(verts[triVert[f + 2]]);
      normals.push(
        new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize(),
      );
    }
  }

  // 4) 共面簇 BFS:与种子法向逐分量差 < 0.001 的邻接三角形并入
  const clusterOf = new Int32Array(triCount).fill(-1);
  const clusters: MeasureTopology["clusters"] = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (clusterOf[seed] >= 0) continue;
    const ci = clusters.length;
    const n = normals[seed];
    const queue = [seed];
    clusterOf[seed] = ci;
    const tris: number[] = [];
    while (queue.length) {
      const t = queue.pop()!;
      tris.push(t);
      const f = t * 3;
      for (let e = 0; e < 3; e++) {
        const p = triVert[f + e], q = triVert[f + (e + 1) % 3];
        const neighbors = edgeTris.get(edgeKey(p, q));
        if (!neighbors) continue;
        for (const nt of neighbors) {
          if (clusterOf[nt] >= 0) continue;
          const nn = normals[nt];
          if (
            Math.abs(nn.x - n.x) < 0.001 &&
            Math.abs(nn.y - n.y) < 0.001 &&
            Math.abs(nn.z - n.z) < 0.001
          ) {
            clusterOf[nt] = ci;
            queue.push(nt);
          }
        }
      }
    }
    // 面积(簇内三角形面积和)
    let area = 0;
    for (const t of tris) {
      const f = t * 3;
      const a = verts[triVert[f]], b = verts[triVert[f + 1]], c = verts[triVert[f + 2]];
      area += new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;
    }
    clusters.push({ tris, normal: n.clone(), area, feature: null as never });
  }

  // 5) 簇边界段:边两侧三角形异簇(或开边界)。归每个相邻簇所有。
  //    borderSegs[ci] = Set<edgeKey>
  const borderSegsByCluster: Array<Set<number>> = clusters.map(() => new Set<number>());
  for (const [k, tris] of edgeTris) {
    if (tris.length === 2 && clusterOf[tris[0]] === clusterOf[tris[1]]) continue;
    for (const t of tris) borderSegsByCluster[clusterOf[t]].add(k);
  }

  // 6) 每簇:边界环拟合圆(≥6 点,圆度偏差 < max(0.05mm, r*2%)) → 圆特征;
  //    其余边界段做共线合并(转角 < 1.5°) → 边特征
  const edgeFeatures: MeasureFeature[] = [];
  const circleFeatures: MeasureFeature[] = [];
  clusters.forEach((_cl, ci) => {
    const segs = borderSegsByCluster[ci];
    if (!segs.size) return;

    // 顶点 → 邻接段(本簇边界内)
    const adj = new Map<number, number[]>();
    for (const k of segs) {
      const p = Math.floor(k / count), q = k % count;
      (adj.get(p) ?? adj.set(p, []).get(p)!).push(k);
      (adj.get(q) ?? adj.set(q, []).get(q)!).push(k);
    }

    // 段消耗标记;环:从任意未访问段沿邻接走,回到起点即闭环
    const consumed = new Set<number>();
    const loopOf = (startKey: number): number[] | null => {
      const startP = Math.floor(startKey / count);
      const path: number[] = [startKey];
      consumed.add(startKey);
      let cur = startKey % count;
      let guard = 0;
      while (cur !== startP) {
        const nexts = (adj.get(cur) ?? []).filter((k) => !consumed.has(k));
        if (nexts.length !== 1) {
          // 分叉/断头:释放本路径的消耗标记,回退给共线合并
          for (const k of path) consumed.delete(k);
          return null;
        }
        const nk = nexts[0];
        consumed.add(nk);
        path.push(nk);
        const p = Math.floor(nk / count);
        cur = cur === p ? nk % count : p; // 走向另一端
        if (++guard > 100000) {
          for (const k of path) consumed.delete(k);
          return null;
        }
      }
      return path;
    };

    // 圆检测(整环):环上所有顶点到质心距离一致
    const tryCircle = (keys: number[]): boolean => {
      const pts: THREE.Vector3[] = [];
      const seenV = new Set<number>();
      for (const k of keys) {
        for (const vi of [Math.floor(k / count), k % count]) {
          if (!seenV.has(vi)) {
            seenV.add(vi);
            pts.push(verts[vi]);
          }
        }
      }
      if (pts.length < 6) return false;
      const center = new THREE.Vector3();
      for (const p of pts) center.add(p);
      center.divideScalar(pts.length);
      let rSum = 0;
      for (const p of pts) rSum += p.distanceTo(center);
      const r = rSum / pts.length;
      if (r < 0.2) return false;
      let maxDev = 0;
      for (const p of pts) maxDev = Math.max(maxDev, Math.abs(p.distanceTo(center) - r));
      if (maxDev > Math.max(0.05, r * 0.02)) return false;
      circleFeatures.push({
        kind: "circle",
        id: `c${ci}_${circleFeatures.length}`,
        center,
        radius: r,
        circlePts: pts,
      });
      return true;
    };

    // 先找闭环 → 试圆;成圆则整环消耗,不成圆释放段做共线合并
    const loops: number[][] = [];
    for (const k of segs) {
      if (consumed.has(k)) continue;
      const loop = loopOf(k);
      if (loop) loops.push(loop);
    }
    for (const loop of loops) {
      if (!tryCircle(loop)) {
        for (const k of loop) consumed.delete(k);
      }
    }

    // 剩余未消耗段:共线合并成折线(同簇边界,转角 < 1.5° 视为共线)
    const remainingSet = new Set([...segs].filter((k) => !consumed.has(k)));
    const used = new Set<number>();
    const dirOf = (k: number) => {
      const p = verts[Math.floor(k / count)], q = verts[k % count];
      return new THREE.Vector3().subVectors(q, p);
    };
    const walkPolyline = (startKey: number, startVert: number): THREE.Vector3[] => {
      const pts = [verts[startVert]];
      let curKey = startKey;
      let curVert = startVert;
      used.add(curKey);
      let guard = 0;
      for (;;) {
        const p = Math.floor(curKey / count), q = curKey % count;
        const nextVert = curVert === p ? q : p;
        pts.push(verts[nextVert]);
        const nexts = (adj.get(nextVert) ?? []).filter(
          (k) => !used.has(k) && remainingSet.has(k),
        );
        if (nexts.length !== 1) break;
        const nk = nexts[0];
        const d1 = dirOf(curKey).normalize();
        const d2 = dirOf(nk);
        const d2n = d2.clone().normalize();
        // 共线:夹角 ≈ 0 或 180°(叉积模长小于 sin(1.5°))
        if (d1.clone().cross(d2n).length() > 0.0262) break;
        // 且不能走回头路(方向点积必须同号或反向连续,由端点推进保证)
        used.add(nk);
        curKey = nk;
        curVert = nextVert;
        if (++guard > 100000) break;
      }
      return pts;
    };
    for (const k of remainingSet) {
      if (used.has(k)) continue;
      const p = Math.floor(k / count);
      const pts = walkPolyline(k, p);
      if (pts.length >= 2 && pts[0].distanceTo(pts[pts.length - 1]) > 0.05) {
        edgeFeatures.push({
          kind: "edge",
          id: `e${ci}_${edgeFeatures.length}`,
          edgePts: pts,
        });
      }
    }
  });

  // 7) 平面特征(含高亮叠层几何与轮廓)
  const clusterAt: MeasureFeature[] = [];
  clusters.forEach((cl, ci) => {
    const trisFlat = new Float32Array(cl.tris.length * 9);
    let o = 0;
    for (const t of cl.tris) {
      for (let e = 0; e < 3; e++) {
        const v = verts[triVert[t * 3 + e]];
        trisFlat[o++] = v.x;
        trisFlat[o++] = v.y;
        trisFlat[o++] = v.z;
      }
    }
    const outline: THREE.Vector3[] = [];
    for (const k of borderSegsByCluster[ci]) {
      const p = verts[Math.floor(k / count)], q = verts[k % count];
      outline.push(p, q);
    }
    const feature: MeasureFeature = {
      kind: "plane",
      id: `p${ci}`,
      planeTris: trisFlat,
      planeOutline: outline,
      planeNormal: cl.normal,
      planeArea: cl.area,
    };
    cl.feature = feature;
    clusterAt.push(feature);
  });

  topoMesh = mesh;
  topo = { verts, triVert, clusterOf, clusters, edgeFeatures, circleFeatures, clusterAt };
}

function fmtMm(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function disposeMeasureGroup() {
  if (measureGroup.value) {
    scene.value?.remove(measureGroup.value);
    // 共享几何(dotGeo)会被多个 mesh 引用,去重后只 dispose 一次
    const disposed = new Set<THREE.BufferGeometry>();
    measureGroup.value.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g && !disposed.has(g)) {
        disposed.add(g);
        g.dispose();
      }
    });
    measureGroup.value = null;
  }
}

function disposeMeasureMats() {
  if (!measureMats) return;
  for (const set of Object.values(measureMats)) disposeMeasureMatSet(set);
  measureMats = null;
  disposeSelMats();
}

function clearMeasure() {
  disposeMeasureGroup();
  disposeMeasureMats();
  selA.value = null;
  selB.value = null;
  hoverFeature = null;
  measureRows.value = [];
  measureTags.value = [];
  invalidate();
}

function setMeasureMode(on: boolean) {
  clearMeasure();
  measureMode.value = on;
  if (on) errorMsg.value = null;
}

// 面板 ✕:删除第 1/第 2 个选中对象(删第 1 个时把第 2 个提升上来)
function removeSelection(which: 1 | 2) {
  if (which === 1) {
    selA.value = selB.value;
    selB.value = null;
  } else {
    selB.value = null;
  }
  rebuildMeasureVisuals();
}

// 点击选择状态机(同 Bambu Studio):
// 未选 → 选 A;只选 A:同一特征=取消 A,否则选 B;
// 两个都选:点 A=B 提升为 A;点 B=取消 B;点新特征=B 替换
function applyFeatureClick(f: MeasureFeature) {
  if (!selA.value) {
    selA.value = f;
  } else if (!selB.value) {
    if (selA.value.id === f.id) selA.value = null;
    else selB.value = f;
  } else {
    if (selA.value.id === f.id) {
      selA.value = selB.value;
      selB.value = null;
    } else if (selB.value.id === f.id) {
      selB.value = null;
    } else {
      selB.value = f;
    }
  }
  rebuildMeasureVisuals();
}

// 依据 selA/selB/hover 重建全部测量可视化(特征高亮 + 测量线)与标签/面板行
// 选中对象配色:A=橙,B=蓝(悬停仍是绿)
const SEL_A_COLOR = 0xe07a3c;
const SEL_B_COLOR = 0x4c8fd6;
// 每个"选中槽位"的成套材质,懒创建,clearMeasure 统一释放
const selMats: Record<"a" | "b", MeasureMatSet | null> = { a: null, b: null };
function getSelMats(slot: "a" | "b", span: number): MeasureMatSet {
  if (!selMats[slot]) {
    selMats[slot] = makeMeasureMatSet(slot === "a" ? SEL_A_COLOR : SEL_B_COLOR, span);
  }
  return selMats[slot]!;
}
function disposeSelMats() {
  for (const k of ["a", "b"] as const) {
    if (selMats[k]) {
      disposeMeasureMatSet(selMats[k]!);
      selMats[k] = null;
    }
  }
}

function rebuildMeasureVisuals() {
  const s = scene.value;
  if (!s) return;
  disposeMeasureGroup();

  const mesh = currentMesh.value;
  const span = mesh
    ? Math.max(new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3()).length(), 1)
    : 100;
  const dotR = Math.max(span * 0.004, 0.4);
  const mats = getMeasureMats(span);
  const set = mats.direct;

  const g = new THREE.Group();
  const labels: MeasureLabel[] = [];
  // 悬停切换会高频重建本 Group:所有标记球共享一个 SphereGeometry,
  // 避免每次悬停都 new N 个几何(释放见 disposeMeasureGroup 的去重 Set)
  const dotGeo = new THREE.SphereGeometry(dotR, 14, 10);
  const addDot = (p: THREE.Vector3, mat: THREE.MeshBasicMaterial) => {
    const dot = new THREE.Mesh(dotGeo, mat);
    dot.position.copy(p);
    g.add(dot);
  };
  const addLine = (a: THREE.Vector3, b: THREE.Vector3, mat: THREE.LineBasicMaterial) => {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    g.add(new THREE.Line(geo, mat));
  };
  const addPolyline = (pts: THREE.Vector3[], mat: THREE.LineBasicMaterial) => {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    g.add(new THREE.Line(geo, mat));
  };

  // 单个特征的高亮绘制:mats 指定配色(悬停=淡绿,A=橙,B=蓝)
  const drawFeature = (f: MeasureFeature, fSet: MeasureMatSet, dim: boolean) => {
    const overlayMat = dim ? fSet.overlayDim : fSet.overlay;
    const lineMat = fSet.line;
    const dotMat = dim ? fSet.dotDim : fSet.dot;
    switch (f.kind) {
      case "point":
        addDot(f.pos!, dotMat);
        break;
      case "edge": {
        const pts = f.edgePts!;
        if (pts.length === 2) addLine(pts[0], pts[1], lineMat);
        else addPolyline(pts, lineMat);
        addDot(pts[0], dotMat);
        addDot(pts[pts.length - 1], dotMat);
        break;
      }
      case "circle": {
        // 环:用闭环点 + 闭合回起点
        const pts = [...f.circlePts!, f.circlePts![0]];
        addPolyline(pts, lineMat);
        break;
      }
      case "plane": {
        // 平面:三角形叠层高亮 + 边界轮廓
        if (f.planeTris) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(f.planeTris, 3));
          g.add(new THREE.Mesh(geo, overlayMat));
        }
        if (f.planeOutline && f.planeOutline.length >= 2) {
          const geo = new THREE.BufferGeometry().setFromPoints(f.planeOutline);
          g.add(new THREE.LineSegments(geo, lineMat));
        }
        break;
      }
    }
  };

  if (hoverFeature) drawFeature(hoverFeature, set, true);
  if (selA.value) drawFeature(selA.value, getSelMats("a", span), false);
  if (selB.value) drawFeature(selB.value, getSelMats("b", span), false);

  // 成对测量:返回 3D 线段(画出来 + 挂标签)与面板行
  const pair = computePair(selA.value, selB.value);
  for (const line of pair.lines) {
    addLine(line.a, line.b, mats[line.kind].line);
    addDot(line.a, mats[line.kind].dot);
    addDot(line.b, mats[line.kind].dot);
    labels.push({
      id: line.id,
      text: `${line.label} ${fmtMm(line.a.distanceTo(line.b))} mm`,
      kind: line.kind,
      anchorWorld: line.a.clone().add(line.b).multiplyScalar(0.5),
      x: 0, y: 0,
    });
  }
  measureRows.value = pair.rows;
  measureTags.value = labels;

  if (hoverFeature || selA.value || selB.value || pair.lines.length) {
    s.add(g);
    measureGroup.value = g;
  }
  updateMeasureTags();
  invalidate();
}

// 标签位置刷新:锚定标签做 3D 投影(每帧渲染时调用)
function updateMeasureTags() {
  const cam = camera.value;
  const el = containerEl.value;
  if (!cam || !el) return;
  for (const tag of measureTags.value) {
    const v = tag.anchorWorld.clone().project(cam);
    tag.x = (v.x * 0.5 + 0.5) * el.clientWidth;
    tag.y = (-v.y * 0.5 + 0.5) * el.clientHeight;
  }
}

// ---------------------------------------------------------------------------
// 成对测量:两个特征间的 3D 测量线(带标签)与面板结果行
// 圆在测量中按"圆心点"参与;平面按"点在面上投影/法向夹角"参与
// ---------------------------------------------------------------------------
interface PairLine {
  id: string;
  label: string;
  kind: MeasureColorKey;
  a: THREE.Vector3;
  b: THREE.Vector3;
}

// 点到线段的最近点(含参数)
function closestOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): { point: THREE.Vector3; t: number } {
  const ab = new THREE.Vector3().subVectors(b, a);
  const len2 = ab.lengthSq();
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, new THREE.Vector3().subVectors(p, a).dot(ab) / len2));
  return { point: a.clone().lerp(b, t), t };
}

// 线段-线段最近点对(标准算法)
function closestSegSeg(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const d1 = new THREE.Vector3().subVectors(q1, p1);
  const d2 = new THREE.Vector3().subVectors(q2, p2);
  const r = new THREE.Vector3().subVectors(p1, p2);
  const a = d1.lengthSq(), e = d2.lengthSq(), f = d2.dot(r);
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) return [p1.clone(), p2.clone()];
  if (a <= 1e-12) t = Math.max(0, Math.min(1, f / e));
  else {
    const c = d1.dot(r);
    if (e <= 1e-12) s = Math.max(0, Math.min(1, -c / a));
    else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  return [p1.clone().add(d1.multiplyScalar(s)), p2.clone().add(d2.clone().multiplyScalar(t))];
}

// 特征的"锚点":点→自身;圆→圆心;边→屏幕最近点(无法确定时取中点);平面→面上最近点
function featureAnchor(f: MeasureFeature, hint?: THREE.Vector3): THREE.Vector3 {
  switch (f.kind) {
    case "point": return f.pos!;
    case "circle": return f.center!;
    case "edge": {
      const pts = f.edgePts!;
      const a = pts[0], b = pts[pts.length - 1];
      if (hint) return closestOnSegment(hint, a, b).point;
      return a.clone().add(b).multiplyScalar(0.5);
    }
    default: return hint ? hint.clone() : new THREE.Vector3();
  }
}

function computePair(a: MeasureFeature | null, b: MeasureFeature | null): { lines: PairLine[]; rows: MeasureRow[] } {
  const lines: PairLine[] = [];
  const rows: MeasureRow[] = [];
  if (!a || !b) return { lines, rows };

  // 点-点(圆按圆心):三色直角三角形 + Δ 行
  if ((a.kind === "point" || a.kind === "circle") && (b.kind === "point" || b.kind === "circle")) {
    const pa = featureAnchor(a), pb = featureAnchor(b);
    const d = new THREE.Vector3().subVectors(pb, pa);
    lines.push({ id: "direct", label: t("preview.measureDirect"), kind: "direct", a: pa, b: pb });
    const horizontal = Math.hypot(d.x, d.z);
    const vertical = Math.abs(d.y);
    if (horizontal > 0.05 && vertical > 0.05) {
      const corner = new THREE.Vector3(pb.x, pa.y, pb.z);
      lines.push({ id: "horizontal", label: t("preview.measureHorizontal"), kind: "horizontal", a: pa, b: corner });
      lines.push({ id: "vertical", label: t("preview.measureVertical"), kind: "vertical", a: corner, b: pb });
    }
    rows.push({ label: t("preview.measureDirect"), value: `${fmtMm(d.length())} mm` });
    if (horizontal > 0.05) rows.push({ label: t("preview.measureHorizontal"), value: `${fmtMm(horizontal)} mm` });
    if (vertical > 0.05) rows.push({ label: t("preview.measureVertical"), value: `${fmtMm(vertical)} mm` });
    rows.push({ label: "ΔX", value: `${fmtMm(Math.abs(d.x))} mm` });
    rows.push({ label: "ΔY", value: `${fmtMm(Math.abs(d.y))} mm` });
    rows.push({ label: "ΔZ", value: `${fmtMm(Math.abs(d.z))} mm` });
    return { lines, rows };
  }

  // 点-边(或 圆心-边):垂线段 + 距离
  const pointish = (f: MeasureFeature) => f.kind === "point" || f.kind === "circle";
  if (pointish(a) && b.kind === "edge") {
    const p = featureAnchor(a);
    const foot = closestOnSegment(p, b.edgePts![0], b.edgePts![b.edgePts!.length - 1]);
    lines.push({ id: "dist", label: t("preview.measureDistance"), kind: "direct", a: p, b: foot.point });
    rows.push({ label: t("preview.measureDistance"), value: `${fmtMm(p.distanceTo(foot.point))} mm` });
    return { lines, rows };
  }
  if (a.kind === "edge" && pointish(b)) {
    return computePair(b, a);
  }

  // 点-面(或 圆心-面):点到面的垂线段 + 距离
  if (pointish(a) && b.kind === "plane") {
    const p = featureAnchor(a);
    const n = b.planeNormal!;
    // 平面上任一点:轮廓第一点
    const p0 = b.planeOutline![0];
    const dist = new THREE.Vector3().subVectors(p, p0).dot(n);
    const foot = p.clone().sub(n.clone().multiplyScalar(dist));
    lines.push({ id: "dist", label: t("preview.measureDistance"), kind: "direct", a: p, b: foot });
    rows.push({ label: t("preview.measureDistance"), value: `${fmtMm(Math.abs(dist))} mm` });
    return { lines, rows };
  }
  if (a.kind === "plane" && pointish(b)) {
    return computePair(b, a);
  }

  // 边-边:公垂线段 + 距离;不平行再给夹角
  if (a.kind === "edge" && b.kind === "edge") {
    const [pa, pb] = closestSegSeg(
      a.edgePts![0], a.edgePts![a.edgePts!.length - 1],
      b.edgePts![0], b.edgePts![b.edgePts!.length - 1],
    );
    lines.push({ id: "dist", label: t("preview.measureDistance"), kind: "direct", a: pa, b: pb });
    rows.push({ label: t("preview.measureDistance"), value: `${fmtMm(pa.distanceTo(pb))} mm` });
    const d1 = new THREE.Vector3().subVectors(a.edgePts![a.edgePts!.length - 1], a.edgePts![0]).normalize();
    const d2 = new THREE.Vector3().subVectors(b.edgePts![b.edgePts!.length - 1], b.edgePts![0]).normalize();
    const angleDeg = (Math.acos(Math.min(1, Math.abs(d1.dot(d2)))) * 180) / Math.PI;
    rows.push({ label: t("preview.measureAngle"), value: `${fmtMm(angleDeg)}°` });
    return { lines, rows };
  }

  // 边-面:边与面的夹角(边方向与面法向夹角的余角);平行时给距离
  if (a.kind === "edge" && b.kind === "plane") {
    const d = new THREE.Vector3().subVectors(a.edgePts![a.edgePts!.length - 1], a.edgePts![0]).normalize();
    const n = b.planeNormal!;
    const sinA = Math.abs(d.dot(n));
    const angleDeg = (Math.asin(Math.min(1, sinA)) * 180) / Math.PI;
    rows.push({ label: t("preview.measureAngle"), value: `${fmtMm(angleDeg)}°` });
    if (sinA < 0.017) {
      // 平行:给边到面的距离
      const p0 = b.planeOutline![0];
      const dist = Math.abs(new THREE.Vector3().subVectors(a.edgePts![0], p0).dot(n));
      rows.push({ label: t("preview.measureDistance"), value: `${fmtMm(dist)} mm` });
    }
    return { lines, rows };
  }
  if (a.kind === "plane" && b.kind === "edge") {
    return computePair(b, a);
  }

  // 面-面:法向夹角;平行时给间距
  if (a.kind === "plane" && b.kind === "plane") {
    const n1 = a.planeNormal!, n2 = b.planeNormal!;
    const cosA = Math.min(1, Math.abs(n1.dot(n2)));
    const angleDeg = (Math.acos(cosA) * 180) / Math.PI;
    if (angleDeg < 1) {
      const p1 = a.planeOutline![0], p2 = b.planeOutline![0];
      const dist = Math.abs(new THREE.Vector3().subVectors(p2, p1).dot(n1));
      rows.push({ label: t("preview.measureDistance"), value: `${fmtMm(dist)} mm` });
    } else {
      rows.push({ label: t("preview.measureAngle"), value: `${fmtMm(angleDeg)}°` });
    }
    return { lines, rows };
  }

  // 圆-圆 / 圆-边 / 圆-面:圆心按点处理(上面分支已覆盖 point/circle 混合,
  // 仅剩 circle-circle 走点-点,circle-edge 走点-边,circle-plane 走点-面,均已包含)
  return { lines, rows };
}

// 屏幕空间点到线段的最近距离与参数 t
function screenSegClosest(ax: number, ay: number, bx: number, by: number, px: number, py: number) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const tt = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return { dist: Math.hypot(px - (ax + tt * dx), py - (ay + tt * dy)), t: tt };
}

// 特征拾取(同 PrusaSlicer 优先级):顶点(12px) > 圆环(10px) > 边(10px) > 平面
function pickFeature(ev: PointerEvent): MeasureFeature | null {
  const mesh = currentMesh.value;
  const cam = camera.value;
  const canvas = canvasEl.value;
  if (!mesh || !cam || !canvas) return null;

  const rect = canvas.getBoundingClientRect();
  const localX = ev.clientX - rect.left;
  const localY = ev.clientY - rect.top;
  ndcPoint.set((localX / rect.width) * 2 - 1, -(localY / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndcPoint, cam);
  const hits = raycaster.intersectObject(mesh, false);
  if (hits.length === 0) return null;

  ensureTopology(mesh);
  const T = topo!;
  const hit = hits[0];
  const face = hit.face;
  if (!face) return null;

  const toScreen = (v: THREE.Vector3) => {
    const p = v.clone().project(cam);
    return { x: (p.x * 0.5 + 0.5) * rect.width, y: (-p.y * 0.5 + 0.5) * rect.height };
  };

  // 1) 顶点:命中三角形的 3 个顶点(合并索引)
  const triIdx = [face.a, face.b, face.c].map((i) => T.triVert[i]);
  let bestVert: { vi: number; d: number } | null = null;
  for (const vi of triIdx) {
    const sp = toScreen(T.verts[vi]);
    const d = Math.hypot(sp.x - localX, sp.y - localY);
    if (d <= 12 && (!bestVert || d < bestVert.d)) bestVert = { vi, d };
  }
  if (bestVert) {
    return { kind: "point", id: `v${bestVert.vi}`, pos: T.verts[bestVert.vi].clone() };
  }

  // 2) 边与圆:遍历特征库,屏幕空间最近者胜。
  //    投影结果按"相机+视口签名"缓存:鼠标扫过而相机静止时(最常见的悬停场景)
  //    跳过全部特征点的重复 project() 调用,只做距离比较
  const screens = getFeatureScreens(T, cam, rect.width, rect.height);
  let best: { f: MeasureFeature; d: number } | null = null;
  const consider = (f: MeasureFeature, dist: number) => {
    if (dist <= 10 && (!best || dist < best.d)) best = { f, d: dist };
  };
  T.circleFeatures.forEach((f, fi) => {
    for (const sp of screens.circles[fi]) {
      consider(f, Math.hypot(sp.x - localX, sp.y - localY));
    }
  });
  T.edgeFeatures.forEach((f, fi) => {
    const pts = f.edgePts!;
    const sps = screens.edges[fi];
    for (let i = 0; i + 1 < pts.length; i++) {
      consider(f, screenSegClosest(sps[i].x, sps[i].y, sps[i + 1].x, sps[i + 1].y, localX, localY).dist);
    }
  });
  if (best) return (best as { f: MeasureFeature; d: number }).f;

  // 3) 平面:命中三角形所在的共面簇
  const tri = Math.floor(face.a / 3);
  return T.clusterAt[T.clusterOf[tri]];
}

// 特征点屏幕坐标缓存:相机/视口不变时复用(鼠标悬停高频调用,
// 相机每帧变化时退化为逐次重算,与无缓存等价)
interface FeatureScreens {
  edges: Array<Array<{ x: number; y: number }>>;
  circles: Array<Array<{ x: number; y: number }>>;
}
let screenCache: { sig: string; data: FeatureScreens } | null = null;

function invalidateScreenCache() {
  screenCache = null;
}

function getFeatureScreens(
  T: MeasureTopology,
  cam: THREE.PerspectiveCamera,
  w: number,
  h: number,
): FeatureScreens {
  const sig = `${cam.position.x},${cam.position.y},${cam.position.z}|${cam.quaternion.x},${cam.quaternion.y},${cam.quaternion.z},${cam.quaternion.w}|${cam.zoom}|${w}x${h}`;
  if (screenCache && screenCache.sig === sig) return screenCache.data;
  const project = (v: THREE.Vector3) => {
    const p = v.clone().project(cam);
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
  };
  const data: FeatureScreens = {
    edges: T.edgeFeatures.map((f) => f.edgePts!.map(project)),
    circles: T.circleFeatures.map((f) => f.circlePts!.map(project)),
  };
  screenCache = { sig, data };
  return data;
}

// hover 状态
function updateHover(ev: PointerEvent) {
  const next = pickFeature(ev);
  // 同一特征不重建(避免每帧重建 Group)
  if (next?.id === hoverFeature?.id) return;
  hoverFeature = next;
  rebuildMeasureVisuals();
}

// mousemove 用 rAF 合并:每帧最多一次 raycast
let hoverPending: PointerEvent | null = null;
let hoverRafId: number | null = null;

function onCanvasPointerMove(e: PointerEvent) {
  if (!measureMode.value) return;
  // 拖拽旋转中不拾取(清掉 hover,避免高亮残留)
  if (pointerDownAt && Math.hypot(e.clientX - pointerDownAt.x, e.clientY - pointerDownAt.y) > 5) {
    if (hoverFeature) {
      hoverFeature = null;
      rebuildMeasureVisuals();
    }
    return;
  }
  hoverPending = e;
  if (hoverRafId === null) {
    hoverRafId = requestAnimationFrame(() => {
      hoverRafId = null;
      const ev = hoverPending;
      hoverPending = null;
      if (ev) updateHover(ev);
    });
  }
}

// 区分「点击取点」与「拖拽旋转」:位移超过 5px 视为旋转
let pointerDownAt: { x: number; y: number } | null = null;

function onCanvasPointerDown(e: PointerEvent) {
  pointerDownAt = { x: e.clientX, y: e.clientY };
}

function onCanvasPointerUp(e: PointerEvent) {
  const start = pointerDownAt;
  pointerDownAt = null;
  if (!measureMode.value || !start) return;
  // 仅左键取点:右键(平移)/中键(缩放)的点击不算测量
  if (e.button !== 0) return;
  if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;

  // 点击时重新拾取一次(比依赖 hover 更可靠,比如鼠标静止后场景变了)
  const feat = pickFeature(e);
  if (!feat) return;
  applyFeatureClick(feat);
}

function onMeasureKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape" && measureMode.value) setMeasureMode(false);
}

// 防抖渲染(参数快速调整时)
let renderTimer: number | null = null;
function scheduleRender() {
  if (renderTimer !== null) window.clearTimeout(renderTimer);
  renderTimer = null;
  if (inspectionOpen.value) return;
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    renderCurrent();
  }, 300);
}

// 切换部件时立即渲染
watch(activePart, () => {
  setMeasureMode(false);
  renderCurrent();
});

// 参数变化 → 防抖重渲染 + 防抖后台预热
// 只跟踪 hash 相关的标量字段与数组引用(pads/outline 都是导入时整体替换,引用变化即内容变化),
// 避免 deep watch 每次改动都遍历数千焊盘造成拖动掉帧
const hashSource = computed(() => {
  const c = store.config;
  return [
    appMode.value,
    c.pcbSizeX, c.pcbSizeY, c.pcbThickness, c.pcbPocketClearance,
    c.pcbOutlinePoints, c.pcbOutlineHoles, c.stencilSizeX, c.stencilSizeY,
    c.screwSpacing, c.screwSpec, c.useHexNut, c.nutAcrossFlats, c.nutHeight, c.nutPocketClearance,
    c.baseHeight, c.topCoverHeight, c.jigSize, c.insertHeight, c.platterHeight,
    c.platterCornerRadius, c.ejectSlotWidth, c.cornerScrewD, c.postClearance,
    c.periScrewD, c.outerCornerRadius, c.stencilLip, c.windowGap,
    c.pryNotchSides, c.pryNotchScale,
    c.stencilThickness, c.padShrink, c.stencilFrameWidth, c.stencilCornerRadius,
    c.stencilFrameShape, c.pocketClearance,
    c.stencilTaper, c.stencilStagger, c.stencilStaggerGap, c.stencilStaggerOffset,
    c.stencilFilterTestPoints, c.stencilTestPointMaxDia, c.stencilTestPointIsolation,
    c.stencilGrid, c.stencilGridSize, c.stencilGridBar,
    c.stencilPadsTop, c.stencilPadsBottom,
  ];
});

// 参数稳定 1.2s 后后台预热其它部件,之后切 tab 直接命中缓存
let preloadTimer: number | null = null;
function schedulePreload(delay = 1200) {
  if (preloadTimer !== null) window.clearTimeout(preloadTimer);
  preloadTimer = null;
  if (disposed || inspectionOpen.value) return;
  preloadTimer = window.setTimeout(() => {
    preloadTimer = null;
    if (store.pythonDetected && !loading.value) void preloadAllParts();
  }, delay);
}

watch(hashSource, () => {
  ++renderSeq; // Invalidate immediately, including during the render debounce.
  // A stale preload must not keep the Python worker busy while the user is
  // waiting for the newly selected parameters to appear in the preview.
  cancelPreviewTasks(["preload"], true);
  cancelPreviewTasks(["preview", "metrics"]);
  scheduleRender();
  schedulePreload();
});

// 监听 Python 检测状态
watch(
  () => store.pythonDetected,
  (detected) => {
    if (detected) {
      renderCurrent();
    }
  }
);

// 主题切换 → 更新网格颜色(背景走 CSS 渐变,模型不动)
watch(
  () => ui.resolvedTheme,
  (theme) => {
    // 替换旧网格(remove + dispose,避免反复切换累积显存)
    const old = scene.value?.children.find((c) => c instanceof THREE.GridHelper);
    if (old) {
      scene.value?.remove(old);
      old.geometry.dispose();
      const mat = old.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
    const grid = new THREE.GridHelper(
      400, 20,
      theme === "dark" ? 0x5C5C5F : 0x737373,
      theme === "dark" ? 0x3A3A3D : 0xD4D4D4,
    );
    scene.value?.add(grid);
    invalidate();
  }
);

// 预生成当前模式的所有部件(后台),填满缓存
const preloading = ref<Map<string, { hash: string; generation: number }>>(new Map());
const allParts = computed<PartName[]>(() =>
  appMode.value === "stencil"
    ? partTabs.value.map((tab) => tab.name).filter((name): name is PartName => name !== "assembly")
    : ["base", "insert", "cover"]
);

async function preloadAllParts() {
  // 未导入数据不预热(不浪费 Python 调用,导入后 hashSource 变化会自动触发)
  if (disposed || inspectionOpen.value || !store.pythonDetected || !hasData.value) return;
  const hash = paramsHash();
  const generation = cacheGeneration;
  const params = buildScadParams();
  for (const part of allParts.value) {
    if (disposed || inspectionOpen.value || loading.value || generation !== cacheGeneration || paramsHash() !== hash) return;
    if (stlCache.value[part]?.paramsHash === partHash(part, params)) continue;
    const pending = preloading.value.get(part);
    if (pending?.hash === hash && pending.generation === generation) continue;

    const request = { hash, generation };
    preloading.value.set(part, request);
    try {
      await ensurePart(part, generation, params, false, true);
      if (!canCacheResult(hash, generation)) return;
    } catch (e) {
      if (canCacheResult(hash, generation) && !isGenerationCancelled(e)) console.warn(`[preload] ${part} failed:`, e);
    } finally {
      const current = preloading.value.get(part);
      if (current?.hash === hash && current.generation === generation) preloading.value.delete(part);
    }
  }
}

// 手动刷新:清缓存 + 重新生成所有 3 个部件
const refreshing = ref(false);
async function refreshAll() {
  if (disposed || refreshing.value) return;
  refreshing.value = true;
  ++cacheGeneration;
  ++renderSeq;
  cancelPreviewTasks(["preview", "preload", "metrics"]);
  printMetrics.invalidate();
  if (renderTimer !== null) window.clearTimeout(renderTimer);
  if (preloadTimer !== null) window.clearTimeout(preloadTimer);
  renderTimer = preloadTimer = null;
  preloading.value.clear();
  const active = activePart.value;
  const retainedParts = active === "assembly" ? ["insert", "base", "cover"] : [active];
  const staleCache = Object.fromEntries(
    Object.entries(stlCache.value).filter(([part]) => !retainedParts.includes(part as PreviewName))
  );
  clearStlCache(staleCache, releaseGeometry);
  stlCache.value = Object.fromEntries(Object.entries(stlCache.value).filter(([part]) => retainedParts.includes(part as PreviewName)));
  try {
    await renderCurrent(true);
    schedulePreload();
    scheduleMetrics();
  } finally {
    refreshing.value = false;
  }
}

// —— 打印信息(体积/用料估算) ——
// 体积由 Python 端 build123d 精确计算;克重按 PLA 密度 1.24 g/cm³ 估算
const PLA_DENSITY_G_CM3 = 1.24;
const showMetrics = ref(false);
const printMetrics = usePartMetrics(
  () => store.pythonDetected && hasData.value
    ? { hash: paramsHash(), params: buildScadParams(), parts: [...allParts.value] }
    : null,
  hash => store.pythonDetected && hasData.value && paramsHash() === hash,
  (part, params, signal) => generationTasks.run<PartMetrics>("part_metrics", { params, part: PART_TO_RUST[part as PartName] }, "metrics", signal),
  (part, params) => partHash(part, params),
);
const { metrics, loading: metricsLoading, load: loadMetrics } = printMetrics;
let metricsTimer: number | null = null;

function scheduleMetrics() {
  if (metricsTimer !== null) window.clearTimeout(metricsTimer);
  metricsTimer = null;
  if (!showMetrics.value || disposed || inspectionOpen.value) return;
  metricsTimer = window.setTimeout(() => {
    metricsTimer = null;
    void loadMetrics();
  }, 300);
}

watch([hashSource, () => store.pythonDetected], () => {
  printMetrics.invalidate();
  scheduleMetrics();
});
watch(showMetrics, visible => {
  if (metricsTimer !== null) window.clearTimeout(metricsTimer);
  metricsTimer = null;
  if (visible) void loadMetrics();
  else printMetrics.invalidate();
});

// Give 2D checks the worker without launching hidden CAD builds on each edit.
// Returning to 3D renders the current parameters, reusing any valid mesh cache.
watch(inspectionOpen, visible => {
  if (visible) inspectionLoaded.value = true;
  ++renderSeq;
  loading.value = false;
  if (visible) {
    if (renderTimer !== null) window.clearTimeout(renderTimer);
    if (preloadTimer !== null) window.clearTimeout(preloadTimer);
    if (metricsTimer !== null) window.clearTimeout(metricsTimer);
    renderTimer = preloadTimer = metricsTimer = null;
    cancelPreviewTasks(["preload"], true);
    cancelPreviewTasks(["preview", "metrics"]);
    printMetrics.invalidate();
  } else {
    onResize();
    void renderCurrent();
    scheduleMetrics();
  }
}, { flush: "post" });

function massGrams(volMm3: number): number {
  return (volMm3 / 1000) * PLA_DENSITY_G_CM3;
}

function toggleMetrics() {
  showMetrics.value = !showMetrics.value;
}

const metricsRows = computed(() =>
  allParts.value.map((pn) => ({
    name: pn,
    label: partTabs.value.find((t) => t.name === pn)?.label ?? pn,
    color: partTabs.value.find((t) => t.name === pn)?.color ?? "#5A9B7F",
    m: metrics.value[pn],
  }))
);

const totalMass = computed(() =>
  metricsRows.value.length > 0 && metricsRows.value.every(r => r.m)
    ? metricsRows.value.reduce((s, r) => s + massGrams(r.m!.volume_mm3), 0)
    : null
);

// 视图快捷切换:front 正视 / top 俯视 / iso 等轴(保持当前缩放距离)
function setView(view: "front" | "top" | "iso") {
  const cam = camera.value;
  const ctrl = controls.value;
  if (!cam || !ctrl) return;
  const dist = cam.position.distanceTo(ctrl.target);
  // iso 方向与初始相机 (120, 80, 150) 归一化一致,切回即还原默认视角
  const dirs: Record<typeof view, [number, number, number]> = {
    front: [0, 0, 1],
    top: [0, 1, 0.0001],
    iso: [120, 80, 150],
  };
  const d = new THREE.Vector3(...dirs[view]).normalize();
  cam.position.copy(ctrl.target).addScaledVector(d, dist);
  cam.lookAt(ctrl.target);
  ctrl.update();
  invalidate();
}

// 窗口尺寸变化
function onResize() {
  if (!renderer.value || !camera.value || !canvasEl.value) return;
  const container = canvasEl.value.parentElement!;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  const r = renderer.value;
  const pixelRatio = r.getPixelRatio();
  const bufferChanged = canvasEl.value.width !== Math.floor(w * pixelRatio)
    || canvasEl.value.height !== Math.floor(h * pixelRatio);
  const aspectChanged = camera.value.aspect !== w / h;
  // Width animations can report the same rounded size near their soft landing.
  // Reassigning canvas dimensions clears/reallocates its buffer even at that size.
  if (!bufferChanged && !aspectChanged) return;
  if (bufferChanged) r.setSize(w, h, false);
  if (aspectChanged) {
    camera.value.aspect = w / h;
    camera.value.updateProjectionMatrix();
  }
  invalidate();
}

// Observe the stable scene layer: sidebar movement only translates it, so no
// WebGL buffer allocation occurs on each animation frame. Window/toolbar height
// changes still resize the renderer through this observer.
let containerObserver: ResizeObserver | null = null;

onMounted(() => {
  initThreeScene();
  window.addEventListener("keydown", onMeasureKeyDown);
  if (canvasEl.value?.parentElement) {
    containerObserver = new ResizeObserver(() => onResize());
    containerObserver.observe(canvasEl.value.parentElement);
  }
  if (store.pythonDetected) renderCurrent();
});

onBeforeUnmount(() => {
  cancelPreviewTasks(["preview", "preload", "metrics"], true);
  disposed = true;
  ++cacheGeneration;
  ++renderSeq;
  printMetrics.dispose();
  if (metricsTimer !== null) window.clearTimeout(metricsTimer);
  if (renderTimer !== null) window.clearTimeout(renderTimer);
  window.removeEventListener("keydown", onMeasureKeyDown);
  if (hoverRafId !== null) cancelAnimationFrame(hoverRafId);
  hoverRafId = null;
  containerObserver?.disconnect();
  containerObserver = null;
  if (animationId.value !== null) cancelAnimationFrame(animationId.value);
  disposeMesh();
  clearStlCache(stlCache.value);
  stlCache.value = {};
  if (preloadTimer !== null) window.clearTimeout(preloadTimer);
  controls.value?.dispose();
  pcbEnvironment?.dispose();
  pcbEnvironment = null;
  renderer.value?.dispose();
  scene.value = null;
  camera.value = null;
  renderer.value = null;
  controls.value = null;
});

async function ensureStencilSizeReviewed() {
  const result = await reviewStencilSizeForExport(store, async size => {
    try {
      const message = h('div', { class: 'stencil-review-content' }, [
        h('div', { class: 'stencil-review-dimensions' }, [
          h('span', { class: 'stencil-review-label' }, t('preview.reviewStencilSizeLabel')),
          h('div', { class: 'stencil-review-value' }, [
            h('strong', `${size.x} × ${size.y}`), h('span', 'mm'),
          ]),
        ]),
        h('p', { class: 'stencil-review-note' }, t('preview.reviewStencilSizeMessage')),
      ]);
      await ElMessageBox.confirm(message, t('preview.reviewStencilSizeTitle'), {
        confirmButtonText: t('preview.reviewStencilSizeContinue'), cancelButtonText: t('preview.reviewStencilSizeBack'),
        distinguishCancelAndClose: true, customClass: 'stencil-review-dialog', buttonSize: 'default',
        confirmButtonClass: 'stencil-review-confirm', cancelButtonClass: 'stencil-review-back',
      });
      return true;
    } catch (action) {
      if (action === 'cancel' && !disposed) emit('reviewStencilSize');
      return false;
    }
  }, () => !disposed);
  if (result === 'changed') ElMessage.warning(t('preview.reviewStencilSizeChanged'));
  return result === 'ready';
}

async function chooseExportProjectName(): Promise<string | null> {
  try {
    const { value } = await ElMessageBox.prompt(
      t("preview.exportNameMessage"),
      t("preview.exportNameTitle"),
      {
        inputValue: defaultExportName(store.gerberSourceFilename ?? store.config.gerberFilename),
        inputPlaceholder: t("preview.exportNamePlaceholder"),
        appendTo: 'body',
        customClass: "stencil-review-dialog preset-name-dialog",
        confirmButtonClass: 'stencil-review-confirm',
        cancelButtonClass: 'stencil-review-back',
        buttonSize: "default",
        confirmButtonText: t("preview.exportNameConfirm"),
        cancelButtonText: t("preview.exportNameCancel"),
        closeOnClickModal: false,
        inputValidator: (input: string) => {
          const name = input.trim();
          if (!name) return t("preview.exportNameRequired");
          return validExportName(name) || t("preview.exportNameInvalid");
        },
      },
    );
    return value.trim();
  } catch (action) {
    if (action === 'cancel' || action === 'close') return null;
    throw action;
  }
}

// 导出 STL / STEP:先核对钢网,再选目录并写文件。
async function exportAll(fmt: "stl" | "step") {
  if (exporting.value || disposed) return;
  if (!store.pythonDetected) {
    ElMessage.error(t("preview.noPythonExport"));
    return;
  }

  exporting.value = true;
  workSession.exporting = true;
  try {
    if (!await ensureStencilSizeReviewed()) return;
    const parentDir = await open({
      directory: true,
      multiple: false,
      title: fmt === "stl" ? t("preview.exportStl") : t("preview.exportStep"),
    });
    if (!parentDir || Array.isArray(parentDir)) return;
    const projectName = await chooseExportProjectName();
    if (!projectName || disposed) return;
    if (!await ensureStencilSizeReviewed()) return;

    const params: ReturnType<typeof buildScadParams> = JSON.parse(JSON.stringify(buildScadParams()));
    const exportSnapshot = workSession.captureExport();
    const mode = appMode.value;
    const hasTop = store.config.stencilPadsTop.length > 0;
    const hasBottom = store.config.stencilPadsBottom.length > 0;
    const sep = parentDir.includes("\\") ? "\\" : "/";
    // 按用户确认的项目名建立目录；同名目录自动追加序号，避免覆盖已有导出。
    const exportDir = await invoke<string>("create_export_dir", { parentDir, name: projectName });

    // 钢网模式:只导出导入了焊盘的面(都没导入时导出顶层占位)
    const stencilParts: Array<{ name: PartName; rust: string; filename: string }> = [];
    if (hasTop || !hasBottom) {
      stencilParts.push({ name: "stencil_top", rust: "stencil_top", filename: `stencil_top.${fmt}` });
    }
    if (hasBottom) {
      stencilParts.push({ name: "stencil_bottom", rust: "stencil_bottom", filename: `stencil_bottom.${fmt}` });
    }
    const parts: Array<{ name: PartName; rust: string; filename: string }> =
      mode === "stencil"
        ? stencilParts
        : [
            { name: "base", rust: "base", filename: `jig_base.${fmt}` },
            { name: "insert", rust: "pcb_insert", filename: `jig_pcb_insert.${fmt}` },
            { name: "cover", rust: "top_cover", filename: `jig_top_cover.${fmt}` },
          ];

    for (const p of parts) {
      const fullPath = `${exportDir}${sep}${p.filename}`;
      // STL 缓存命中(当前参数):bytes 直接落盘,跳过 Python 重新生成;STEP 无缓存
      const cached = fmt === "stl" ? stlCache.value[p.name] : undefined;
      if (cached && cached.paramsHash === partHash(p.name, params)) {
        await invoke("write_file_bytes", { path: fullPath, bytes: cached.bytes });
      } else {
        await invoke("export_stl", { params, part: p.rust, outputPath: fullPath });
      }
    }

    workSession.markExported(exportSnapshot);
    const n = parts.length;
    ElMessage.success(
      fmt === "stl"
        ? t("preview.exported", { n, dir: exportDir })
        : t("preview.exportedStep", { n, dir: exportDir })
    );
  } catch (e) {
    ElMessage.error(t("preview.exportFailed", { msg: e instanceof Error ? e.message : String(e) }));
  } finally {
    exporting.value = false;
    workSession.exporting = false;
  }
}

const partTabs = computed<Array<{ name: PreviewName; label: string; color: string }>>(() => {
  if (appMode.value === "stencil") {
    const c = store.config;
    const tabs: Array<{ name: PartName; label: string; color: string }> = [];
    // 有焊盘的面才显示 tab(都没导入时显示顶层占位)
    if (c.stencilPadsTop.length > 0 || c.stencilPadsBottom.length === 0) {
      tabs.push({ name: "stencil_top", label: t("preview.stencilTop"), color: "#D9913D" });
    }
    if (c.stencilPadsBottom.length > 0) {
      tabs.push({ name: "stencil_bottom", label: t("preview.stencilBottom"), color: "#4C6F94" });
    }
    return tabs;
  }
  return [
    { name: "insert" as PartName, label: t("preview.insert"), color: "#5A9B7F" },
    { name: "base" as PartName, label: t("preview.base"), color: "#4C6F94" },
    { name: "cover" as PartName, label: t("preview.cover"), color: "#D9913D" },
    { name: "assembly", label: t("preview.assembly"), color: "#929DAF" },
  ];
});

const singlePartTabs = computed(() => partTabs.value.filter(tab => tab.name !== "assembly"));

// 切换模式时重置 activePart 到该模式的第一个 tab
watch(appMode, (m) => {
  inspectionOpen.value = false;
  activePart.value = m === "stencil" ? "stencil_top" : "insert";
});

// tab 列表变化(如重新导入 Gerber)后 activePart 不在列表时回退到第一个
watch(partTabs, (tabs) => {
  if (!tabs.some((tab) => tab.name === activePart.value)) {
    activePart.value = tabs[0]?.name ?? "stencil_top";
  }
});
</script>

<template>
  <div class="preview-wrapper" :class="{ 'is-dark': ui.resolvedTheme === 'dark' }">
    <div class="preview-header">
      <div class="preview-modes" role="group" :aria-label="t('preview.viewModes')">
        <div class="tab-group" role="group" :aria-label="t('preview.singleParts')">
          <button
            v-for="tab in singlePartTabs"
            :key="tab.name"
            class="tab-btn"
            :class="{ active: activePart === tab.name }"
            :aria-pressed="activePart === tab.name"
            @click="activePart = tab.name"
          >
            <span class="tab-dot" :style="{ background: tab.color }" />
            {{ tab.label }}
          </button>
        </div>
        <template v-if="appMode === 'jig'">
          <span class="mode-divider" aria-hidden="true" />
          <button class="assembly-mode-btn" :class="{ active: activePart === 'assembly' }"
            :aria-pressed="activePart === 'assembly'" @click="activePart = 'assembly'">
            <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
              <path d="M9 2.5l6.5 3.6L9 9.7 2.5 6.1 9 2.5ZM2.5 9L9 12.6 15.5 9M2.5 11.9L9 15.5l6.5-3.6"
                fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {{ t('preview.assembly') }}
          </button>
        </template>
        <template v-if="appMode === 'stencil'">
          <span class="mode-divider" aria-hidden="true" />
          <button class="assembly-mode-btn" :class="{ active: inspectionOpen }" :aria-pressed="inspectionOpen"
            :disabled="!hasData" @click="inspectionOpen = !inspectionOpen">
            <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
              <rect x="2.5" y="2.5" width="13" height="13" rx="2" /><path d="M6 6h2v2H6zM10 6h2v2h-2zM6 10h2v2H6zM10 10h2v2h-2z" />
            </svg>
            {{ t(inspectionOpen ? 'inspection.back3d' : 'inspection.title') }}
          </button>
        </template>
      </div>
      <div class="header-actions">
        <span v-if="!inspectionOpen && preloading.size > 0" class="preload-badge" :title="t('preview.preloadingHint')">
          {{ t('preview.preloading') }}
        </span>
        <button v-if="!inspectionOpen" class="action-btn" @click="refreshAll" :disabled="refreshing">
          <svg viewBox="0 0 16 16" width="14" height="14" :class="{ spinning: refreshing }">
            <path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3"
              fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {{ t('preview.refresh') }}
        </button>
        <button v-if="!inspectionOpen" class="action-btn" :class="{ active: showMetrics }" @click="toggleMetrics" :title="t('preview.printInfo')">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M8 1.5l5.5 3.1v6.8L8 14.5l-5.5-3.1V4.6zM8 8l5.5-3.1M8 8v6.5M8 8L2.5 4.9"
              fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          </svg>
          {{ t('preview.printInfo') }}
        </button>
        <div class="export-actions">
          <button class="action-btn primary export-default"
            :disabled="exporting"
            :title="t('preview.export') + ' ' + ui.defaultExportFormat.toUpperCase()"
            :aria-label="t('preview.export') + ' ' + ui.defaultExportFormat.toUpperCase()"
            @click="exportAll(ui.defaultExportFormat)">
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path d="M3 3v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6l-3-3H4a1 1 0 0 0-1 1zM6 3v3h4M8 8v3M6.5 9.5L8 11l1.5-1.5"
                fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {{ t(exporting ? 'preview.exporting' : 'preview.export') }}
          </button>
          <el-dropdown trigger="click" @command="(f: string | number | object) => exportAll(f as 'stl' | 'step')">
            <button class="action-btn primary export-format-toggle" :disabled="exporting" :title="t('preview.exportOptions')" :aria-label="t('preview.exportOptions')">
              <svg class="caret" viewBox="0 0 16 16" width="10" height="10">
                <path d="M4 6.5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="stl" :disabled="exporting">{{ t('preview.exportStl') }}</el-dropdown-item>
              <el-dropdown-item command="step" :disabled="exporting">{{ t('preview.exportStep') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
          </el-dropdown>
        </div>
      </div>
    </div>

    <div ref="containerEl" class="canvas-container" :class="{ measuring: measureMode, 'has-preview': hasPreview }">
      <div v-show="!inspectionOpen" class="scene-layer">
      <canvas
        ref="canvasEl"
        @pointerdown="onCanvasPointerDown"
        @pointerup="onCanvasPointerUp"
        @pointermove="onCanvasPointerMove"
      />
      <!-- 测量标签:直线/水平/垂直三色数值,定位由各线 3D 中点投影得到 -->
      <div v-if="measureTags.length" class="measure-layer">
        <span
          v-for="tag in measureTags"
          :key="tag.id"
          class="measure-tag"
          :class="tag.kind"
          :style="{ left: tag.x + 'px', top: tag.y + 'px' }"
        >{{ tag.text }}</span>
      </div>
      </div>
      <div v-show="!inspectionOpen" class="preview-overlays">
      <div class="viewport-tools" role="group" :aria-label="t('preview.viewControls')" @pointerdown.stop @wheel.stop @dblclick.stop>
        <!-- 视图快捷切换 -->
        <div class="view-btns">
          <button class="view-btn" :title="t('preview.viewFront')" @click="setView('front')">
            <svg viewBox="0 0 16 16" width="14" height="14">
              <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.4" />
            </svg>
          </button>
          <button class="view-btn" :title="t('preview.viewTop')" @click="setView('top')">
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path d="M8 3.5l4.5 4.5L8 12.5 3.5 8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
            </svg>
          </button>
          <button class="view-btn" :title="t('preview.viewIso')" @click="setView('iso')">
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path d="M8 2l5.2 3v6L8 14l-5.2-3V5zM8 8l5.2-3M8 8L2.8 5M8 8v6"
                fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
        <span class="viewport-tool-divider" aria-hidden="true" />
        <button class="action-btn" :aria-pressed="measureMode" :class="{ active: measureMode }" :disabled="activePart === 'assembly' || !!currentAssembly" @click="setMeasureMode(!measureMode)" :title="t(activePart === 'assembly' ? 'preview.measureSinglePart' : 'preview.measure')">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M1.6 11.2L11.2 1.6l3.2 3.2-9.6 9.6zM4.4 8.4l1.6 1.6M6.8 6l1.6 1.6M9.2 3.6l1.6 1.6"
              fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {{ t('preview.measure') }}
        </button>
      </div>
      <Transition name="preview-panel">
        <div v-if="activePart === 'assembly' && currentAssembly" class="assembly-explosion" @pointerdown.stop @wheel.stop>
          <div class="assembly-panel-heading">
            <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
              <path d="m10 2 7 4-7 4-7-4 7-4ZM3 10l7 4 7-4M3 14l7 4 7-4" />
            </svg>
            <span>{{ t('preview.assemblyControls') }}</span>
            <button class="explosion-reset" :title="t('preview.resetAssembly')" :aria-label="t('preview.resetAssembly')" @click="explosionPercent = 0">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6a5 5 0 1 1 0 4M3 2v4h4" /></svg>
            </button>
          </div>
          <div class="explosion-label"><span>{{ t('preview.explodedView') }}</span><output>{{ explosionPercent }}<small>%</small></output></div>
          <el-slider v-model="explosionPercent" :aria-label="t('preview.explodedView')" :show-tooltip="false" />
          <div class="explosion-endpoints"><span>{{ t('preview.assembled') }}</span><span>{{ t('preview.explode') }}</span></div>
          <div class="assembly-layer-controls">
            <button role="switch" :aria-checked="showAssemblyPcb" class="assembly-layer-toggle" :class="{ 'is-on': showAssemblyPcb }" @click="showAssemblyPcb = !showAssemblyPcb">
              <span class="assembly-layer-dot pcb-dot" /><span>{{ t('preview.pcbBoard') }}</span>
              <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round">
                <path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" /><circle cx="10" cy="10" r="2" /><path v-if="!showAssemblyPcb" d="m3 3 14 14" />
              </svg>
            </button>
            <button role="switch" :aria-checked="showAssemblyStencil" class="assembly-layer-toggle" :class="{ 'is-on': showAssemblyStencil }" :title="t('preview.metalStencilHint')" @click="showAssemblyStencil = !showAssemblyStencil">
              <span class="assembly-layer-dot metal-dot" /><span>{{ t('preview.metalStencil') }}</span>
              <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round">
                <path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" /><circle cx="10" cy="10" r="2" /><path v-if="!showAssemblyStencil" d="m3 3 14 14" />
              </svg>
            </button>
          </div>
        </div>
      </Transition>
      <!-- 测量面板:显示两个选中对象(可单独删除)+ 测量结果行 -->
      <Transition name="preview-panel"><div v-if="measureMode" class="measure-panel">
        <div class="measure-panel-head">{{ t('preview.measure') }}</div>
        <div v-if="!selA && !selB" class="measure-panel-empty">{{ t('preview.measurePickFirst') }}</div>
        <div v-if="selA" class="measure-sel-row">
          <span class="sel-badge badge-a">1</span>
          <div class="sel-info">
            <span class="sel-kind">{{ featureKindLabel(selA) }}</span>
            <span class="sel-detail">{{ featureInfo(selA) }}</span>
          </div>
          <button class="sel-del" :title="t('preview.measureRemove')" @click="removeSelection(1)">✕</button>
        </div>
        <div v-if="selB" class="measure-sel-row">
          <span class="sel-badge badge-b">2</span>
          <div class="sel-info">
            <span class="sel-kind">{{ featureKindLabel(selB) }}</span>
            <span class="sel-detail">{{ featureInfo(selB) }}</span>
          </div>
          <button class="sel-del" :title="t('preview.measureRemove')" @click="removeSelection(2)">✕</button>
        </div>
        <div v-if="measureRows.length" class="measure-results">
          <div v-for="(row, i) in measureRows" :key="i" class="measure-result-row">
            <span class="result-label">{{ row.label }}</span>
            <span class="result-value">{{ row.value }}</span>
          </div>
        </div>
      </div>
      </Transition>
      <!-- 测量模式提示 -->
      <div v-if="measureMode" class="measure-hint">
        {{ t('preview.measureHint') }}
      </div>
      <!-- 空状态引导:无模型、无加载、无错误时显示(虚线卡片模拟拖放目标) -->
      <div
        v-if="!hasPreview && !loading && !errorMsg && store.pythonDetected"
        class="empty-state"
      >
        <div class="empty-card">
          <svg viewBox="0 0 64 64" width="48" height="48" class="empty-icon">
            <rect x="5" y="5" width="54" height="54" rx="11" fill="none" stroke="currentColor" stroke-width="4" stroke-dasharray="7,5" />
            <path d="M32 20v18M24 30l8 8 8-8" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
            <rect x="24" y="46" width="16" height="4" rx="2" fill="currentColor" opacity="0.55" />
          </svg>
          <p class="empty-line1">{{ appMode === 'stencil' ? t('preview.emptyLine1Stencil') : t('preview.emptyLine1') }}</p>
          <p class="empty-line2">{{ appMode === 'stencil' ? t('preview.emptyLine2Stencil') : t('preview.emptyLine2') }}</p>
        </div>
      </div>
      <div v-if="loading" class="overlay">
        <svg class="spin-icon" viewBox="0 0 16 16" width="20" height="20">
          <path d="M8 2a6 6 0 1 0 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <span>{{ t('preview.rendering') }}</span>
      </div>
      <div v-if="!store.pythonDetected && !loading" class="overlay warning">
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path d="M8 2L1 14h14L8 2zM8 6v4M8 12v.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ t('preview.noPythonPreview') }}</span>
      </div>
      <div v-if="errorMsg && !loading" class="overlay error">
        <span>{{ errorMsg }}</span>
      </div>
      <!-- 打印信息卡:体积/用料估算(懒加载,按当前参数缓存) -->
      <Transition name="preview-panel"><div v-if="showMetrics" class="metrics-card">
        <div class="metrics-head">
          <span>{{ t('preview.metricsTitle') }}</span>
          <button class="metrics-close" :title="t('preview.metricsClose')" @click="showMetrics = false">
            <svg viewBox="0 0 16 16" width="12" height="12">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        </div>
        <div v-if="metricsLoading" class="metrics-loading">{{ t('preview.metricsLoading') }}</div>
        <template v-else>
          <ul class="metrics-list">
            <li v-for="row in metricsRows" :key="row.name" class="metrics-row">
              <span class="metrics-dot" :style="{ background: row.color }" />
              <span class="metrics-label">{{ row.label }}</span>
              <span class="metrics-val">
                {{ row.m ? (row.m.volume_mm3 / 1000).toFixed(2) + ' cm³ · ' + massGrams(row.m.volume_mm3).toFixed(1) + ' g' : '—' }}
              </span>
            </li>
          </ul>
          <div class="metrics-foot">
            <span>{{ t('preview.total') }}</span>
            <span class="metrics-total">{{ totalMass === null ? '—' : `${totalMass.toFixed(1)} g` }}</span>
          </div>
        </template>
        <div class="metrics-note">{{ t('preview.metricsDensity') }}</div>
      </div>
      </Transition>
      <div class="viewport-hint">
        <span v-if="currentAssembly" class="assembly-caption">{{ t('preview.assemblyHint') }}</span>
        {{ t('preview.hint') }}
      </div>
      </div>
      <StencilInspection v-if="appMode === 'stencil' && hasData && inspectionLoaded" v-show="inspectionOpen"
        :active="inspectionOpen" :side="activePart === 'stencil_bottom' ? 'bottom' : 'top'" />
    </div>
  </div>
</template>

<style scoped>
.preview-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* Sidebar motion never changes the WebGL backing buffer width. The scene and
   its projected labels slide together, retaining accurate pointer coordinates. */
.scene-layer {
  position: absolute;
  inset: 0;
  transform: translateX(calc(var(--preview-inset, 0px) / 2));
}
.preview-overlays {
  position: absolute;
  inset: 0 0 0 var(--preview-inset, 0px);
  pointer-events: none;
}
.preview-overlays > .measure-panel, .preview-overlays > .metrics-card { pointer-events: auto; }
.is-layout-animating .scene-layer {
  transition: transform var(--sidebar-duration) var(--sidebar-ease);
}
.is-layout-animating .preview-header {
  transition: margin-left var(--sidebar-duration) var(--sidebar-ease);
}
.is-layout-animating .preview-overlays {
  transition: left var(--sidebar-duration) var(--sidebar-ease);
}

/* Header */
.preview-header {
  margin-left: var(--preview-inset, 0px);
  flex: 0 0 auto;
  min-height: 56px;
  background: var(--surface-raised);
  border-bottom: 1px solid var(--surface-line);
  padding: 10px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px 12px;
  flex-wrap: wrap;
  box-shadow: none;
  z-index: 1;
}

/* Tab Group */
.preview-modes {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  flex-wrap: wrap;
  min-width: 0;
}

.tab-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-full);
  background: var(--surface-well);
  max-width: 100%;
}

.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: var(--control-transition);
  font-family: inherit;
  white-space: nowrap;
}

.tab-btn:hover {
  background: var(--bg-overlay-l1);
  color: var(--text-secondary);
}

.tab-btn.active {
  background: var(--surface-raised);
  color: var(--text-default);
  box-shadow: 0 1px 3px rgba(25, 40, 34, .08), 0 0 0 1px var(--surface-line);
}
.tab-btn.active .tab-dot { transform: scale(1.2); }

.mode-divider {
  width: 1px;
  height: 18px;
  background: var(--surface-line);
  flex-shrink: 0;
}

.assembly-mode-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
  cursor: pointer;
  transition: var(--control-transition);
}
.assembly-mode-btn > svg { flex-shrink: 0; }
.assembly-mode-btn:hover { background: var(--surface-well); color: var(--bg-brand); }
.assembly-mode-btn.active {
  background: var(--status-success-surface-l1);
  border-color: color-mix(in srgb, var(--bg-brand) 24%, transparent);
  color: var(--bg-brand);
}
.tab-btn:focus-visible, .assembly-mode-btn:focus-visible {
  outline: 2px solid var(--bg-brand);
  outline-offset: 2px;
}
.tab-btn:active, .assembly-mode-btn:active { transform: scale(.97); }

.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
  transition: transform var(--motion-fast) var(--ease-out);
}

/* Header Actions */
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-wrap: wrap;
}

.preload-badge {
  font-size: 11px;
  color: var(--text-tertiary);
  padding: 2px 8px;
  background: var(--bg-overlay-l1);
  border-radius: var(--radius-full);
  font-family: var(--font-family-mono);
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  background: var(--surface-well);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: var(--control-transition);
  font-family: inherit;
}

.action-btn:hover {
  background: var(--surface-selected);
  border-color: var(--surface-line);
  color: var(--text-default);
  box-shadow: none;
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.action-btn.primary:hover { box-shadow: none; }
.preview-panel-enter-active { transition: opacity 220ms ease, transform 260ms var(--ease-out); }
.preview-panel-leave-active { transition: opacity 140ms ease, transform 160ms ease; pointer-events: none; }
.preview-panel-enter-from, .preview-panel-leave-to { opacity: 0; transform: translateY(6px); }

/* 导出(主 CTA)用品牌橙:绿=调节/导航,橙=动作/输出,与 Logo 起绿终橙呼应 */
.action-btn.primary {
  background: var(--brand-accent);
  border-color: var(--brand-accent);
  color: var(--text-onbrand);
}

.action-btn.primary:hover {
  background: var(--brand-accent-hover);
  border-color: var(--brand-accent-hover);
  color: var(--text-onbrand);
}

.action-btn svg {
  color: inherit;
}

.export-actions { display: inline-flex; align-items: stretch; }
.export-actions :deep(.el-dropdown) { display: inline-flex; }
.export-default { border-radius: var(--radius-full) 0 0 var(--radius-full); }
.export-format-toggle { height: 100%; padding-inline: 7px; border-left-color: rgba(255,255,255,.25) !important; border-radius: 0 var(--radius-full) var(--radius-full) 0; }
.export-format-toggle .caret { margin: 0; }

.action-btn .caret {
  margin-left: -2px;
  opacity: 0.8;
}

/* 视图快捷按钮组(正/顶/等轴) */
.viewport-tools {
  position: absolute;
  left: 50%;
  bottom: 44px;
  transform: translateX(-50%);
  z-index: 6;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px;
  max-width: calc(100% - 32px);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--surface-raised) 88%, transparent);
  backdrop-filter: blur(16px);
  box-shadow: 0 6px 24px rgba(25, 40, 34, .09), inset 0 1px var(--surface-highlight);
  pointer-events: auto;
  user-select: none;
}
.viewport-tools .view-btns { border: none; padding: 0; background: transparent; }
.viewport-tools .view-btn { width: 32px; height: 30px; }
.viewport-tools .action-btn { min-height: 30px; white-space: nowrap; }
.viewport-tool-divider { width: 1px; height: 18px; background: var(--surface-line); }
.viewport-tools button:focus-visible { outline: 2px solid var(--bg-brand); outline-offset: 2px; }
.viewport-tools button:active:not(:disabled) { transform: scale(.95); }

.view-btns {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-full);
  background: var(--surface-well);
  box-shadow: none;
}

.view-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: var(--control-transition);
}

.view-btn:hover {
  background: var(--surface-selected);
  color: var(--text-default);
  box-shadow: var(--shadow-control);
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Canvas:背景用径向渐变模拟"工作台"顶光,模型区有纵深感 */
.canvas-container {
  flex: 1 1 auto;
  position: relative;
  overflow: hidden;
  background: radial-gradient(100% 85% at 50% 36%, #FCFDFC 0%, #EEF2EF 64%, #E6EBE7 100%);
}

.is-dark .canvas-container {
  background: radial-gradient(100% 85% at 50% 36%, #2B332E 0%, #202722 64%, #191F1B 100%);
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* 测量模式:光标改为十字,提示可点选 */
.canvas-container.measuring canvas {
  cursor: crosshair;
}

/* 测量文字层:不影响鼠标交互,标签由 3D 中点投影坐标定位 */
.measure-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

.measure-tag {
  position: absolute;
  transform: translate(-50%, -50%);
  padding: 2px 8px;
  border-radius: 5px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  white-space: nowrap;
  background: var(--bg-elevated, rgba(255, 255, 255, 0.92));
  border: 1px solid;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
  font-weight: var(--font-weight-strong, 600);
}

/* 三色距离标签:直线(绿)/水平(琥珀)/垂直(蓝),文字与边框同线色 */
.measure-tag.direct {
  color: #0f8a5f;
  border-color: #15a877;
}

.measure-tag.horizontal {
  color: #a8641c;
  border-color: #d9913d;
}

.measure-tag.vertical {
  color: #3d5e80;
  border-color: #4c6f94;
}

.is-dark .measure-tag.direct {
  color: #3bc494;
}

.is-dark .measure-tag.horizontal {
  color: #e8b06a;
}

.is-dark .measure-tag.vertical {
  color: #8fb0d6;
}

.is-dark .measure-tag {
  background: rgba(30, 30, 32, 0.92);
}

/* 预览态(悬停边长/橡皮筋实时距离):虚线边框提示未确认 */
.measure-tag.preview {
  border-style: dashed;
  opacity: 0.92;
}

/* 测量面板:左上角,显示选中对象与结果 */
.measure-panel {
  position: absolute;
  top: 12px;
  left: 36px;
  width: 232px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--radius-8, 8px);
  background: var(--bg-elevated, rgba(255, 255, 255, 0.95));
  border: 1px solid var(--border-lighter, rgba(0, 0, 0, 0.08));
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  z-index: 5;
  user-select: none;
}

.is-dark .measure-panel {
  background: rgba(30, 30, 32, 0.95);
  border-color: rgba(255, 255, 255, 0.1);
}

.measure-panel-head {
  font-size: 12px;
  font-weight: var(--font-weight-strong, 600);
  color: var(--text-default);
}

.measure-panel-empty {
  font-size: 11px;
  color: var(--text-tertiary);
  line-height: 1.4;
}

.measure-sel-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 6px;
  background: var(--bg-page, rgba(0, 0, 0, 0.03));
}

.sel-badge {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 槽位配色与 3D 高亮一致:1=橙,2=蓝 */
.sel-badge.badge-a {
  background: #e07a3c;
}

.sel-badge.badge-b {
  background: #4c8fd6;
}

.sel-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.sel-kind {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-default);
}

.sel-detail {
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sel-del {
  flex: none;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 10px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sel-del:hover {
  background: rgba(0, 0, 0, 0.08);
  color: var(--text-default);
}

.is-dark .sel-del:hover {
  background: rgba(255, 255, 255, 0.12);
}

.measure-results {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 6px;
  border-top: 1px solid var(--border-lighter, rgba(0, 0, 0, 0.08));
}

.measure-result-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  line-height: 16px;
}

.result-label {
  color: var(--text-tertiary);
}

.result-value {
  color: var(--text-default);
  font-variant-numeric: tabular-nums;
  font-weight: var(--font-weight-strong, 600);
}

/* 测量模式提示条 */
.measure-hint {
  position: absolute;
  left: 12px;
  bottom: 12px;
  background: rgba(38, 38, 38, 0.72);
  color: rgba(255, 255, 255, 0.9);
  font-size: 10px;
  padding: 4px 10px;
  border-radius: var(--radius-6);
  pointer-events: none;
  backdrop-filter: blur(4px);
}

/* 空状态引导:虚线卡片模拟拖放目标 */
.empty-state {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 36px 56px;
  border: 1.5px solid var(--surface-line);
  border-radius: 20px;
  background: color-mix(in srgb, var(--surface-raised) 82%, transparent);
  box-shadow: var(--shadow-card), inset 0 1px var(--surface-highlight);
}

.is-dark .empty-card {
  background: color-mix(in srgb, var(--surface-raised) 88%, transparent);
}

.empty-icon {
  color: var(--bg-brand);
  margin-bottom: 6px;
}

.empty-line1 {
  margin: 0;
  font-size: 13px;
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-secondary);
}

.empty-line2 {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
}

/* Overlays */
.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(245, 245, 245, 0.88);
  color: var(--text-secondary);
  font-size: 13px;
  pointer-events: none;
  backdrop-filter: blur(4px);
}

.is-dark .overlay {
  background: rgba(29, 35, 31, 0.88);
}

.canvas-container.has-preview .overlay {
  background: rgba(245, 245, 245, 0.28);
  backdrop-filter: blur(1px);
}

.is-dark .canvas-container.has-preview .overlay {
  background: rgba(35, 35, 37, 0.3);
}

.overlay.warning {
  color: var(--status-warning-default);
}

.overlay.error {
  color: var(--status-error-default);
  background: var(--scrim);
}

/* 崩溃诊断是多行文本(引擎路径 + 日志尾部),需保留换行并可滚动 */
.overlay.error span {
  white-space: pre-wrap;
  word-break: break-word;
  text-align: left;
  line-height: 1.55;
  max-width: 86%;
  max-height: 80%;
  overflow: auto;
  padding: 0 12px;
}

.spin-icon {
  color: var(--bg-brand);
  animation: spin 1s linear infinite;
}

/* Viewport Hint */
.viewport-hint {
  position: absolute;
  bottom: 12px;
  right: 12px;
  background: rgba(38, 38, 38, 0.72);
  color: rgba(255, 255, 255, 0.88);
  font-size: 10px;
  padding: 4px 10px;
  border-radius: var(--radius-6);
  pointer-events: none;
  font-family: var(--font-family-default);
  border: 1px solid rgba(255,255,255,.12);
}

.assembly-caption {
  display: block;
  margin-bottom: 6px;
  opacity: 0.86;
}

.assembly-explosion {
  position: absolute;
  right: 20px;
  top: 50%;
  transform: translateY(-50%);
  width: 176px;
  padding: 14px 16px 12px;
  border: 1px solid var(--surface-line);
  border-radius: 20px;
  background: color-mix(in srgb, var(--surface-raised) 88%, transparent);
  backdrop-filter: blur(20px);
  box-shadow: 0 8px 32px rgba(25, 40, 34, 0.06), inset 0 1px var(--surface-highlight);
  pointer-events: auto;
  font-size: 11px;
}
.assembly-panel-heading { display: flex; align-items: center; gap: 7px; color: var(--text-secondary); font-weight: 600; margin-bottom: 18px; }
.assembly-panel-heading > svg { color: var(--bg-brand); }
.explosion-reset {
  margin-left: auto;
  width: 24px;
  height: 24px;
  padding: 0;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: var(--control-transition);
}
.explosion-reset:hover { background: var(--bg-overlay-l1); color: var(--bg-brand); }
.explosion-label { display: flex; align-items: baseline; justify-content: space-between; color: var(--text-secondary); }
.explosion-label output { color: var(--bg-brand); font-size: 16px; font-weight: 500; font-variant-numeric: tabular-nums; }
.explosion-label small { font-size: 10px; margin-left: 2px; opacity: .65; }
.assembly-explosion :deep(.el-slider) { height: 28px; }
.assembly-explosion :deep(.el-slider__runway) { height: 3px; background: var(--bg-overlay-l3); }
.assembly-explosion :deep(.el-slider__bar) { height: 3px; }
.assembly-explosion :deep(.el-slider__button-wrapper) { top: -16.5px; }
.assembly-explosion :deep(.el-slider__button) { width: 11px; height: 11px; border: 3px solid var(--surface-raised); background: var(--bg-brand); box-shadow: 0 0 0 1px var(--surface-line), 0 2px 5px rgba(25,40,34,.15); }
.explosion-endpoints { display: flex; justify-content: space-between; color: var(--text-tertiary); font-size: 10px; }
.assembly-layer-controls { margin-top: 14px; padding-top: 8px; border-top: 1px solid var(--surface-line); display: grid; gap: 3px; }
.assembly-layer-toggle { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 4px; background: transparent; border: none; border-radius: 8px; color: var(--text-tertiary); font: inherit; text-align: left; cursor: pointer; transition: var(--control-transition); }
.assembly-layer-toggle:hover { background: var(--bg-overlay-l1); }
.assembly-layer-toggle.is-on { color: var(--text-secondary); }
.assembly-layer-toggle > svg { margin-left: auto; opacity: .5; }
.assembly-layer-toggle.is-on > svg { color: var(--bg-brand); opacity: 1; }
.assembly-layer-dot { width: 7px; height: 7px; border-radius: 50%; opacity: .3; }
.assembly-layer-toggle.is-on .assembly-layer-dot { opacity: 1; }
.pcb-dot { background: #397fbb; }
.metal-dot { background: #99a8b5; }
.assembly-explosion.preview-panel-enter-from, .assembly-explosion.preview-panel-leave-to { transform: translateY(calc(-50% + 6px)); }
.assembly-layer-toggle:focus-visible, .explosion-reset:focus-visible { outline: 2px solid var(--bg-brand); outline-offset: 2px; }

/* 打印信息按钮激活态:与导出主 CTA 一致的橙色 */
.action-btn.active {
  background: var(--brand-accent);
  border-color: var(--brand-accent);
  color: var(--text-onbrand);
}

.action-btn.active:hover {
  background: var(--brand-accent-hover);
  border-color: var(--brand-accent-hover);
}

/* 打印信息卡(浮层):体积 / 用料估算 */
.metrics-card {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 224px;
  background: var(--bg-base-default);
  border: 1px solid var(--border-neutral-l2);
  border-radius: var(--radius-8);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.14);
  padding: 12px 14px;
  z-index: 10;
  font-family: var(--font-family-default);
}

.metrics-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: var(--font-weight-strong);
  color: var(--text-default);
  margin-bottom: 8px;
}

.metrics-close {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: var(--radius-4);
}

.metrics-close:hover {
  color: var(--text-default);
  background: var(--bg-overlay-l1);
}

.metrics-loading {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 6px 0;
}

.metrics-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.metrics-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.metrics-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}

.metrics-label {
  flex: 1;
  color: var(--text-secondary);
}

.metrics-val {
  color: var(--text-secondary);
  font-family: var(--font-family-metric);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.metrics-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-neutral-l1);
  font-size: 12px;
}

.metrics-total {
  font-weight: var(--font-weight-strong);
  color: var(--text-brand);
  font-family: var(--font-family-metric);
}

.metrics-note {
  margin-top: 6px;
  font-size: 10px;
  color: var(--text-disabled);
  line-height: 1.4;
}
</style>
