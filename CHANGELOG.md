# Changelog

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