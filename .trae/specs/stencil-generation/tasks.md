# PCB 钢网直接生成 - 实施计划

## Task 1: TS 焊盘解析器(extractPads)

- **Status**: `pending`

- **Priority**: high

- **Depends On**: None

- **Description**:

  - 新增 `src/lib/gerber/pads.ts`,从锡膏层 Gerber 文本提取焊盘多边形。

  - 解析 `%ADD` aperture 定义:支持圆形 C(d)、矩形 R(X,Y)、长圆形 O(X,Y)。

  - 跟踪当前 aperture(D 码选择),对每个 D03 flash 生成对应形状的多边形(圆心生成圆、矩形生成四角、长圆生成两端半圆+矩形)。

  - 对 D01 绘制:按当前 aperture 作为线宽,生成矩形多边形(覆盖 SOP/QFP 长焊盘)。

  - 坐标处理:与 outline 一致——按 bbox 中心居中。

  - 输出格式:`Array<{ points: Array<[number,number]> }>`(所有形状统一为多边形点列,圆形离散为 \~24 段)。

  - 仅处理 Top 面(默认);Bottom 面不自动翻转。

- **Acceptance Criteria Addressed**: FR-2, FR-3, FR-4, FR-5, AC-2, AC-9

- **Test Requirements**:

  - `rule` TR-1.1: 给定含 1 个圆形 flash(r=1 @ (0,0))和 1 个矩形 flash(2×1 @ (10,0))的 Gerber,extractPads 返回 2 个 pad,圆心 pad 在 (0,0) 半径 1,矩形 pad 四角 (9,±0.5)(11,±0.5)。证据:`src/lib/gerber/__tests__/pads.test.ts`

  - `rule` TR-1.2: 给定 D01 从 (0,0) 到 (5,0) 且当前 aperture 为 C(0.5) 的 Gerber,extractPads 返回 1 个矩形 pad,宽 5 高 0.5。证据:同上测试文件

  - `rule` TR-1.3: 输出坐标已居中(pad 坐标 - bbox 中心)。证据:测试中断言非居中坐标减去中心后与输出一致

  - `rubric` TR-1.4: 常见 SMD 封装解析正确率;scale 1-5;anchors 1=仅圆形/3=圆+矩形 flash/5=圆+矩+长圆+线条全对;threshold >=4;evidence:样本 Gerber 比对

## Task 2: 锡膏层识别 + composable

- **Status**: `pending`

- **Priority**: high

- **Depends On**: Task 1

- **Description**:

  - 新增 `src/lib/gerber/paste-detect.ts`:从文件名列表识别锡膏层(优先级:`.gtp`/`.gbp` > 文件名含 `paste`/`Paste`)。

  - 新增 `src/composables/useGerberStencil.ts`:复用 useGerberOutline 的 ZIP 解压流程,**同时**找 outline 层(板框,用于卡槽形状)和 paste 层(焊盘)→ extractOutline + extractPads → 返回 outline 点列 + pad 数组 + bbox。

  - 支持单文件 paste Gerber(非 ZIP)直接导入(此时卡槽用 bbox 矩形代替板框)。

- **Acceptance Criteria Addressed**: FR-1, AC-1

- **Test Requirements**:

  - `rule` TR-2.1: ZIP 含 `board.GTP`,detectPasteFiles 返回该文件 priority 最高。证据:`pads.test.ts`

  - `rule` TR-2.2: ZIP 无 paste 层时报错提示。证据:composable 错误信息

  - `rule` TR-2.3: ZIP 同时含 outline 和 paste 时,返回两者数据(卡槽用 outline,开孔用 paste)。证据:composable 返回值

## Task 3: Python build\_stencil 几何生成(一体式带卡槽)

- **Status**: `pending`

- **Priority**: high

- **Depends On**: None

- **Description**:

  - 在 `python/jig_generator.py` 新增 `build_stencil(params)` 函数。

  - 构建坐标:z=0 为底面(钢网层/刮刀面),z 向上;总厚度 = pcb\_thickness + stencil\_thickness。

  - 外框:以 PCB 板框轮廓(+ pocket\_clearance 间隙)外扩 stencil\_frame\_width(默认 8mm)生成外框多边形,extrude 总厚度。

  - PCB 卡槽:从顶面(z = total)按 PCB 板框轮廓(+ pocket\_clearance)向下挖凹槽,深度 = pcb\_thickness,槽底 z = stencil\_thickness(钢网层顶面)。PCB 放入后焊盘朝下贴在槽底。

  - 槽底钢网层:z∈\[0, stencil\_thickness] 的薄板;焊盘开孔从 z=0 向上 cut 穿到 z=stencil\_thickness(只穿钢网层,不进卡槽)。

  - 焊盘开孔:遍历 params.stencil\_pads,按 `pad_shrink` 百分比(默认 10)以各焊盘自身中心为基准等比缩小后,cut 穿槽底钢网层。

  - 取放缺口:复用 pry\_notch 逻辑,在卡槽边缘切梯形缺口(便于抠出 PCB)。

  - 底面(z=0,刮刀面)平整无倒角;卡槽入口边缘可做 0.2mm 小倒角便于放入。

  - 不切四角定位柱孔(凹槽本身定位 PCB)。

  - 支持 `--part stencil` CLI 参数。

