# Mason

> PCB 锡膏印刷工具集 — 从 JLCPCB / 嘉立创 EDA 导出的 Gerber ZIP 文件,一键生成
> 可 3D 打印的锡膏刷夹具(**jig**)或 frameless 锡膏印刷钢网(**stencil**)。

![Tauri 2](https://img.shields.io/badge/Tauri-2-blue?logo=tauri)
![Vue 3](https://img.shields.io/badge/Vue-3-42b883?logo=vue.js)
![Rust](https://img.shields.io/badge/Rust-stable-orange?logo=rust)
![License](https://img.shields.io/badge/license-MIT-green)

Mason 是一个 Tauri 2 桌面应用,提供两种 PCB 锡膏印刷生成模式:

- **夹具模式 (Jig)** — 生成 3 件套底座/插板/顶盖,把 PCB 和钢网一起压紧定位,适合小批量、异形 PCB、DIY
- **钢网模式 (Stencil)** — 直接根据 paste mask 生成 frameless 钢网 STL,适合把钢网放到用户已持有的固定框里

---

## 功能

- 📦 **Gerber ZIP 导入** — 拖入 JLCPCB / 嘉立创 EDA 导出的 ZIP,自动识别板框文件(`.GKO` / `Edge.Cuts` / `.GM1`)和 paste mask(`.GTP` / `.GBP`),支持异形板框(含 G02/G03 弧线)

- 🧩 **双模式生成** — 一键切换夹具 vs 钢网;夹具三件套 STL + STL 预览,钢网模式直接输出 frameless 钢网

- ⚙️ **可调参数** — PCB 尺寸、钢网尺寸、螺丝间距、插板厚度/支撑柱、钢网桥接/板厚,实时联动

- 🔩 **多螺丝均匀压紧** — 默认 4 角,可配置每 30\~50mm 加 1 颗,大尺寸 PCB 也压得平

- 🖥️ **实时 3D 预览** — three.js 直接加载 STL,鼠标旋转/缩放/平移,多部件后台预热秒切

- 📐 **可复用底座/顶盖** — 夹具按 20mm 步进,相同尺寸的 PCB 共用,只重打 PCB 插板

- 💾 **项目保存/加载** — 整套参数(含异形板框)存为 JSON,方便复用

- 🌐 **中英双语** — 界面文案 i18n 切换,跟模式切换联动

- 💽 **导出打包** — 自动创建时间戳子文件夹,把生成的多件 STL 一并打包导出

---

## 技术架构

**Tauri 2 (Rust) + Vue 3 + Python (build123d + Shapely)** 混合架构:

```
┌────────────────────┐   IPC    ┌─────────────┐   spawn   ┌──────────────────┐
│  Vue 3 前端        │ ───────▶ │  Rust 后端   │ ────────▶ │ Python CAD 引擎  │
│  three.js 3D 预览  │          │  参数 JSON   │           │ build123d+Shapely│
│  Pinia 参数状态    │ ◀─────── │  STL bytes  │ ◀──────── │ jig_generator.py │
└────────────────────┘          └─────────────┘           └──────────────────┘
```

- 前端把参数发给 Rust,Rust 写 JSON 并调用 `python/jig_generator.py` 生成 STL
- STL 按参数哈希缓存在前端,切 tab 不重算;应用启动时后台预热各部件
- 导出时 Rust 自动创建时间戳子文件夹,把生成的多件 STL 直接落到磁盘

---

## 夹具设计 (Jig 模式)

三个打印件,全部 `jig_size × jig_size` 正方形(按钢网尺寸 +30mm、20mm 步进自动计算):

```
┌──────────────────────┐
│  钢网夹 A 面 · 顶盖   │ ← cover,4mm,中央窗口 + 螺丝过孔 + 螺母沉孔
├──────────────────────┤
│  钢网(用户自有)      │ ← frameless 即可
├──────────────────────┤
│  PCB 托盘 insert      │ ← 8mm,PCB 槽(支持异形) + 4 角大柱 + 4 内部支撑柱
├──────────────────────┤
│  钢网夹 B 面 · 底座   │ ← base,4mm,中央窗口 + 4 角螺柱(凸出 6mm)
└──────────────────────┘
```

装配与使用:

1. PCB 放入托盘中央凹槽(摩擦配合,槽深 = PCB 厚 + 0.2mm)
2. 钢网放在 PCB 上(方向对齐)
3. 顶盖盖上,螺丝穿过顶盖过孔、托盘 4 角大柱,拧入底座螺柱
4. 拧紧蝶形螺母 → 顶盖压钢网 → 钢网压 PCB
5. 刮刀刷锡膏,完成后松开取出 PCB

---

## 钢网模式 (Stencil)

直接读 paste mask(`*.GTP` / `*.GBP`),提取每个 pad 的真实形状(矩形 / 圆 / 多边形),
生成与板框对齐的 frameless 钢网 STL。可调板厚、桥接、框架外边距。

输出 STL 不带边框,适合配合用户已有的钢网固定框使用,也可直接发给钢网厂家切割。

---

## 快速开始(开发模式)

### 环境要求

- **Node.js 20+**
- **Rust 1.77+**(`rustup install stable`)
- **Python 3.10+**(开发模式用系统 Python;发布版自带内置引擎,见下)

```bash
# 安装 Python 依赖(开发模式)
pip install -r python/requirements.txt   # build123d shapely numpy

# 前端依赖 + 开发运行
npm install
npm run tauri:dev
```

开发模式下应用自动探测 Python(PATH / 常见安装位置),也可在「Python + build123d」卡片手动指定;若缺依赖,卡片提供一键安装(清华镜像)。

### 打包发布(内置 CAD 引擎,用户零配置)

发布包自带完整的 Python + CAD 依赖运行时,最终用户**无需安装任何环境**:

```bash
npm run build:python-env   # 构建内置引擎(python.org 嵌入式发行版 + 依赖,~200MB 下载)
npm run tauri:build        # 打包(内置引擎收进 resources,NSIS 压缩后安装包 ~+400MB)
```

产物 `.msi` / `.exe` 在 `src-tauri/target/release/bundle/`。

内置引擎的解析优先级:用户手动配置 > 内置引擎 > 系统 Python —— 开发者机器上已配置的 Python 不受影响。

---

## 螺丝布局算法

4 角恒有 + 沿周长按 `screw_spacing` 等距补中间螺丝:

```text
jig_size = ceil((stencil_size + 30) / 20) * 20    # 20mm 步进
offset = 8                                         # 角螺丝内缩
# 上/下边(含两角) + 左/右边(跳过角)
```

例如 140×140mm 夹具 + 60mm 间距 = 8 颗螺丝(4 角 + 每边 1 中间)。

---

## 参数速查

### 夹具参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `pcbSizeX` / `pcbSizeY` | 50 | PCB 尺寸(拖入 Gerber 自动填充) |
| `pcbThickness` | 1.6 | PCB 厚度,决定托盘槽深 |
| `stencilSize` | 100 | 钢网边长(正方形) |
| `jigSize` | 140 | 夹具边长,从钢网尺寸自动算,可手动覆盖 |
| `screwSpacing` | 60 | 周长螺丝间距 |
| `insertHeight` | 8 | PCB 托盘厚度 |
| `pcbSupportRadius` / `pcbSupportOffset` | 5 / 58 | 托盘内部支撑柱半径 / 中心偏移 |
| `baseHeight` / `topCoverHeight` | 8 / 4 | 底座 / 顶盖厚度 |
| `postDiameter` / `postHeight` | 6 / 6 | M3 螺柱直径 / 凸出高度 |

### 钢网参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `stencilThickness` | 0.2 | 钢网板厚(mm) |
| `frameMargin` | 8 | 框架外边距(用于贴固定框或厂家切割定位) |
| `bridgeWidth` | 0 | paste mask 之间的最小桥宽 |

---

## 目录结构

```text
mason/
├── .github/workflows/ci.yml            # GitHub Actions:vitest + vue-tsc + cargo check + python tests
├── public/                             # 静态资源 (logo.svg 等)
├── scripts/build-python-env.ps1        # 内嵌 Python 运行时构建脚本
├── src/                                # Vue 3 前端
│   ├── components/
│   │   ├── GerberImport.vue            # 拖拽 ZIP + 板框识别 + SVG 预览
│   │   ├── ConfigForm.vue              # 夹具模式参数
│   │   ├── StencilForm.vue             # 钢网模式参数
│   │   ├── ScrewDiagram.vue            # 螺丝分布 SVG
│   │   ├── ModelPreview.vue            # three.js 3D 预览 + STL 缓存 + 导出
│   │   ├── PythonSetup.vue             # Python 路径配置
│   │   ├── ProjectMenu.vue             # 保存/加载项目
│   │   └── SettingsMenu.vue            # 设置 / 关于 / GitHub 链接
│   ├── composables/
│   │   ├── useGerberOutline.ts         # 板框提取 + SVG 预览
│   │   └── useGerberStencil.ts         # paste mask 提取 + 钢网生成参数
│   ├── lib/gerber/                     # 自研 Gerber 解析器
│   │   ├── parser.ts                   # RS-274X,跨行弧线模式跟踪
│   │   ├── bbox.ts                     # 包围盒(含弧线极值)
│   │   ├── outline-detect.ts           # 板框文件识别
│   │   ├── paste-detect.ts             # paste mask 文件识别
│   │   ├── pads.ts                     # paste 几何提取(矩形/圆/多边形)
│   │   └── __tests__/                  # vitest 单元测试
│   ├── i18n/{zh,en,index}.ts           # 中英双语文案
│   ├── stores/{config,ui}.ts           # Pinia:全局配置 / UI 状态
│   ├── App.vue, main.ts, style.css, traework-theme.css
├── src-tauri/                          # Rust 后端
│   └── src/
│       ├── commands.rs                 # IPC 命令(生成/导出/项目/路径)
│       ├── scad.rs                     # Python 子进程调用 + 字节回流
│       ├── openscad_detect.rs          # Python 探测 + 路径归化
│       ├── error.rs                    # 统一错误类型
│       └── lib.rs, main.rs
│   ├── capabilities/default.json       # Tauri 权限声明
│   └── tauri.conf.json
├── python/
│   ├── jig_generator.py                # ⭐ build123d CAD 生成(base/insert/cover/stencil)
│   ├── requirements.txt
│   └── tests/                          # 几何/装配 端到端测试 (test_*.py)
├── test_gerber/                        # 示例 Gerber ZIP 原料(JLCPCB 风格)
├── package.json, vite.config.ts, tsconfig.json, index.html
└── README.md
```

---

## 测试

```bash
npm test                        # vitest: Gerber 解析 + paste / pads 单元测试
npm run build                   # vue-tsc 类型检查 + vite 构建
cd src-tauri && cargo check     # Rust 类型检查
python python/tests/run_all.py  # build123d 几何端到端 (test_holes / test_irregular / test_stencil ...)
```

CI 由 `.github/workflows/ci.yml` 串联以上四步,触发 push / PR 自动跑。

---

## 常见问题

### Q: 应用启动后显示"未检测到 Python"?

A: 应用启动时探测 PATH 和标准安装位置。如果 Python 装在自定义位置,在「Python + build123d 环境」卡片手动指定 `python.exe`,路径持久化到 `%APPDATA%\cn.local.mason\settings.json`。注意需要已安装 `build123d`、`shapely`、`numpy`。

### Q: Gerber ZIP 解析失败?

A: 检查 ZIP 里是否有 `.GKO` / `*Edge.Cuts*` / `.GM1` 文件。如果都没有,展开「其他候选」手动看下文件名,可能是 JLCPCB 的特殊命名。钢网模式还需要 `.GTP` 或 `.GBP` 的 paste mask。

### Q: 钢网和 PCB 对位偏了?

A:
1. 检查顶盖窗口尺寸是否与钢网匹配(窗口 = 钢网 - 1mm,每边压 0.5mm)
2. 检查 PCB 是否完全推入托盘中央凹槽
3. 螺丝对称交叉拧紧,不要一次拧死一颗

### Q: 想要更小的螺丝间距?

A: 「周长间距」滑块调到 25-30mm,4 角 + 中间螺丝更多,压力更均匀。20mm 以下可能螺丝互打架。

### Q: 导出的文件去哪了?

A: 导出时 Rust 会自动在所选目录创建一个 `mason_export_<时间戳>/` 子文件夹,把所有生成的 STL 放进去,避免和现有文件混淆。

---

## 品牌

Logo 使用 Mason 自研的「B1 竖向蛇形砖墙」:vertical serpentine path,起点绿、终点橙,
呼应 PCB 走线 + 锡膏印刷的连接意象。

---

## 许可证

MIT

---

## 致谢

- [build123d](https://github.com/gumyr/build123d) — Python 参数化 CAD 内核
- [Tauri](https://tauri.app/) — 优秀的桌面应用框架
- [Vue 3](https://vuejs.org/) / [Pinia](https://pinia.vuejs.org/) / [Element Plus](https://element-plus.org/) / [three.js](https://threejs.org/)