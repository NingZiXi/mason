# PCB 钢网直接生成 - 产品需求文档

## Overview

- **Summary**: 在现有「PCB 钢网夹具生成器」基础上,新增一个并列的工作模式——直接生成可 3D 打印的 PCB 钢网模型。该钢网**自带 PCB 卡槽(凹陷)**:凹陷深度 = PCB 厚度,PCB 从顶面卡入凹槽、焊盘朝下,凹槽底部是带焊盘开孔的薄钢网层(即底面)。用户将 PCB 放入凹槽后,**在底面钢网层上刮锡膏**,锡膏穿过开孔到达 PCB 焊盘,**无需搭配钢网夹具,独立使用**。

- **Purpose**: 降低小批量/原型阶段的锡膏印刷门槛——3D 打印一体式钢网当天可用,PCB 靠凹槽自动定位,无需夹具、无需金属钢网。

- **Target Users**: 电子硬件开发者、原型打样人员、小批量生产者。

## Goals

- 从 Gerber 锡膏层(Paste Layer)提取所有焊盘形状,生成带开孔的一体式钢网 STL。

- 钢网自带 PCB 卡槽:凹槽深度 = PCB 厚度,PCB 卡入后靠凹槽壁定位。

- 凹槽底部为薄钢网层(焊盘开孔只贯穿这一层,不贯穿整块板)。

- 提供与夹具流程并列的独立工作模式(顶部模式切换),互不干扰。

- 核心参数(钢网层厚度、边框宽、焊盘缩小)提供合理默认,用户「拖入 Gerber → 导出」即可用。

## Non-Goals

- 不替代金属钢网的高精度量产场景(3D 打印钢网精度有限,本功能定位原型/小批量)。

- 不支持钢网张力/网架等高级金属钢网工艺参数。

- 不在本次实现多图层焊盘合并/修盘(只取锡膏层原样)。

- 不实现 Bottom 面自动翻转对齐的复杂逻辑(首版仅 Top 面;Bottom 面用户手动翻转 PCB)。

## Background & Context

- 现有应用为「钢网夹具」三部件生成器(base/insert/cover),夹紧一块**预制金属钢网**进行印刷。

- 新功能生成的是**一体式钢网**——自带 PCB 卡槽的薄板,焊盘位置在槽底挖穿。PCB 放入卡槽后靠凹槽壁自动定位,直接在顶面刮锡膏,**不需要搭配夹具、不需要金属钢网**。

- 现有 Gerber 解析器(`src/lib/gerber/parser.ts`)只提取板框轮廓(D01/D02,跳 D03 flash、不解析 aperture)。钢网需要的焊盘数据来自锡膏层(D03 flash + aperture 定义),需新增解析能力。

- 几何生成在 Python(build123d),与现有三部件同文件 `python/jig_generator.py`,新增 `build_stencil` 函数。

- 数据流沿用现有链路:TS 解析 → Rust 透传 → Python 生成 STL → 前端预览/导出。

## Functional Requirements

### 焊盘提取(TS 侧)

- **FR-1**: 支持从 Gerber ZIP 中自动识别锡膏层文件(扩展名 `.GTP`/`.GBP`,或文件名含 `paste`/`Paste`)。

- **FR-2**: 解析锡膏层 Gerber 的 aperture 定义(`%ADD`),支持圆形(C)、矩形(R)、长圆形(O)三种标准孔径。

- **FR-3**: 提取所有 D03 flash 焊盘——按当前 aperture 形状生成对应 2D 多边形(圆心/矩形/长圆),坐标居中到板框 bbox 中心(与 outline 同坐标系)。

- **FR-4**: 提取 D01 绘制的线条焊盘(按当前 aperture 作为线宽,生成矩形多边形),覆盖 SOP/QFP 等长焊盘。

- **FR-5**: 焊盘多边形输出到 Rust/Python 的格式为 `[{points: [[x,y],...], type: "circle"|"rect"|"obround"|"poly"}]`,圆形/矩形也展开为多边形点列(便于 Python 统一 cut)。

### 钢网几何(Python 侧)

- **FR-6**: 新增 `build_stencil(params)` 生成单一部件:一体式钢网 = 外框(含顶面 PCB 卡槽)+ 底面薄钢网层。**构建坐标:z=0 为底面(钢网层/刮刀面),z 向上递增;总厚度 = PCB 厚度 + 钢网层厚度(`stencil_thickness`,默认 0.3mm)。**

- **FR-7**: 钢网外轮廓 = PCB 板框轮廓外扩 `stencil_frame_width`(默认 8mm),圆角与外框一致。**底面(z=0 面)平整 = 刮刀面**;顶面有卡槽凹陷。**不依赖夹具凸台,外形由 PCB 尺寸推导,独立使用。**

