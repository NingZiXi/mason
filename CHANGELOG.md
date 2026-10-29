# Changelog

## [0.1.8] - 2026-10-29

### Fixes

- 打印体积与重量会随参数修改重新计算；失败时可重试，过期结果不会覆盖新参数的结果。
- 修复 STL 预加载覆盖已解析几何、刷新后缓存状态不一致和几何资源未正确释放的问题。
- 缺少有效板框时，按顶层与底层焊盘的合并范围生成回退边界，避免遗漏另一面的焊盘。
- 导入新板框但没有焊盘时，正确清除前一个工程遗留的焊盘数据。
- 钢网整面极性会传入 CAD 参数并参与模型缓存校验，确保反相焊盘正确生成且缓存及时失效。

### Performance

- Element Plus 改为只注册实际使用的组件，移除未使用的全量图标注册，生产 JavaScript 压缩体积减少约 40%。
- 首次导入优先生成当前显示部件，其余部件在后台逐个预热；刷新时保留现有预览直至新模型生成完成。

## [0.1.7] - 2026-10-26

### Features

- **In-app updates**: installed releases check for updates on startup. The About page shows release notes and supports confirmed download, installation and restart of signed updates.
- Release workflows publish signed updater artifacts and a `latest.json` manifest for Windows, Apple Silicon macOS and Linux AppImage.

### Fixes and Improvements

- Project save/load now preserves the full application parameter set.
- Release workflows validate version consistency and require the signing key before building update artifacts.

## [0.1.6] - 2026-10-25

### Features

- **3D 交互式测量工具（仿 Bambu Studio）**：预览工具栏新增「测量」按钮。悬停即可高亮识别四类特征——顶点（坐标）、边（共线合并后的整条棱，给长度）、圆（孔缘拟合，给直径/半径）、平面（共面簇聚合，给面积）；特征识别与 Bambu Studio（PrusaSlicer）同源思路。依次点击两个对象完成测量，左上角面板列出所选对象（① 橙 / ② 蓝双色区分）并支持单独删除重选；测量结果按组合自动切换：点-点给直线 + 水平/垂直三色分解，点-边/面给垂线距离，边-边给公垂线与夹角，面-面给夹角或平行间距。`Esc` 退出，拖拽旋转与右键平移不受影响。

### Bug Fixes

- **测试点过滤参数不刷新模型**：钢网模式下「过滤测试点 / 最大直径 / 孤立距离」三个参数未纳入前端渲染缓存 hash，改动后命中旧缓存、模型不更新。现补齐（与 v0.1.5 定位柱间隙同类遗漏）。
- **测量取点误触**：右键平移、中键缩放时的单击不再被误识别为测量取点，仅左键取点。

### Improvements

- **装配间隙默认值收紧**：PCB 卡槽间隙 0.3 → 0.2mm，定位柱间隙 0.4 → 0.15mm（前端 / Rust / Python 三层默认值同步），FDM 打印配合更紧致；仍可在参数面板自由调整。
- **测量性能优化**：特征屏幕投影按相机签名缓存（相机静止时跳过重复投影）、标记球共享几何、rAF 合并悬停拾取。

## [0.1.5] - 2026-10-25

### Bug Fixes

- **修复内置 CAD 引擎启动即崩溃（v0.1.4 回归）**：v0.1.4 为修复打包把 build123d 从 0.12.0 降到 0.11.1，而 0.11.1 缺少 0.12.0 中对非法字体文件的 `TTLibError` 保护。build123d 在 `import` 阶段会扫描系统字体目录，遇到扩展名为 `.ttf` 但内容非字体的文件即抛异常，导致引擎进程直接退出、界面报「Python CAD 引擎已退出」。现恢复为 build123d 0.12.0，同时继续锁定 cadquery-ocp-novtk 7.9.3.1.1，并同步 CI 与本地环境构建脚本，避免版本再次漂移。

### Improvements

- **引擎错误诊断增强**：引擎异常退出时，报错遮罩现在会显示引擎绝对路径、日志路径以及日志尾部的真实 traceback，替代原先笼统的「引擎已退出」提示；遮罩支持多行换行与滚动，长诊断信息不再被截断。同时移除了对内置引擎有误导性的 `pip install` 提示。
- **安装包瘦身**：内置 Python 环境中 `threejs_materials` 的 67 个 PNG 法线贴图（85.6MB）仅用于 three.js 材质渲染，几何建模与 STL/STEP 导出完全不涉及，构建时统一裁剪。恢复 build123d 0.12.0 会额外带入依赖，抵消部分收益，Windows 安装包最终为 105.5MB（v0.1.4 为 99.0MB）；若不裁剪则约为 190MB。

## [0.1.4] - 2026-10-23

### Features

- **拼版 Gerber 双口径建模**：导入嘉立创/EasyEDA Pro 导出的拼版 Gerber 时，现在能正确识别整版。解析器补全 `%SR` 步进重复的 `I/J` 与 `X/Y` 两种间距写法并展开阵列；轮廓提取改用含工艺边 / V-CUT 框的整版包围盒。导入预览卡片显示拼版阵列（列 × 行），并弹出对话框让用户选择「整版（含工艺边）」或「单块单板」；该口径在参数面板顶部也可随时切换，切换后自动重算钢网尺寸与唇宽。
- **钢网长宽独立可调（支持矩形钢网）**：钢网夹具的钢网尺寸由单一正方形改为长(X)/宽(Y) 两个独立输入（10~290mm，5mm 步进），可直接按实际购买的矩形钢网建模。凸台与 A/B 框窗口逐轴跟随钢网变为矩形，夹具底板仍保持正方形。

