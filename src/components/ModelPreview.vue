<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ElMessage } from "element-plus";
import { useI18n } from "vue-i18n";
import { useConfigStore } from "../stores/config";
import { useUiStore } from "../stores/ui";
import { buildScadParams as createScadParams, modelParamsHash } from "../lib/model-params";
import { cacheStlPart, clearStlCache, type StlCacheEntry } from "../lib/stl-cache";
import { usePartMetrics, type PartMetrics } from "../composables/usePartMetrics";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type PartName = "base" | "insert" | "cover" | "stencil_top" | "stencil_bottom";

const store = useConfigStore();
const ui = useUiStore();
const { t } = useI18n();
const canvasEl = ref<HTMLCanvasElement | null>(null);
const containerEl = ref<HTMLElement | null>(null);
const activePart = ref<PartName>("insert");
const loading = ref(false);
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

// three.js 引用(shallowRef 避免响应式包装影响性能)
const scene = shallowRef<THREE.Scene | null>(null);
const camera = shallowRef<THREE.PerspectiveCamera | null>(null);
const renderer = shallowRef<THREE.WebGLRenderer | null>(null);
const controls = shallowRef<OrbitControls | null>(null);
const currentMesh = shallowRef<THREE.Mesh | null>(null);
const animationId = ref<number | null>(null);

// STL 字节缓存:key 是 part 名称(insert/cover/base),value 是 {bytes, paramsHash, geometry?}
// 切换 tab 时如果参数没变,直接用缓存的 bytes 跳过 Python 调用
// bytes 是 ArrayBuffer(Rust 端 tauri::ipc::Response 二进制通道,避免 JSON 数字数组膨胀)
// geometry 是解析后的 BufferGeometry(切 tab 复用,零解析开销);整体替换写入,用 shallowRef
const stlCache = shallowRef<Record<string, StlCacheEntry<THREE.BufferGeometry>>>({});
let disposed = false;
let cacheGeneration = 0;

const paramsHash = () => modelParamsHash(store.config);
const buildScadParams = () => createScadParams(store.config);

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
  r.setSize(w, h);
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
    ui.theme === "dark" ? 0x5C5C5F : 0x737373,
    ui.theme === "dark" ? 0x3A3A3D : 0xD4D4D4,
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
  const moved = controls.value ? controls.value.update() : false;
  if (moved || needsRender) {
    renderer.value.render(scene.value, camera.value);
    // 相机或场景变化后重投影测量标签,保证文字始终贴住测量线
    if (measureTags.value.length) updateMeasureTags();
    needsRender = false;
  }
  // 完全静止 → 暂停循环,等待下一次 invalidate 唤醒
  if (!moved && !needsRender && animationId.value !== null) {
    cancelAnimationFrame(animationId.value);
    animationId.value = null;
  }
}

function disposeMesh() {
  clearMeasure();
  resetTopology();
  if (currentMesh.value) {
    scene.value?.remove(currentMesh.value);
    // geometry 由 stlCache 持有(切 tab 时复用),不在此释放
    if (Array.isArray(currentMesh.value.material)) {
      currentMesh.value.material.forEach((m) => m.dispose());
    } else {
      currentMesh.value.material.dispose();
    }
    currentMesh.value = null;
    invalidate();
  }
}

// 渲染序号:切 tab / 参数变化后,丢弃仍在途的旧请求结果,防止旧模型覆盖新 tab
let renderSeq = 0;

async function renderCurrent(force = false) {
  if (disposed) return;
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
  const cached = stlCache.value[partName];
  const hash = paramsHash();
  if (!force && cached && cached.paramsHash === hash) {
    applyStlToMesh(getOrParseGeometry(partName, cached.bytes, hash));
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
    const params = buildScadParams();
    const part = PART_TO_RUST[partName];
    const bytes = await invoke<ArrayBuffer>("generate_stl", { params, part });

    if (!canCacheResult(hash, generation)) return;
    // 缓存 bytes:key 用捕获的 partName(结果属于发起请求的部件)
    cachePart(partName, bytes, hash, force);

    // 过期检查:期间用户已切 tab / 参数已变 → 不应用,由新的渲染负责
    if (seq !== renderSeq || activePart.value !== partName) return;

    applyStlToMesh(getOrParseGeometry(partName, bytes, hash));
    rendered = true;
  } catch (e) {
    if (seq === renderSeq) {
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
  geometry.center();
  geometry.computeVertexNormals();
  if (entry && entry.paramsHash === hash) entry.geometry = geometry;
  return geometry;
}

// 写入/覆盖部件缓存;hash 变化时释放旧 geometry 防显存泄漏
function cachePart(partName: string, bytes: ArrayBuffer, hash: string, replaceSameHash = false) {
  stlCache.value = cacheStlPart(stlCache.value, partName, bytes, hash, replaceSameHash);
}

function canCacheResult(hash: string, generation: number) {
  return !disposed && generation === cacheGeneration && store.pythonDetected && hasData.value && paramsHash() === hash;
}

// 把 geometry 应用到 mesh(独立函数,缓存命中时直接用)
function applyStlToMesh(geometry: THREE.BufferGeometry) {
  disposeMesh();

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
    mesh.position.y = -geometry.boundingBox.min.y;
  }

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
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    renderCurrent();
  }, 300);
}