- **FR-8**: PCB 卡槽:按 PCB 板框轮廓(+ `pocket_clearance` 间隙,默认 0.2mm)从顶面(z = pcb\_thickness + stencil\_thickness)向下挖凹槽,深度 = PCB 厚度(`pcb_thickness`),槽底落在 z = stencil\_thickness 处(即钢网层顶面)。PCB 放入后焊盘朝下、贴在钢网层上,靠凹槽壁定位。

- **FR-8a**: 焊盘开孔从底面(z=0)向上贯穿钢网层到槽底(z = stencil\_thickness),不进入卡槽区域。焊盘中心与板框坐标系一致。锡膏从底面刮入、穿过开孔到达 PCB 焊盘。

- **FR-8b**: 焊盘开孔支持按比例缩小(参数 `pad_shrink`,百分比 0\~50%,默认 10%):每个焊盘多边形以自身中心为基准等比缩小,用于补偿厚钢网(尤其 FDM)带来的锡膏量偏多。缩小后焊盘仍居中,不偏移。

- **FR-9**: 钢网支持取放缺口(复用 pry\_notch\_sides/pry\_notch\_scale):在卡槽边缘切一个梯形缺口,便于手指把 PCB 从凹槽中抠出。**不需要四角定位柱孔**——凹槽本身完成 PCB 定位。

- **FR-10**: **底面(钢网层/开孔面)平整、无倒角 = 刮刀面**;顶面有卡槽凹陷,非刮刀面。卡槽入口边缘可做小倒角(0.2mm)便于 PCB 放入。

### UI / 工作流

- **FR-12**: 应用顶部新增模式切换:「钢网夹具」(现有)/「PCB 钢网」(新)。切换后左侧卡片与右侧预览整体切换为对应模式。

- **FR-13**: 「PCB 钢网」模式下左侧卡片:1) Python 环境(复用)、2) 导入板框+锡膏 Gerber(复用导入组件,同时识别 outline 和 paste 层)、3) 钢网参数(钢网层厚度预设+自定义、焊盘缩小、边框宽、卡槽间隙、焊盘数、工艺提示)。

- **FR-13a**: 厚度参数提供打印机类型预设:树脂(0.15mm)/ 标准(0.2mm)/ FDM(0.3mm,默认)/ 自定义;默认「FDM 0.3mm」(适配最常见的 FDM 打印机)。每个预设附解释性建议(树脂精度高锡膏量适中、FDM 厚板需配合焊盘缩小)。

- **FR-13b**: 焊盘开孔缩小参数(pad\_shrink 百分比,0~~50%,默认 10%):滑条调节,附解释性建议(「FDM 0.3mm 钢网建议 10~~20%,减少细脚间距桥连」「树脂 0.2mm 以下建议 0\~10%」)。

- **FR-14**: 「PCB 钢网」模式下右侧预览只有一个部件 tab「钢网」,显示薄板 + 焊盘开孔。

- **FR-15**: 支持导出钢网 STL/STEP(复用现有导出逻辑)。

### 数据流 / IPC

- **FR-16**: Rust `Part` 枚举新增 `Stencil`,对应 Python `--part stencil`;`ScadParams` 新增 `stencil_pads`(焊盘多边形数组)、`stencil_thickness`(槽底钢网层厚度)、`pad_shrink`(焊盘缩小百分比)、`stencil_frame_width`(边框宽,默认 8)、`pocket_clearance`(卡槽间隙,默认 0.2)字段。PCB 厚度用现有 `pcb_thickness`。

- **FR-17**: TS → Rust 参数透传焊盘数组(与现有 outline\_points 同机制)。

## Non-Functional Requirements

- **NFR-1**: 钢网 STL 生成耗时 ≤ 现有 insert 部件(焊盘多时可放宽到 2 倍)。

- **NFR-2**: 焊盘解析对常见 SMD 封装(0402/0603/0805 电阻电容、SOP/QFP/TQFP/QFN/BGA)正确率 ≥ 95%。

- **NFR-3**: 钢网预览渲染不卡顿(焊盘开孔用 instanced 或合并几何体)。

- **NFR-4**: 不影响现有夹具模式的功能和测试(回归 `python/tests/` 全过)。

## Constraints

- **Technical**: 几何生成必须在 Python(build123d),与现有三部件一致;焊盘解析在 TS(浏览器侧,与现有 outline 解析一致)。

- **Technical**: 槽底钢网层厚度受 3D 打印工艺限制——树脂(LCD/SLA)打印机可做 0.15\~0.2mm;FDM 建议 ≥ 0.3mm(过薄则层数太少、易翘曲/破碎);UI 提供按打印机类型的厚度预设与工艺提示,用户可自定义。