- **Acceptance Criteria Addressed**: FR-6, FR-7, FR-8, FR-8a, FR-8b, FR-9, FR-10, AC-2, AC-3, AC-4, AC-5, AC-5c

- **Test Requirements**:

  - `rule` TR-3.1: 100×100 PCB,frame\_width=8 → 钢网外轮廓半宽 58。证据:`python/tests/test_stencil_shape.py` 射线法探测边缘

  - `rule` TR-3.2: PCB 厚度 1.6,stencil\_thickness=0.3 → 总高 ≈ 1.9;PCB 区 y=1.0 空(卡槽)、y=0.15 空(槽底焊盘孔)、y=0.4 实(槽底钢网);边框 y=1.0 实。证据:射线法

  - `rule` TR-3.3: 焊盘(圆@(0,0) r=1, 矩@(10,0) 2×1)在槽底层(y=0.15)开孔。证据:射线法 (0,0)@0.15 空 / (1.1,0)@0.15 实

  - `rule` TR-3.4: pry\_notch\_sides=\["down"] → 卡槽下边有缺口。证据:缺口位置空

  - `rule` TR-3.5: pad\_shrink=20,矩形 2×1@(10,0) → 开孔变 1.6×0.8,中心仍 (10,0)。证据:射线法 (10.81,0)@0.15 实 / (10.79,0)@0.15 空

  - `rule` TR-3.6: 钢网四角无定位柱孔(独立使用)。证据:角部实体检出

## Task 4: Rust Part::Stencil + ScadParams 字段

- **Status**: `pending`

- **Priority**: high

- **Depends On**: Task 3

- **Description**:

  - `src-tauri/src/commands.rs`: `Part` 枚举新增 `Stencil`,`to_str` 返回 `"stencil"`。

  - `ScadParams` 新增字段:`stencil_pads: Vec<Vec<[f64;2]>>`(每个 pad 的多边形点列)、`stencil_thickness: f64`(槽底钢网层厚,默认 0.3)、`pad_shrink: f64`(百分比,默认 10)、`stencil_frame_width: f64`(边框宽,默认 8)、`pocket_clearance: f64`(卡槽间隙,默认 0.2)。

  - 透传到 Python input.json(已有 params 序列化机制)。

- **Acceptance Criteria Addressed**: FR-16, FR-17

- **Test Requirements**:

  - `rule` TR-4.1: `cargo build` 成功,无编译错误。证据:构建输出

  - `rule` TR-4.2: input.json 含 stencil\_pads、stencil\_thickness、pad\_shrink、stencil\_frame\_width、pocket\_clearance 字段。证据:调试输出

## Task 5: 模式切换 UI + 钢网参数卡片

- **Status**: `pending`

- **Priority**: high

- **Depends On**: Task 2, Task 4

- **Description**:

  - `src/stores/config.ts`:新增 `appMode: 'jig' | 'stencil'` 状态,钢网参数独立(stencilThickness 默认 0.3,stencilPads 数组,padShrink 默认 10,stencilFrameWidth 默认 8,pocketClearance 默认 0.2)。

  - `src/App.vue`:顶部页眉副标题下新增模式切换 segmented control(「钢网夹具」/「PCB 钢网」),切换时左侧卡片与右侧预览联动。

  - 钢网模式左侧卡片:Python 环境(复用)、导入板框+锡膏 Gerber(复用导入组件,同时识别 outline + paste 层)、钢网参数。

  - 钢网参数卡片内容:

    - 钢网层厚度预设 4 按钮(树脂 0.15 / 标准 0.2 / FDM 0.3 默认 / 自定义),自定义时显示数字输入框;每个预设附解释性文字(注意:总厚度 = PCB厚 + 钢网层厚)

    - 焊盘开孔缩小滑条(0~~50%,默认 10%),附建议文字(「FDM 厚钢网建议 10~~20%,减少细脚桥连」)

    - 边框宽 input(默认 8mm,高级参数可折叠)

    - 卡槽间隙 input(默认 0.2mm,高级参数可折叠)

    - 焊盘数量显示

    - 工艺提示(钢网层厚度<0.25 提示树脂适用;0.25\~0.35 提示 FDM 适用建议配合焊盘缩小;>0.35 提示偏厚建议增大缩小比例)

  - 夹具模式保持现状不变。