// 切换部件时立即渲染
watch(activePart, () => renderCurrent());

// 参数变化 → 防抖重渲染 + 防抖后台预热
// 只跟踪 hash 相关的标量字段与数组引用(pads/outline 都是导入时整体替换,引用变化即内容变化),
// 避免 deep watch 每次改动都遍历数千焊盘造成拖动掉帧
const hashSource = computed(() => {
  const c = store.config;
  return [
    appMode.value,
    c.pcbSizeX, c.pcbSizeY, c.pcbThickness, c.pcbPocketClearance,
    c.pcbOutlinePoints, c.pcbOutlineHoles, c.stencilSizeX, c.stencilSizeY,
    c.screwSpacing, c.screwSpec, c.useHexNut, c.nutAcrossFlats, c.nutHeight,
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
  if (disposed) return;
  preloadTimer = window.setTimeout(() => {
    preloadTimer = null;
    if (store.pythonDetected && !loading.value) void preloadAllParts();
  }, delay);
}

watch(hashSource, () => {
  ++renderSeq; // Invalidate immediately, including during the render debounce.
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
  () => ui.theme,
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
    ? partTabs.value.map((tab) => tab.name)
    : ["base", "insert", "cover"]
);

async function preloadAllParts() {
  // 未导入数据不预热(不浪费 Python 调用,导入后 hashSource 变化会自动触发)
  if (disposed || !store.pythonDetected || !hasData.value) return;
  const hash = paramsHash();
  const generation = cacheGeneration;
  const params = buildScadParams();
  for (const part of allParts.value) {
    if (disposed || loading.value || generation !== cacheGeneration || paramsHash() !== hash) return;
    if (stlCache.value[part]?.paramsHash === hash) continue;
    const pending = preloading.value.get(part);
    if (pending?.hash === hash && pending.generation === generation) continue;

    const request = { hash, generation };
    preloading.value.set(part, request);
    try {
      const rustPart = PART_TO_RUST[part];
      const bytes = await invoke<ArrayBuffer>("generate_stl", { params, part: rustPart });
      if (!canCacheResult(hash, generation)) return;
      cachePart(part, bytes, hash);
      console.log(`[preload] ${part} ready (${(bytes.byteLength / 1024).toFixed(0)} KB)`);
    } catch (e) {
      if (canCacheResult(hash, generation)) console.warn(`[preload] ${part} failed:`, e);
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
  if (renderTimer !== null) window.clearTimeout(renderTimer);
  if (preloadTimer !== null) window.clearTimeout(preloadTimer);
  renderTimer = preloadTimer = null;
  preloading.value.clear();
  const active = activePart.value;
  const activeCache = stlCache.value[active];
  const staleCache = Object.fromEntries(
    Object.entries(stlCache.value).filter(([part]) => part !== active)
  );
  clearStlCache(staleCache);
  stlCache.value = activeCache ? { [active]: activeCache } : {};
  try {
    await renderCurrent(true);
    await preloadAllParts();
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
  (part, params) => invoke<PartMetrics>("part_metrics", { params, part: PART_TO_RUST[part as PartName] }),
);
const { metrics, loading: metricsLoading, load: loadMetrics } = printMetrics;
let metricsTimer: number | null = null;

function scheduleMetrics() {
  if (metricsTimer !== null) window.clearTimeout(metricsTimer);
  metricsTimer = null;
  if (!showMetrics.value || disposed) return;
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
});

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
  renderer.value.setSize(w, h);
  camera.value.aspect = w / h;
  camera.value.updateProjectionMatrix();
  invalidate();
}

// 容器尺寸观察:侧栏拖动只改变容器宽度,不触发 window resize,
// 必须用 ResizeObserver 监听容器本身,否则 canvas 停留旧尺寸、右侧露背景
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
  renderer.value?.dispose();
  scene.value = null;
  camera.value = null;
  renderer.value = null;
  controls.value = null;
});

// 导出 STL / STEP:选父目录 → 自动创建 Mason_<时间戳>/ 子文件夹 → 把所有部件写进子文件夹
async function exportAll(fmt: "stl" | "step") {
  if (!store.pythonDetected) {
    errorMsg.value = t("preview.noPythonExport");
    return;
  }

  const parentDir = await open({
    directory: true,
    multiple: false,
    title: fmt === "stl" ? t("preview.exportStl") : t("preview.exportStep"),
  });
  if (!parentDir || Array.isArray(parentDir)) return;

  loading.value = true;
  errorMsg.value = null;

  try {
    const params = buildScadParams();
    const hash = paramsHash();
    const sep = parentDir.includes("\\") ? "\\" : "/";
    // 自动生成子文件夹名:Mason_YYYYMMDD-HHmmss(同名不会撞,且一眼看出是 Mason 导出)
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const exportDir = `${parentDir}${sep}Mason_${stamp}`;
    await invoke("ensure_dir", { path: exportDir });

    // 钢网模式:只导出导入了焊盘的面(都没导入时导出顶层占位)
    const stencilParts: Array<{ name: PartName; rust: string; filename: string }> = [];
    const c = store.config;
    if (c.stencilPadsTop.length > 0 || c.stencilPadsBottom.length === 0) {
      stencilParts.push({ name: "stencil_top", rust: "stencil_top", filename: `stencil_top.${fmt}` });
    }
    if (c.stencilPadsBottom.length > 0) {
      stencilParts.push({ name: "stencil_bottom", rust: "stencil_bottom", filename: `stencil_bottom.${fmt}` });
    }
    const parts: Array<{ name: PartName; rust: string; filename: string }> =
      appMode.value === "stencil"
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
      if (cached && cached.paramsHash === hash) {
        await invoke("write_file_bytes", { path: fullPath, bytes: cached.bytes });
      } else {
        await invoke("export_stl", { params, part: p.rust, outputPath: fullPath });
      }
    }

    const n = parts.length;
    ElMessage.success(
      fmt === "stl"
        ? t("preview.exported", { n, dir: exportDir })
        : t("preview.exportedStep", { n, dir: exportDir })
    );
  } catch (e) {
    errorMsg.value = t("preview.exportFailed", { msg: e instanceof Error ? e.message : String(e) });
  } finally {
    loading.value = false;
  }
}

const partTabs = computed(() => {
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
  ];
});

