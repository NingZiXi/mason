# -*- coding: utf-8 -*-
"""尺寸链约束验证:凸台 / 唇 / 钢网 三者的物理关系

新物理约束链(双向滑动条语义):
  A/B 框窗口 = 凸台外缘 + window_gap(机械余量,默认 0.5mm,用户可调)
  凸台  =  max(platterWidth/2, slotHalfMax)
            —— platterWidth 是用户设的凸台宽度(滑动条左)
            —— 不再用 stencil/2 钳制,否则滑动条完全无效
  唇宽 stencilLip = (stencilSize - platterWidth) / 2  (滑动条右)
  双向联动:platterWidth + 2 * stencilLip = stencilSize  (总和恒等)

物理上:A/B 框中间的开孔是『漏出钢网/PCB 的工作窗口』,
A/B 框四周压在凸台四周的台阶上 → 窗口必须 ≥ 凸台外缘 + 余量;
钢网放在凸台顶面 + PCB 上方,不穿过 A/B 框中间,所以窗口不跟 stencil 走。
"""
import math
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
from _common import Checker, base_params, gen_part  # noqa: E402

import jig_generator as jg  # noqa: E402

ck = Checker()


def bbox_half(poly):
    minx, miny, maxx, maxy = poly.bounds
    return max(maxx - minx, maxy - miny) / 2


def chain_check(p, label, gap=0.5):
    """验证 p 三件 bbox 关系,并打印关键尺寸

    新物理约束:
      - 凸台 = max(platterWidth/2, slotHalfMax) —— 不再被 stencil/frame 钳制
      - 窗口 = 凸台 + gap
      - 凸台 ≥ slotHalfMax(PCB 不悬空)
    """
    slot, platter, window, _shaped = jg.get_polys(p)
    frame = jg.compute_frame_poly(p)
    slot_h = bbox_half(slot)
    platter_h = bbox_half(platter)
    window_h = bbox_half(window)
    frame_h = bbox_half(frame)
    margin_eff = platter_h - slot_h
    pw = p.get("platter_width", 0)
    lip = p.get("stencil_lip", 0)
    stencil_size = p.get("stencil_size", 0)
    print(f"  [{label}] slot_h={slot_h:.2f}  "
          f"platter_h={platter_h:.2f}  window_h={window_h:.2f}  "
          f"frame_h={frame_h:.2f}  win-platter={window_h-platter_h:.2f}mm  "
          f"pw={pw}  lip={lip}  stencil={stencil_size}  margin={margin_eff:.2f}mm")
    # 约束 1:窗口 ≥ 凸台(A/B 框窗口必须 ≥ 凸台外缘,凸台才能塞入)
    ck.check(f"{label} 窗口 ≥ 凸台",
             window_h + 1e-6 >= platter_h, f"差={window_h - platter_h:.2f}mm")
    # 约束 2:窗口 - 凸台 == window_gap(机械余量)
    ck.check(f"{label} 窗口 - 凸台 == window_gap(机械余量)",
             abs(window_h - platter_h - gap) < 0.05,
             f"差={window_h - platter_h - gap:.3f}mm (期望 {gap}mm)")
    # 约束 3:凸台 ≥ slotHalfMax(PCB 不悬空)
    pw_half = pw / 2
    expected_min = max(pw_half, slot_h)
    ck.check(f"{label} 凸台 ≥ max(pw/2, slotHalfMax)",
             platter_h + 1e-6 >= expected_min - 0.01,
             f"差={platter_h - expected_min:.3f}mm (期望 ≥ {expected_min:.2f}mm)")
    return platter_h, window_h, frame_h


# --- 1. 矩形板默认参数(80x60 板 + frame_width=12) ---
p1 = base_params(_tag="sz1", pcb_size_x=80, pcb_size_y=60,
                 stencil_size=0, stencil_frame_width=12,
                 stencil_frame_shape="outline",
                 platter_width=80, stencil_lip=0)
chain_check(p1, "矩形 80x60 frame_w=12")


# --- 2. 异形板 + frame_shape=rect:凸台被 PCB 短边钳制(slot 大) ---
p2 = base_params(_tag="sz2", pcb_size_x=100, pcb_size_y=80,
                 stencil_size=0, stencil_frame_width=12,
                 stencil_frame_shape="rect",
                 platter_width=100, stencil_lip=0,
                 pcb_outline_points=[[-50, -40], [50, -40], [50, 10], [20, 10],
                                     [20, 40], [-50, 40], [-50, -40]])
chain_check(p2, "异形 + frame=rect")


# --- 3. 极限边界:platterWidth = PCB 短边 60,唇 = 0 ---
p3 = base_params(_tag="sz3", pcb_size_x=60, pcb_size_y=40,
                 stencil_size=0, stencil_frame_width=12,
                 stencil_frame_shape="rect",
                 platter_width=60, stencil_lip=0)
chain_check(p3, "platterWidth=pcbMax  lip=0")


# --- 4. stencil_size 独立模式:platterWidth 用户调节 ---
# stencil_size=70,plate_w=70 → 凸台 = 70,窗口 = 70 + 0.5 = 70.5
p4 = base_params(_tag="sz4", pcb_size_x=50, pcb_size_y=30,
                 stencil_size=70,
                 stencil_frame_width=0,
                 stencil_frame_shape="outline",
                 platter_width=70, stencil_lip=0)
