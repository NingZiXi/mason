# -*- coding: utf-8 -*-
"""验证:Python 螺丝布局 vs TS(config.ts screwPositions)算法仿真 逐点一致
方形(100x100)+ 矩形(90x50)+ 小夹具分支 三套参数;
并检查孔带靠外(距外缘 10mm)、与 4 角柱孔净距 ≥1mm
"""
import math
import sys

sys.stdout.reconfigure(encoding="utf-8")
from _common import Checker  # 先导入 _common(负责把 python/ 加入 sys.path)

import jig_generator as jg

ck = Checker()


def ts_screw_positions(c):
    """TS config.ts screwPositions 的算法仿真(同步副本):
    凸台恒为正方形(半宽 = 槽包围盒长边/2 + margin,含钢网扩张 + frame 反向钳制)"""
    if c["screw_spacing"] <= 0:
        return []
    hx = c["pcb_size_x"] / 2 + c["pcb_pocket_clearance"]
    hy = c["pcb_size_y"] / 2 + c["pcb_pocket_clearance"]
    slot_max = max(hx, hy)
    # 与 src/stores/config.ts:windowHalfXY 完全一致 —— 钳制不变量
    # margin = max(platter_margin, frame_half - slot_half - lip_min)
    # 注意:本测试的简化 dict 只用 pcb_pocket_clearance + 无 stencil_size 时按
    # frame_width=12(python jg 默认)+ pocket_clearance=0.1(python jg 默认)推导
    lip_min = 2.0
    if c["stencil_size"] > 0:
        frame_half_max = c["stencil_size"] / 2
    else:
        frame_w = c.get("stencil_frame_width", 12.0)
        pocket_clr = c.get("pocket_clearance", 0.1)
        frame_half_max = max(
            c["pcb_size_x"] / 2 + pocket_clr + frame_w,
            c["pcb_size_y"] / 2 + pocket_clr + frame_w,
        )
    margin = max(c["platter_margin"], frame_half_max - slot_max - lip_min)
    # 窗口 = max(platter, frame) + 0.4 单边间隙 —— 与 python get_polys 同源
    platter_half = slot_max + margin
    hx = hy = max(platter_half, frame_half_max) + 0.4
    jig = c["jig_size"]
    band_x = max(jig / 2 - 10.0, hx + 4.0)
    band_y = max(jig / 2 - 10.0, hy + 4.0)
    limit = jig / 2 - 14
    sp = c["screw_spacing"]
    if limit < sp:
        return [(0, band_y), (0, -band_y), (band_x, 0), (-band_x, 0)] if limit > 0 else []
    n = int(limit // sp)
    out, seen = [], set()
    for i in range(-n, n + 1):
        cc = i * sp
        if abs(cc) > limit:
            continue
        for x, y in [(cc, band_y), (cc, -band_y), (band_x, cc), (-band_x, cc)]:
            k = (round(x, 3), round(y, 3))
            if k not in seen:
                seen.add(k)
                out.append((x, y))
    return out


CASES = [
    # 用例 1:100x100 板 + frame_w=12 —— 钳制要求 window ≥ 62.55(钢网边到边
    # 含 0.1 间隙 + frame_w=12 + 0.4 buffer),jig 必须 ≥ window·2 + 20 = 145
    # 才能让周圈孔带靠外(jig/2-10=60)同时净距窗口 ≥4mm
    {"pcb_size_x": 100, "pcb_size_y": 100, "stencil_size": 0, "platter_margin": 12,
     "jig_size": 160, "screw_spacing": 25, "pcb_pocket_clearance": 0.15},
    {"pcb_size_x": 90, "pcb_size_y": 50, "stencil_size": 110, "platter_margin": 6,
     "jig_size": 180, "screw_spacing": 40, "pcb_pocket_clearance": 0.15},
    {"pcb_size_x": 40, "pcb_size_y": 40, "stencil_size": 60, "platter_margin": 6,
     "jig_size": 120, "screw_spacing": 60, "pcb_pocket_clearance": 0.15},  # 小夹具分支(limit<sp)
]

for idx, params in enumerate(CASES):
    print(f"=== 用例 {idx + 1}: pcb={params['pcb_size_x']}x{params['pcb_size_y']} "
          f"stencil={params['stencil_size']} jig={params['jig_size']} sp={params['screw_spacing']} ===")
    win = jg.get_polys(params)[2]
    minx, miny, maxx, maxy = win.bounds
    py_pos = sorted((round(x, 3), round(y, 3))
                    for x, y in jg.compute_perimeter_screw_positions(
                        params["jig_size"], win, params["screw_spacing"]))
    ts_pos = sorted((round(x, 3), round(y, 3)) for x, y in ts_screw_positions(params))
    ck.check(f"周圈孔 TS/Python 一致({len(py_pos)} 个)", py_pos == ts_pos)
    # 孔带靠外:螺丝距外缘 10mm,内侧完整留给钢网夹紧(窗口壁→孔壁 ≥4mm)
    if py_pos:
        band_x = max(abs(x) for x, y in py_pos)
        band_y = max(abs(y) for x, y in py_pos)
        edge = params["jig_size"] / 2
        in_x, out_x = band_x - maxx, edge - band_x   # 左右:窗口侧 / 外缘侧
        in_y, out_y = band_y - maxy, edge - band_y
        ck.check(f"孔带靠外(外缘 {out_x:.1f}/{out_y:.1f}mm,内侧 {in_x:.1f}/{in_y:.1f}mm)",
                 abs(out_x - 10.0) < 0.01 and abs(out_y - 10.0) < 0.01
                 and in_x >= 4.0 and in_y >= 4.0)
        corners = jg.corner_screw_positions(win, params["jig_size"])
        r_sum = 4.7 + 1.75  # 柱孔半径 + 周圈孔半径
        min_clear = min(
            math.dist((x, y), (cx, cy)) - r_sum
            for x, y in py_pos for cx, cy in corners)
        ck.check(f"与 4 角柱孔净距 ≥1mm(最小 {min_clear:.2f}mm)", min_clear >= 1.0)
    corners = jg.corner_screw_positions(win, params["jig_size"])
    ck.check(f"角螺丝 4 个,全在窗口外({corners[0]})", len(corners) == 4
             and all(abs(x) >= maxx and abs(y) >= maxy for x, y in corners))

ck.finish("螺丝布局验证")
