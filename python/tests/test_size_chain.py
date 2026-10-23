# -*- coding: utf-8 -*-
"""尺寸链约束验证:钢网 / 凸台 / 窗口 三者的物理关系(逐轴矩形语义)

物理约束链(自上而下,逐轴):
  slot_half    = pcb_half + pcb_pocket_clearance
  platter_half = max(stencil_half - lip, slot_half)     # 唇宽四边一致
  window_half  = platter_half + window_gap              # 机械余量

钢网长宽由用户给定(stencil_size_x / stencil_size_y),可为矩形;
凸台与窗口跟随钢网变矩形,底板(jigSize)仍为正方形。
"""
import sys

sys.stdout.reconfigure(encoding="utf-8")
from _common import Checker, base_params, gen_part  # noqa: E402

import jig_generator as jg  # noqa: E402

ck = Checker()


def bounds_xy(poly):
    """返回 (宽, 高) —— 逐轴尺寸,矩形/异形板都适用"""
    minx, miny, maxx, maxy = poly.bounds
    return maxx - minx, maxy - miny


def chain_check(p, label, gap=0.5):
    """逐轴验证 槽 ⊂ 凸台 ⊂ 窗口,并核对钢网内缩关系"""
    slot, platter, window, _shaped = jg.get_polys(p)
    frame = jg.compute_frame_poly(p)
    slot_w, slot_h = bounds_xy(slot)
    plat_w, plat_h = bounds_xy(platter)
    win_w, win_h = bounds_xy(window)
    frame_w, frame_h = bounds_xy(frame)
    lip = p.get("stencil_lip", 0)
    shx, shy = jg.stencil_half_xy(p)
    print(f"  [{label}] slot={slot_w:.2f}x{slot_h:.2f}  "
          f"platter={plat_w:.2f}x{plat_h:.2f}  window={win_w:.2f}x{win_h:.2f}  "
          f"frame={frame_w:.2f}x{frame_h:.2f}  lip={lip}  margin={p['platter_margin']:.2f}")

    # 约束 1:凸台 ⊇ PCB 槽(每轴,否则 PCB 边缘悬空)
    ck.check(f"{label} 凸台 ≥ 槽(X)", plat_w + 1e-6 >= slot_w,
             f"{plat_w:.2f} vs {slot_w:.2f}")
    ck.check(f"{label} 凸台 ≥ 槽(Y)", plat_h + 1e-6 >= slot_h,
             f"{plat_h:.2f} vs {slot_h:.2f}")

    # 约束 2:窗口半宽 = 凸台半宽 + window_gap(每轴 → 全宽差 2·gap)
    ck.check(f"{label} 窗口 - 凸台 == 2·gap(X)",
             abs(win_w - plat_w - 2 * gap) < 0.05, f"差={win_w - plat_w - 2 * gap:.3f}")
    ck.check(f"{label} 窗口 - 凸台 == 2·gap(Y)",
             abs(win_h - plat_h - 2 * gap) < 0.05, f"差={win_h - plat_h - 2 * gap:.3f}")

    # 约束 3:独立模式下 凸台 = 钢网外缘内缩一个唇宽(每轴)
    if shx > 0 and shy > 0:
        ck.check(f"{label} 凸台 = 钢网 - 2·lip(X)",
                 abs(plat_w - (2 * shx - 2 * lip)) < 0.05,
                 f"凸台 {plat_w:.2f} vs 期望 {2 * shx - 2 * lip:.2f}")
        ck.check(f"{label} 凸台 = 钢网 - 2·lip(Y)",
                 abs(plat_h - (2 * shy - 2 * lip)) < 0.05,
                 f"凸台 {plat_h:.2f} vs 期望 {2 * shy - 2 * lip:.2f}")
        # 约束 4:窗口 ⊇ 钢网?—— 窗口只跟凸台走,不需要覆盖钢网
        ck.check(f"{label} 凸台 ⊆ 钢网外缘(X)", plat_w <= 2 * shx + 1e-6,
                 f"{plat_w:.2f} vs {2 * shx:.2f}")
    return plat_w, plat_h, win_w, win_h


# --- 1. 方形钢网 100×100,板 60×40,唇 15 ---
# 凸台 = 70×70(短边被槽钳制:40.6/2 < 50-15 → 60.6/2 = 30.3 → 70)
p1 = base_params(_tag="sz1", pcb_size_x=60, pcb_size_y=40,
                 stencil_size_x=100, stencil_size_y=100, stencil_lip=15)
w1, h1, _ww1, _wh1 = chain_check(p1, "方形钢网 100 lip15")