- **Dependencies**: 复用 build123d / shapely / numpy(已在依赖中);不新增 Python 依赖。

- **Business**: 钢网为一体式独立件,自带 PCB 卡槽完成定位,**不依赖夹具**;卡槽深度 = PCB 厚度,PCB 放入后顶面齐平是核心结构约束。

## Assumptions

- 用户提供的 Gerber ZIP 包含锡膏层(.GTP/.GBP);若只有板框层,提示需要锡膏层。

- 首版只处理 Top 面锡膏;Bottom 面用户自行翻转 PCB 印刷(或后续迭代)。

- 焊盘坐标与板框坐标在同一 Gerber 坐标系(标准 Gerber 惯例);居中平移对两者一致。

## Open Questions

- [x] 钢网厚度:按打印机类型给预设(树脂 0.15 / 标准 0.2 / FDM 0.3 默认 / 自定义),每个附解释性建议。——已决定。

- [x] 焊盘开孔缩小:新增 pad\_shrink 百分比参数(0\~50%,默认 10%),用户可人为调小焊盘孔减少锡膏量,尤其适配 FDM 厚钢网。——已决定。

- [x] 钢网结构:一体式自带 PCB 卡槽,独立使用不依赖夹具;卡槽深度=PCB 厚度,PCB 靠凹槽壁定位,无需四角定位柱孔。——已决定。

- [ ] 焊盘解析是否需要支持 aperture macros(`%AM`)?常见 BGA/热焊盘可能用到。——首版支持标准 C/R/O,macros 作为后续迭代。

## Acceptance Criteria

### AC-1: 锡膏层自动识别

- **Type**: `rule`

- **Given**: 用户拖入包含 `*.GTP` 的 Gerber ZIP

- **When**: 进入「PCB 钢网」模式并导入

- **Then**: 系统识别锡膏层文件并显示文件名,不要求用户手动选择

- **Pass Condition**: 导入后显示的文件名以 `.GTP` 结尾或含 `paste`,且能列出焊盘数量

- **Evidence**: 导入交互 + 钢网参数卡片显示焊盘数

### AC-2: 焊盘只在槽底钢网层开孔

- **Type**: `rule`

- **Given**: 锡膏层含一个圆心 (0,0) r=1.0 的圆形 flash 和一个中心 (10,0) 的 2×1 矩形 flash;stencil\_thickness=0.3

- **When**: 解析后传入 Python 生成钢网

- **Then**: 槽底钢网层(Y ∈ \[0, 0.3])对应位置有圆形和矩形开孔;外框层(Y > 0.3)对应位置无孔(PCB 卡槽区域本身是空的,但焊盘开孔只在槽底)

- **Pass Condition**: 射线法探测 (0,0) 处:y=0.15(槽底层)空、y=0.5(卡槽层)空(卡槽);(1.1,0) 处 y=0.15 实体(槽底钢网)、y=0.5 空(卡槽)。边框处 (55,0) y=0.15 实体、y=1.0 实体

- **Evidence**: `python/tests/test_stencil_pads.py` 输出

### AC-3: 钢网外形 = PCB 外扩边框,独立于夹具

- **Type**: `rule`

- **Given**: 100×100 PCB,frame\_width=8mm

- **When**: 生成钢网

- **Then**: 钢网外轮廓半宽 = 50+8 = 58mm(PCB 半宽 + 边框宽),圆角

- **Pass Condition**: 钢网 STL 外缘顶点 |x|≈58、|y|≈58;不依赖 jig\_size 或 platter\_poly

- **Evidence**: `python/tests/test_stencil_shape.py` 输出

### AC-4: PCB 卡槽深度 = PCB 厚度

- **Type**: `rule`

- **Given**: PCB 厚度 1.6mm,frame\_width=8,stencil\_thickness=0.3

- **When**: 生成钢网

- **Then**: 钢网总高 = 1.6+0.3 = 1.9mm;底面 Y=0 为钢网层(刮刀面),卡槽从顶面(Y=1.9)挖深 1.6mm,槽底 Y=0.3(=stencil\_thickness);PCB 放入后焊盘朝下贴在 Y=0.3 面上

- **Pass Condition**: 钢网 STL Y max ≈ 1.9,Y min ≈ 0;PCB 区域(中心)Y 在 \[0.3, 1.9] 为空(卡槽),边框区域 Y 在 \[0, 1.9] 为实体

- **Evidence**: `python/tests/test_stencil_pads.py` 输出(射线法:PCB 区中心 z=0 处 y=1.0 空,y=0.15 空(槽底钢网层有开孔)/ y=0.4 实体(槽底));边框处 y=1.0 实体)

### AC-5: 钢网层厚度可配置且匹配打印机工艺

- **Type**: `rule`

