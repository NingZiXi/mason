# Mason

> 从 JLCPCB / 嘉立创EDA 导出的 Gerber ZIP 文件,一键生成可 3D 打印的锡膏印刷钢网定位夹具。

## 功能

- 📦 **Gerber ZIP 导入** — 拖入 JLCPCB / 嘉立创EDA 导出的 ZIP,自动识别板框文件(`.GKO` / `Edge.Cuts` / `.GM1`),支持异形板框(含 G02/G03 弧线)

- ⚙️ **可调参数** — PCB 尺寸、钢网尺寸、螺丝间距、插板厚度/支撑柱,实时联动

- 🔩 **多螺丝均匀压紧** — 默认 4 角,可配置每 30\~50mm 加 1 颗,大尺寸 PCB 也压得平

- 🖥️ **实时 3D 预览** — three.js 直接加载 STL,鼠标旋转/缩放/平移,3 部件后台预热秒切

- 📐 **可复用底座/顶盖** — 夹具按 20mm 步进,相同尺寸的 PCB 共用,只重打 PCB 插板

- 💾 **项目保存/加载** — 整套参数(含异形板框)存为 JSON,方便复用

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

- STL 按参数哈希缓存在前端,切 tab 不重算;应用启动时后台预热 3 个部件

- 导出时 Python 直接输出到目标路径(Rust `export_stl` 命令),无中间字节传输

## 夹具设计

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

内置引擎的解析优先级:用户手动配置 > 内置引擎 > 系统 Python——开发者机器上已配置的 Python 不受影响。

## 螺丝布局算法

4 角恒有 + 沿周长按 `screw_spacing` 等距补中间螺丝:

```
jig_size = ceil((stencil_size + 30) / 20) * 20    # 20mm 步进
offset = 8                                         # 角螺丝内缩
# 上/下边(含两角) + 左/右边(跳过角)
```

例如 140×140mm 夹具 + 60mm 间距 = 8 颗螺丝(4 角 + 每边 1 中间)。

## 参数速查

| 参数                                      | 默认     | 说明                     |
| --------------------------------------- | ------ | ---------------------- |
| `pcbSizeX` / `pcbSizeY`                 | 50     | PCB 尺寸(拖入 Gerber 自动填充) |
| `pcbThickness`                          | 1.6    | PCB 厚度,决定托盘槽深          |
| `stencilSize`                           | 100    | 钢网边长(正方形)              |
| `jigSize`                               | 140    | 夹具边长,从钢网尺寸自动算,可手动覆盖    |
| `screwSpacing`                          | 60     | 周长螺丝间距                 |
| `insertHeight`                          | 8      | PCB 托盘厚度               |
| `pcbSupportRadius` / `pcbSupportOffset` | 5 / 58 | 托盘内部支撑柱半径 / 中心偏移       |
| `baseHeight` / `topCoverHeight`         | 8 / 4  | 底座 / 顶盖厚度              |
| `postDiameter` / `postHeight`           | 6 / 6  | M3 螺柱直径 / 凸出高度         |

## 目录结构

```
mason/
├── src/                              # Vue 3 前端
│   ├── components/
│   │   ├── GerberImport.vue          # 拖拽 ZIP + 板框识别 + SVG 预览
│   │   ├── ConfigForm.vue            # PCB/钢网/螺丝/插板参数
│   │   ├── ScrewDiagram.vue          # 螺丝分布 SVG
│   │   ├── ModelPreview.vue          # three.js 3D 预览 + STL 缓存
│   │   ├── PythonSetup.vue           # Python 路径配置
│   │   └── ProjectMenu.vue           # 保存/加载项目
│   ├── lib/gerber/                   # 自研 Gerber 解析器
│   │   ├── parser.ts                 # RS-274X,跨行弧线模式跟踪
│   │   ├── bbox.ts                   # 包围盒(含弧线极值)
│   │   ├── outline-detect.ts         # 板框文件识别
│   │   └── __tests__/                # vitest 单元测试
│   ├── composables/useGerberOutline.ts
│   └── stores/config.ts              # Pinia 全局配置
├── src-tauri/                        # Rust 后端
│   └── src/
│       ├── commands.rs               # IPC 命令(生成/导出/项目/路径)
│       ├── scad.rs                   # Python 子进程调用
│       ├── openscad_detect.rs        # Python 探测 + 路径归化
│       └── error.rs
├── python/
│   ├── jig_generator.py              # ⭐ build123d CAD 生成(base/insert/cover)
│   └── requirements.txt
└── README.md
```

## 测试

```bash
npm test                       # Gerber 解析单元测试
npm run build                  # vue-tsc 类型检查 + vite 构建
cd src-tauri && cargo check    # Rust 类型检查
```

## 常见问题

### Q: 应用启动后显示"未检测到 Python"?

A: 应用启动时探测 PATH 和标准安装位置。如果 Python 装在自定义位置,在「Python + build123d 环境」卡片手动指定 `python.exe`,路径持久化到 `%APPDATA%\cn.local.mason\settings.json`。注意需要已安装 `build123d`、`shapely`、`numpy`。

### Q: Gerber ZIP 解析失败?

A: 检查 ZIP 里是否有 `.GKO` / `*Edge.Cuts*` / `.GM1` 文件。如果都没有,展开「其他候选」手动看下文件名,可能是 JLCPCB 的特殊命名。

### Q: 钢网和 PCB 对位偏了?

A:

1. 检查顶盖窗口尺寸是否与钢网匹配(窗口 = 钢网 - 1mm,每边压 0.5mm)
2. 检查 PCB 是否完全推入托盘中央凹槽
3. 螺丝对称交叉拧紧,不要一次拧死一颗

### Q: 想要更小的螺丝间距?

A: 「周长间距」滑块调到 25-30mm,4 角 + 中间螺丝更多,压力更均匀。20mm 以下可能螺丝互打架。

## 许可证

MIT

## 致谢

- [build123d](https://github.com/gumyr/build123d) — Python 参数化 CAD 内核

- Tauri 团队 — 优秀的桌面应用框架