# --- 2. 矩形钢网 120×90,板 60×40,唇 15 ---
# 凸台 = 90×60;窗口 = 91×61
p2 = base_params(_tag="sz2", pcb_size_x=60, pcb_size_y=40,
                 stencil_size_x=120, stencil_size_y=90, stencil_lip=15)
w2, h2, _ww2, _wh2 = chain_check(p2, "矩形钢网 120x90 lip15")
ck.check("矩形钢网 → 凸台也是矩形 90x60",
         abs(w2 - 90) < 0.05 and abs(h2 - 60) < 0.05,
         f"实际 {w2:.2f}x{h2:.2f}")

# --- 3. 长条钢网 200×80,板 100×40 ---
p3 = base_params(_tag="sz3", pcb_size_x=100, pcb_size_y=40,
                 stencil_size_x=200, stencil_size_y=80, stencil_lip=10)
w3, h3, _ww3, _wh3 = chain_check(p3, "长条钢网 200x80 lip10")
ck.check("长条钢网 → 凸台 180x60",
         abs(w3 - 180) < 0.05 and abs(h3 - 60) < 0.05,
         f"实际 {w3:.2f}x{h3:.2f}")

# --- 4. 唇宽过大:凸台被槽钳制,不出现负唇 ---
p4 = base_params(_tag="sz4", pcb_size_x=60, pcb_size_y=40,
                 stencil_size_x=120, stencil_size_y=90, stencil_lip=40)
_slot4, plat4, _win4, _ = jg.get_polys(p4)
pw4, ph4 = bounds_xy(plat4)
sw4, sh4 = bounds_xy(_slot4)
ck.check("唇过大 → 凸台钳到槽尺寸",
         abs(pw4 - sw4) < 0.05 and abs(ph4 - sh4) < 0.05,
         f"凸台 {pw4:.2f}x{ph4:.2f} vs 槽 {sw4:.2f}x{sh4:.2f}")
ck.check("唇过大 → 有效唇宽回写为正且被钳小",
         0 <= p4["stencil_lip"] < 40, f"回写 lip={p4['stencil_lip']:.2f}")

# --- 5. 旧项目文件:只有单值 stencil_size → 两轴同取 ---
p5 = base_params(_tag="sz5", pcb_size_x=60, pcb_size_y=40,
                 stencil_size=120, stencil_lip=15)
shx5, shy5 = jg.stencil_half_xy(p5)
ck.check("旧单值 stencil_size 兼容为正方形",
         abs(shx5 - 60) < 1e-6 and abs(shy5 - 60) < 1e-6,
         f"半长宽 = {shx5}, {shy5}")
_slot5, plat5, _win5, _ = jg.get_polys(p5)
pw5, ph5 = bounds_xy(plat5)
ck.check("旧单值 → 凸台 90x90",
         abs(pw5 - 90) < 0.05 and abs(ph5 - 90) < 0.05,
         f"实际 {pw5:.2f}x{ph5:.2f}")

# --- 6. window_gap 用户调节:窗口逐轴跟随 ---
p6 = base_params(_tag="sz6", pcb_size_x=60, pcb_size_y=40,
                 stencil_size_x=120, stencil_size_y=90, stencil_lip=10,
                 window_gap=1.5)
_slot6, plat6, win6, _ = jg.get_polys(p6)
pw6, ph6 = bounds_xy(plat6)
ww6, wh6 = bounds_xy(win6)
ck.check("window_gap=1.5 窗口 X = 凸台 + 2×1.5", abs(ww6 - pw6 - 3.0) < 0.05,
         f"差={ww6 - pw6:.2f}")
ck.check("window_gap=1.5 窗口 Y = 凸台 + 2×1.5", abs(wh6 - ph6 - 3.0) < 0.05,
         f"差={wh6 - ph6:.2f}")

# --- 7. 实体生成:矩形钢网下三件都能正常出模 ---
p7 = base_params(_tag="sz7", pcb_size_x=60, pcb_size_y=40,
                 stencil_size_x=120, stencil_size_y=90, stencil_lip=15,
                 jig_size=150)
for part in ["insert", "cover", "base"]:
    gen_part(p7, part)
    print(f"[OK] {part} STL 几何生成通过(矩形钢网 120x90)")

print("\n=== 总结 ===")
print("尺寸链(逐轴矩形语义):")
print("  slot_half    = pcb_half + pcb_pocket_clearance")
print("  platter_half = max(stencil_half - lip, slot_half)   ← 唇宽四边一致")
print("  window_half  = platter_half + window_gap            ← 机械余量")
print("  钢网长宽独立可矩形 → 凸台/窗口跟随变矩形;底板 jigSize 仍为正方形")