// 切换模式时重置 activePart 到该模式的第一个 tab
watch(appMode, (m) => {
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
  <div class="preview-wrapper">
    <div class="preview-header">
      <div class="tab-group">
        <button
          v-for="tab in partTabs"
          :key="tab.name"
          class="tab-btn"
          :class="{ active: activePart === tab.name }"
          @click="activePart = tab.name"
        >
          <span class="tab-dot" :style="{ background: tab.color }" />
          {{ tab.label }}
        </button>
      </div>
      <div class="header-actions">
        <span v-if="preloading.size > 0" class="preload-badge">
          {{ t('preview.preloading', { n: allParts.length - preloading.size }) }}
        </span>
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
        <button class="action-btn" :class="{ active: measureMode }" @click="setMeasureMode(!measureMode)" :title="t('preview.measure')">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M1.6 11.2L11.2 1.6l3.2 3.2-9.6 9.6zM4.4 8.4l1.6 1.6M6.8 6l1.6 1.6M9.2 3.6l1.6 1.6"
              fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {{ t('preview.measure') }}
        </button>
        <button class="action-btn" @click="refreshAll" :disabled="refreshing">
          <svg viewBox="0 0 16 16" width="14" height="14" :class="{ spinning: refreshing }">
            <path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3"
              fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {{ t('preview.refresh') }}
        </button>
        <button class="action-btn" :class="{ active: showMetrics }" @click="toggleMetrics" :title="t('preview.printInfo')">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M8 1.5l5.5 3.1v6.8L8 14.5l-5.5-3.1V4.6zM8 8l5.5-3.1M8 8v6.5M8 8L2.5 4.9"
              fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          </svg>
          {{ t('preview.printInfo') }}
        </button>
        <el-dropdown
          trigger="click"
          @command="(f: string | number | object) => exportAll(f as 'stl' | 'step')"
        >
          <button class="action-btn primary">
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path d="M3 3v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6l-3-3H4a1 1 0 0 0-1 1zM6 3v3h4M8 8v3M6.5 9.5L8 11l1.5-1.5"
                fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {{ t('preview.export') }}
            <svg class="caret" viewBox="0 0 16 16" width="10" height="10">
              <path d="M4 6.5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="stl">{{ t('preview.exportStl') }}</el-dropdown-item>
              <el-dropdown-item command="step">{{ t('preview.exportStep') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <div ref="containerEl" class="canvas-container" :class="{ measuring: measureMode, 'has-preview': !!currentMesh }">
      <canvas
        ref="canvasEl"
        @pointerdown="onCanvasPointerDown"
        @pointerup="onCanvasPointerUp"
        @pointermove="onCanvasPointerMove"
      />
      <!-- 测量面板:显示两个选中对象(可单独删除)+ 测量结果行 -->
      <div v-if="measureMode" class="measure-panel">
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
      <!-- 测量模式提示 -->
      <div v-if="measureMode" class="measure-hint">
        {{ t('preview.measureHint') }}
      </div>
      <!-- 空状态引导:无模型、无加载、无错误时显示(虚线卡片模拟拖放目标) -->
      <div
        v-if="!currentMesh && !loading && !errorMsg && store.pythonDetected"
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
      <div v-if="showMetrics" class="metrics-card">
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
      <div class="viewport-hint">
        {{ t('preview.hint') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* Header */
.preview-header {
  flex: 0 0 auto;
  height: 48px;
  background: var(--bg-base-default);
  border-bottom: 1px solid var(--border-neutral-l1);
  padding: 0 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

/* Tab Group */
.tab-group {
  display: flex;
  gap: 2px;
  flex: 1;
}

.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-6);
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
  font-family: inherit;
}

.tab-btn:hover {
  background: var(--bg-overlay-l1);
  color: var(--text-secondary);
}

.tab-btn.active {
  background: var(--bg-overlay-l2);
  color: var(--text-default);
}

.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}

/* Header Actions */
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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
  border: 1px solid var(--border-neutral-l2);
  border-radius: var(--radius-6);
  background: var(--bg-base-default);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease;
  font-family: inherit;
}

.action-btn:hover {
  background: var(--bg-overlay-l1);
  border-color: var(--border-neutral-l3);
  color: var(--text-default);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

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

.action-btn .caret {
  margin-left: -2px;
  opacity: 0.8;
}

/* 视图快捷按钮组(正/顶/等轴) */
.view-btns {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border-neutral-l2);
  border-radius: var(--radius-6);
  background: var(--bg-base-default);
}

.view-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  border: none;
  border-radius: var(--radius-4);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}

.view-btn:hover {
  background: var(--bg-overlay-l1);
  color: var(--text-default);
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
  background: radial-gradient(120% 90% at 50% 38%, #FFFFFF 0%, #F1F1F0 62%, #E8E8E6 100%);
}

html.dark .canvas-container {
  background: radial-gradient(120% 90% at 50% 38%, #2C2C2F 0%, #232325 62%, #1D1D1F 100%);
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

html.dark .measure-tag.direct {
  color: #3bc494;
}

html.dark .measure-tag.horizontal {
  color: #e8b06a;
}

html.dark .measure-tag.vertical {
  color: #8fb0d6;
}

html.dark .measure-tag {
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
  left: 12px;
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

html.dark .measure-panel {
  background: rgba(30, 30, 32, 0.95);
  border-color: rgba(255, 255, 255, 0.1);
}

.measure-panel-head {
  font-size: 12px;
  font-weight: var(--font-weight-strong, 600);
  color: var(--text-primary);
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
  color: var(--text-primary);
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
  color: var(--text-primary);
}

html.dark .sel-del:hover {
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
  color: var(--text-primary);
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
  border: 1.5px dashed var(--border-neutral-l3);
  border-radius: var(--radius-12, 12px);
  background: var(--bg-overlay-l1);
}

html.dark .empty-card {
  background: rgba(255, 255, 255, 0.03);
}

.empty-icon {
  color: var(--text-disabled);
  margin-bottom: 6px;
}

.empty-line1 {
  margin: 0;
  font-size: 13px;
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-tertiary);
}

.empty-line2 {
  margin: 0;
  font-size: 11px;
  color: var(--text-disabled);
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

.canvas-container.has-preview .overlay {
  background: rgba(245, 245, 245, 0.28);
  backdrop-filter: blur(1px);
}

html.dark .canvas-container.has-preview .overlay {
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
  backdrop-filter: blur(4px);
}

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
