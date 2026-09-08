# -*- coding: utf-8 -*-
"""取放缺口深度限制验证:缺口伸入 10mm,深度不能超过凸台壁深

新语义(plater_radius 反向钳制):凸台顶面 ⊇ 钢网,
margin = max(platter_margin, frame_half - slot_half) → 凸台反向扩张托住钢网外缘

- 50 板 + margin=5:slot=25.15
- stencil=150:margin_min = 75-25.15 = 49.85 >> 5 → 凸台反向扩张到半宽 75,
  壁深 49.85,缺口 10mm 不能切穿 49.85mm 凸台壁 → 缺口深度 = 10mm(设计值)
- stencil=70:margin_min = 35-25.15 = 9.85 > 5 → 凸台反向扩张到半宽 35.00,
  壁深 9.85,缺口 10mm 切穿 9.85mm 凸台壁 → 缺口深度 = 9.85mm(壁深上限)

不变量:缺口深度 ≤ 凸台壁深(不切穿凸台 → 不影响内部 PCB 槽结构)
"""
import struct
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
from _common import Checker, base_params, gen_part  # 先导入 _common(负责把 python/ 加入 sys.path)

import jig_generator as jg

ck = Checker()

for label, stencil, expected_depth in [
    ("深台阶(钢网150 反向扩张,壁深 49.85,缺口 10mm 未切穿)", 150, 10.0),
    ("正常台阶(钢网70 反向扩张,壁深 9.85,缺口 10mm 切穿凸台壁)", 70, 9.85),
]:
    print(f"=== {label} ===")
    params = base_params(
        _tag=f"nd_{stencil}", pcb_size_x=50, pcb_size_y=50,
        jig_size=220 if stencil == 150 else 200, stencil_size=stencil,
        platter_margin=5.0, pry_notch_sides=["down"])

    slot_poly, platter_poly, _win, _s = jg.get_polys(params)
    pb = platter_poly.bounds
    miny_slot = slot_poly.bounds[1]
    margin_actual = miny_slot - pb[1]
    print(f"  凸台壁深(槽缘→外缘): {margin_actual:.1f}mm")

    out = gen_part(params, "insert")
    raw = out.read_bytes()
    n = struct.unpack("<I", raw[80:84])[0]
    data = np.frombuffer(raw, dtype=np.uint8, count=n * 50, offset=84)
    tris = data.reshape(n, 50)[:, 12:48].copy().view(np.float32).reshape(n, 3, 3)

    # STL 导出 rotate(X,-90):(x,y,z)→(x,z,-y) → build y 对应 -STL z。
    # 缺口在 build y < 槽缘(down 侧) = STL z > -miny_slot。
    # 找中心区(x≈0±15)且明显在槽外的三角形的 STL z 最大值 = 缺口最外缘
    m = (np.abs(tris[:, :, 0]) < 15) & (tris[:, :, 2] > -miny_slot + 1.0)
    zs = tris[m][:, 2]
    if len(zs):
        out_y = -zs.max()  # 回到 build 坐标
        notch_depth = miny_slot - out_y
        print(f"  缺口实际深度: {notch_depth:.1f}mm (槽缘 y={miny_slot:.2f}, 最外 y={out_y:.2f})")
        # 不变量:缺口深度 ≤ 凸台壁深(不能切穿凸台)
        # 实际缺口深度:
        #   未切穿时 = 缺口设计伸入量(10mm)
        #   切穿时 = 凸台壁深
        ck.check(f"缺口深度 = min(10mm 缺口设计, {margin_actual:.1f}mm 壁深) = {expected_depth:.1f}mm",
                 abs(notch_depth - expected_depth) < 1.0,
                 f"notch_depth={notch_depth:.1f}, expected={expected_depth:.1f}, wall={margin_actual:.1f}")
    else:
        ck.check("找到缺口", False)

ck.finish("缺口深度验证")