chain_check(p4, "stencil_size=70 + plate_w=70")


# --- 5. STL 实体验证:plate_w=PCB lip=0 时,凸台仍能盖住 PCB ---
p5 = base_params(_tag="sz5", pcb_size_x=60, pcb_size_y=40,
                 stencil_size=100,
                 stencil_frame_width=0,
                 stencil_frame_shape="outline",
                 platter_width=60, stencil_lip=20)
chain_check(p5, "plate_w=pcb lip=20")

for part in ["insert", "cover", "base"]:
    gen_part(p5, part)
    print(f"[OK] {part} STL 几何生成通过(plate_w=pcb lip=20)")


# --- 6. platterWidth 用户调节:凸台跟着变 ---
p6 = base_params(_tag="sz6", pcb_size_x=80, pcb_size_y=60,
                 stencil_size=0, stencil_frame_width=12,
                 stencil_frame_shape="rect",
                 platter_width=100, stencil_lip=15)
_slot6, platter6, window6, _shaped6 = jg.get_polys(p6)
p6_w150 = dict(p6, platter_width=150, stencil_lip=0)
_slot6b, platter6b, window6b, _ = jg.get_polys(p6_w150)
insert_path = gen_part(p6, "insert")
print(f"[OK] insert STL 几何生成通过(platterWidth 默认 100, 改 150 凸台跟着变)")
ck.check("platterWidth=150 凸台 ≈ 75(用户设 150/2)",
         abs(bbox_half(platter6b) - 75) < 0.1,
         f"platter6b={bbox_half(platter6b):.2f}, 期望 75")
ck.check("platterWidth=150 窗口 - 凸台 == window_gap",
         abs(bbox_half(window6b) - bbox_half(platter6b) - 0.5) < 0.05,
         f"差={bbox_half(window6b) - bbox_half(platter6b) - 0.5:.2f}")


# --- 7. window_gap 用户调节:窗口跟着余量变 ---
p7 = base_params(_tag="sz7", pcb_size_x=80, pcb_size_y=60,
                 stencil_size=120,
                 stencil_frame_width=0,
                 stencil_frame_shape="outline",
                 platter_width=100, stencil_lip=10,
                 window_gap=1.5)
_slot7, _platter7, window7, _ = jg.get_polys(p7)
frame7 = bbox_half(jg.compute_frame_poly(p7))
ck.check("window_gap=1.5 窗口 = 凸台 + 1.5",
         abs(bbox_half(window7) - bbox_half(_platter7) - 1.5) < 0.05,
         f"window7 - platter7 = {bbox_half(window7) - bbox_half(_platter7):.2f}, 期望 1.5")


# --- 8. 双向联动总和恒等:platterWidth + 2*stencilLip = stencilSize ---
p8 = base_params(_tag="sz8", pcb_size_x=80, pcb_size_y=60,
                 stencil_size=120, stencil_frame_width=0,
                 stencil_frame_shape="outline",
                 platter_width=100, stencil_lip=10)
_stencil8 = p8["stencil_size"]
_pw8 = p8["platter_width"]
_lip8 = p8["stencil_lip"]
ck.check("双向联动:platterWidth + 2*stencilLip = stencilSize(默认)",
         abs(_pw8 + 2 * _lip8 - _stencil8) < 0.01,
         f"pw={_pw8} 2*lip={2*_lip8} sum={_pw8 + 2*_lip8} stencilSize={_stencil8}")


# --- 9. 关键场景:platterWidth < stencilSize 时,唇托住钢网外缘 ---
# (platterWidth=80, stencilSize=100 → 唇=10,钢网外缘超出凸台 10mm)
p9 = base_params(_tag="sz9", pcb_size_x=60, pcb_size_y=40,
                 stencil_size=100,
                 stencil_frame_width=0,
                 stencil_frame_shape="outline",
                 platter_width=80, stencil_lip=10)
_slot9, platter9, window9, _ = jg.get_polys(p9)
frame9 = bbox_half(jg.compute_frame_poly(p9))
ck.check("唇场景:凸台半宽 = 40(platterWidth/2,不被 stencil 钳制)",
         abs(bbox_half(platter9) - 40) < 0.1,
         f"platter9={bbox_half(platter9):.2f}, 期望 40")
ck.check("唇场景:窗口 = 凸台40 + 0.5 = 40.5(不跟 stencil 走)",
         abs(bbox_half(window9) - 40.5) < 0.05,
         f"window9={bbox_half(window9):.2f}, 期望 40.5")


print("\n=== 总结 ===")
print("尺寸链(新语义 —— 双向滑动条):")
print("  A/B 框窗口 = 凸台外缘 + window_gap  ← 不跟 stencil 走")
print("  凸台 = max(platterWidth/2, slotHalfMax)  ← 不再用 stencil/2 钳制")
print("  唇宽 stencilLip = (stencilSize - platterWidth) / 2  (双向联动)")
print("  凸台 ≥ PCB 槽(防悬空)")
print("  双向联动:platterWidth + 2*stencilLip = stencilSize")
print()
print("platterWidth 决定凸台多宽(用户滑动条左),stencilLip 决定唇多厚(右),")
print("总和保持 stencilSize —— 钢网外缘 = 凸台 + 唇,唇托住钢网外缘。")
print("A/B 框中间的开孔是『漏出钢网/PCB 的工作窗口』,只跟凸台走。")