- **Given**: stencil\_thickness = 0.3mm(FDM 默认),PCB 厚 1.6mm

- **When**: 生成钢网

- **Then**: 槽底钢网层厚 0.3mm,钢网总高 1.9mm

- **Pass Condition**: 钢网 STL Y max ∈ \[1.85, 1.95],槽底(PCB 区)实体层 Y ∈ \[0, 0.3]

- **Evidence**: `python/tests/test_stencil_pads.py` 输出

### AC-5a: 厚度预设按打印机类型,默认 FDM

- **Type**: `rule`

- **Given**: 用户进入钢网模式

- **When**: 查看厚度参数

- **Then**: 提供 4 个预设选项:树脂 0.15mm / 标准 0.2mm / FDM 0.3mm(默认) / 自定义

- **Pass Condition**: UI 存在 4 个厚度预设按钮,默认选中 FDM 0.3mm,切换预设后厚度值同步更新

- **Evidence**: UI 交互 + store 状态

### AC-5b: 工艺解释性提示

- **Type**: `rule`

- **Given**: 厚度值在不同区间

- **When**: 显示钢网参数卡片

- **Then**: 厚度 < 0.25 提示「树脂打印机适用,锡膏量适中」;0.25\~0.35 提示「FDM 适用,建议配合焊盘缩小」;> 0.35 提示「钢网偏厚,锡膏量偏多,建议增大焊盘缩小比例」

- **Pass Condition**: 三个区间分别显示对应提示文本

- **Evidence**: UI 交互

### AC-5c: 焊盘开孔缩小

- **Type**: `rule`

- **Given**: pad\_shrink = 20%,一个 2×1mm 矩形焊盘中心 (10,0)

- **When**: 生成钢网

- **Then**: 该焊盘开孔变为 1.6×0.8mm,中心仍在 (10,0)

- **Pass Condition**: 射线法探测 (10,0) 空;(10.81,0) 实(原边界 11,缩小 20% 后边在 10.8);(10,0.41) 实

- **Evidence**: `python/tests/test_stencil_pads.py` 输出

### AC-5d: 焊盘缩小默认值与滑条

- **Type**: `rule`

- **Given**: 用户进入钢网模式

- **When**: 查看焊盘缩小参数

- **Then**: pad\_shrink 默认 10%,滑条范围 0\~50%,附解释性建议文字

- **Pass Condition**: store 默认 pad\_shrink=10,滑条存在且范围 0-50,建议文字可见

- **Evidence**: UI 交互 + store 状态

### AC-6: 模式切换互不干扰

- **Type**: `rule`

- **Given**: 已在「钢网夹具」模式配置好参数

- **When**: 切换到「PCB 钢网」模式再切回

- **Then**: 夹具模式参数不变;钢网模式有独立状态

- **Pass Condition**: 切回夹具模式后 config store 的夹具参数保持原值,钢网参数独立存储

- **Evidence**: 手动交互 + store 状态检查

### AC-7: 钢网 STL 可导出

- **Type**: `rule`

- **Given**: 已生成钢网预览

- **When**: 点击导出

- **Then**: 生成 `stencil.stl` 文件到用户指定目录

- **Pass Condition**: 导出文件存在且 > 1KB,STL 头有效

- **Evidence**: 导出交互 + 文件检查

### AC-8: 不回归夹具功能

- **Type**: `rule`

- **Given**: 钢网功能实现后

- **When**: 运行现有 `python/tests/run_all.py`

- **Then**: 所有 7 个夹具测试全部通过

- **Pass Condition**: `run_all.py` 退出码 0,无 FAIL

- **Evidence**: CI geometry job 输出

### AC-9: 焊盘解析正确率

- **Type**: `rubric`

- **Dimension**: 常见 SMD 封装焊盘解析正确率

- **Scale**: 1-5

- **Anchors**: 1 = 仅能解析圆形 flash,大部分矩形/长圆丢失;3 = 圆形+矩形 flash 正确,线条焊盘部分丢失;5 = 圆形/矩形/长圆 flash 及 D01 线条焊盘均正确提取

- **Pass Threshold**: >= 4

- **Evidence**: 用 0603+SOP-8+QFP-32 组合的样本 Gerber 解析后与原始孔径比对

### AC-10: 钢网模式操作便捷性

- **Type**: `rubric`

- **Dimension**: 「拖入 Gerber → 导出钢网」的操作步骤数与默认参数合理性

- **Scale**: 1-5

- **Anchors**: 1 = 需要手动输入多项参数才能生成;3 = 拖入后 1-2 步导出,但需确认厚度;5 = 拖入即自动生成,默认厚度合理,一键导出

- **Pass Threshold**: >= 4

- **Evidence**: 手动操作计时 + 参数默认值检查