- **Acceptance Criteria Addressed**: FR-12, FR-13, FR-13a, FR-13b, AC-5a, AC-5b, AC-5d, AC-6, AC-10

- **Test Requirements**:

  - `rule` TR-5.1: 切换到钢网模式后,左侧显示钢网相关卡片,不显示夹具 config/screw 卡片。证据:DOM 检查

  - `rule` TR-5.2: 切回夹具模式,夹具参数值不变。证据:store 状态断言

  - `rule` TR-5.3: 厚度预设按钮存在(树脂/标准/FDM/自定义 4 个),默认选中「FDM 0.3」,点击「树脂 0.15」后 thickness=0.15。证据:DOM + store

  - `rule` TR-5.4: 厚度=0.15 时工艺提示出现「树脂打印机适用」;厚度=0.3 时提示「FDM 适用,建议配合焊盘缩小」;厚度=0.5 时提示「偏厚,建议增大焊盘缩小比例」。证据:DOM 文本

  - `rule` TR-5.5: 焊盘缩小滑条默认 10,范围 0-50,建议文字可见;拖动到 20 后 padShrink=20。证据:DOM + store

  - `rubric` TR-5.6: 操作便捷性;scale 1-5;anchors 1=需多步输入/3=1-2步/5=拖入即生成;threshold >=4;evidence:手动计时

## Task 6: 钢网预览 + 导出

- **Status**: `pending`

- **Priority**: high

- **Depends On**: Task 5

- **Description**:

  - `ModelPreview.vue`:钢网模式下只有一个「钢网」tab,调用 `generate_stl` part=stencil。

  - 预览渲染:薄板 + 焊盘开孔(直接用 STL geometry,焊盘多也靠单个 mesh)。

  - 导出:复用现有 export\_stl,part=stencil,文件名 `stencil.stl`。

  - 缓存/预热逻辑复用(单部件)。

- **Acceptance Criteria Addressed**: FR-14, FR-15, AC-7

- **Test Requirements**:

  - `rule` TR-6.1: 钢网模式预览渲染出薄板模型,无报错。证据:浏览器控制台无 error

  - `rule` TR-6.2: 导出 stencil.stl 到指定目录,文件 > 1KB。证据:文件存在性 + 大小

  - `rule` TR-6.3: 焊盘数 > 100 时预览帧率可接受(不卡顿)。证据:实测 FPS

## Task 7: 测试补齐(焊盘解析 + 钢网几何)

- **Status**: `pending`

- **Priority**: medium

- **Depends On**: Task 1, Task 3

- **Description**:

  - `src/lib/gerber/__tests__/pads.test.ts`:圆形/矩形/长圆 flash、D01 线条焊盘、坐标居中。

  - `python/tests/test_stencil_pads.py`:焊盘开孔位置/形状、四角孔、厚度。

  - `python/tests/test_stencil_shape.py`:外轮廓与凸台一致。

  - `python/tests/test_stencil_pads.py` 含 pad\_shrink 缩小验证(TR-3.6)。

  - 加入 `run_all.py`。

- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-4, AC-5, AC-5c, AC-9

- **Test Requirements**:

  - `rule` TR-7.1: pads.test.ts 全过。证据:vitest 输出

  - `rule` TR-7.2: test\_stencil\_pads.py + test\_stencil\_shape.py 全过。证据:run\_all.py 输出

## Task 8: 回归验证

- **Status**: `pending`

- **Priority**: high

- **Depends On**: Task 7

- **Description**:

  - 运行 `python/tests/run_all.py` 全部测试(含新增钢网测试),确保夹具功能无回归。

  - 前端 `vue-tsc --noEmit` + `vitest run` 通过。

  - `cargo build` 成功。

- **Acceptance Criteria Addressed**: AC-8

- **Test Requirements**:

  - `rule` TR-8.1: run\_all.py 退出码 0,无 FAIL。证据:命令输出

  - `rule` TR-8.2: vue-tsc + vitest 通过。证据:命令输出

  - `rule` TR-8.3: cargo build 成功。证据:命令输出