### Improvements

- **唇宽改为单条滑块**：钢网外缘压在凸台上的唇宽（0 ~ 上限）由一条滑块控制，四边一致；读数实时显示凸台与窗口的逐轴尺寸。唇宽上限取两轴中更紧的一侧，保证凸台每轴都不小于 PCB 槽，避免 PCB 悬空。
- **旧项目文件兼容**：单值 `stencil_size` 自动映射到 X/Y 两轴；旧项目的 `platter_width` / `platter_margin` 会反推为等效唇宽，老工程文件仍可正常打开。

### Bug Fixes

- **CI 几何验证长期失败**：`test_v2` 把 4 角定位柱孔径硬编码为 `r=4.7`，未跟随 v0.1.3 新增的 `post_clearance`（默认 0.4mm，实际孔径 `corner_d/2 + 2.0 + post_clearance`）。现改为与 `jig_generator.build_base` 同源推导，几何验证恢复全绿。
- **测试用例适配新参数语义**：`test_screw_spec`（周圈孔位改为按窗口几何动态推导）、`test_notch_depth`（期望缺口深度改为 `min(10mm, 实测壁深)`）、`test_notch_stencil`（改用新 API 复现同一凸台几何）同步更新。

## [0.1.3] - 2026-09-19

### Features

- **4 角定位柱间隙可配置**：新增 `post_clearance` 参数（默认 0.4mm），控制 4 角定位柱与 A/B 面顶盖/底座孔之间的径向间隙，适配 FDM 打印收缩；新增 `postClearance` UI 控件位于「装配间隙」区，并新增回归测试 `test_post_clearance_geometry_change` 验证参数确实生效。

## [0.1.2] - 2026-09-19

### Improvements

- **PCB 卡槽间隙默认值提升至 0.3mm**：钢网夹具与 PCB 钢网两个模式的板框卡槽间隙默认值从 0.1/0.15mm 统一提升至 0.3mm（每边），适配 FDM 打印收缩与尺寸误差，避免 PCB 卡入过紧。参数仍保留在各自表单中可手动调节。
- **卡槽间隙文案与工艺提示**：标签改为「PCB 卡槽间隙」，并新增工艺提示「FDM 建议 0.2~0.5mm；光固化/CNC 可减小到 0.1mm」，帮助用户根据打印工艺选择合适的余量。

## [0.1.1] - 2026-09-11

### Features

- **体积·用料估算**：新增 Python `stats` 命令精确计算各部件体积(mm³)与表面积(mm²)，前端「打印信息」卡按 PLA 密度 1.24 g/cm³ 估算耗材克重，支持三部件合计。
- **结构预设**：新增「标准(M3)/轻型(M2.5)/重型(M4)」三档一键套用，自动联动螺丝孔径、螺母对边与结构高度，PCB/钢网/焊盘不受影响。
- **诊断日志落盘**：Python CAD 引擎的 stderr 重定向到应用日志目录 `mason-python.log`，渲染失败时便于定位底层 OCC/build123d 异常。

### Improvements

- **Python 脚本单一来源**：`build.rs` 在编译期自动将权威副本 `python/jig_generator.py` 同步到打包资源目录，消除两份手工维护的内容分歧。
- **清理 OpenSCAD 遗留命名**：`openscad_detect.rs` 重命名为 `python_detect.rs`，错误类型 `OpenScadNotFound` 等统一改为 `Python*` 命名。
- **FDM 打印可行性校验**：钢网边框宽 <1mm、网格条宽 <0.5mm 时给出打印脆弱/打不出的非阻塞警告。
- **CI 接入 pytest 回归测试**：geometry job 补装 pytest，新增 `python/test_jig_generator.py` 回归测试（螺丝公式/网格行为/端到端冒烟）。

### Bug Fixes

- **螺母六角沉孔对边距偏小**：M3 螺母对边距实际只有 4.76mm（应为 5.5mm），导致螺母无法装入。根因是将对边距直接除以 2 作为外接圆半径，但正六边形对边距 = 半径 × √3，现修正为 `nut_across / √3`，各规格螺母对边距均精确匹配 GB/T 6170 标准。

  | 规格 | 修复前 | 修复后 |
  |------|--------|--------|
  | M2.5 | 3.90mm | 4.50mm |
  | M3   | 4.76mm | 5.50mm |
  | M3.5 | 5.20mm | 6.00mm |
  | M4   | 6.06mm | 7.00mm |
  | M5   | 6.93mm | 8.00mm |

- **大孔开网格阈值减小无效**：`_grid_pad_geom` 中 `min_cell` 固定为 0.8，导致有效网格化门槛恒为约 2.1mm，`size_thr` 调到 2mm 以下仍无效果。现改为随阈值动态缩放 `max(0.3, min(0.8, size_thr * 0.4))`，中等焊盘(1.0~2.0mm)在阈值降低后可正常网格化。
