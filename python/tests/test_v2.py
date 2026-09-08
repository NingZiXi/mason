# -*- coding: utf-8 -*-
"""v2 三部件全几何验证(新语义:双向滑动条,窗口 = 凸台 + gap,不再用 stencil/2 钳)

参数:pcb=100, t=1.6, clr=0.15, lip=1.5, gap=0.5, jig=140, platterWidth=100, stencilSize=120
推导(尺寸链 —— 全部从 Python get_polys 动态取值,不硬编码):
    slot ±50.15 → platter_half = max(100/2, 50.15) = 50.15
    → window = 50.15 + 0.5 = 50.65
    → 角螺丝:window 50.65 → corner ≈ 59.5(沿 jig 内收)
    → 周圈带:band = max(70-10, 50.65+4) = 60.0
"""
import math
import sys

sys.stdout.reconfigure(encoding="utf-8")
from _common import Checker, base_params, gen_part, load_tris, load_verts, ring, solid  # noqa: E402
import jig_generator as jg  # noqa: E402

ck = Checker()

# ===== 动态几何参数(从 Python 生成,TS 端同源) =====
p = base_params(_tag="v2")
parts = {pt: gen_part(p, pt) for pt in ("insert", "cover", "base")}
slot_poly, platter_poly, window_poly, is_shaped = jg.get_polys(p)

SLOT_H = max(slot_poly.bounds[2], slot_poly.bounds[3])          # PCB 槽半宽
PLATTER_H = max(platter_poly.bounds[2], platter_poly.bounds[3]) # 凸台半宽
WIN_H = max(window_poly.bounds[2], window_poly.bounds[3])       # 窗口半宽
jig = p["jig_size"]
corner_positions = jg.corner_screw_positions(window_poly, jig, p)
CORNER = corner_positions[0][0]                                  # 角螺丝半宽(沿对角线)
BAND = max(jig / 2 - 10, WIN_H + 4)                              # 周圈螺丝带

# ===== insert(PCB 托盘) =====
print("=== insert(PCB 托盘)===")
v = load_verts(parts["insert"])
ys = [pv[1] for pv in v]
print(f"  {len(v)} verts, Y [{min(ys):.2f}, {max(ys):.2f}]")

# 总高 12 = 8(托盘高)+ 4(定位柱穿过盖板的段)
ck.check("总高 12(托盘 8+定位柱 4 段),底面平",
         abs(max(ys) - 12) < 0.05 and abs(min(ys)) < 0.05)

# PCB 槽底 Y=6.4 = 8 - 1.6(PCB 与凸台顶齐平,厚 1.6)
ck.check(f"PCB 槽底 Y=6.4(槽深=板厚,PCB 齐平,|x|<{SLOT_H:.1f})",
         len([pv for pv in v if abs(pv[1] - 6.4) < 0.06
              and abs(pv[0]) < SLOT_H and abs(pv[2]) < SLOT_H]) > 20)

# 底板顶面 Y=4(insert 下方垫板)
ck.check(f"底板顶面 Y=4(凸台外缘 < |x| < jig/2={jig/2})",
         len([pv for pv in v if abs(pv[1] - 4) < 0.06
              and PLATTER_H < abs(pv[0]) < jig / 2]) > 5)

# 4 角空心定位柱(外 r4.5,底段与底板融合,内孔 r2.5 全高贯穿)
CORNERS = [(CORNER, -CORNER), (CORNER, CORNER), (-CORNER, -CORNER), (-CORNER, CORNER)]
for cx, cz in CORNERS:
    boss = ring(v, cx, cz, 4.5)
    bore = ring(v, cx, cz, 2.5)
    yb = (min((pv[1] for pv in boss), default=99),
          max((pv[1] for pv in boss), default=-99))
    yp = (min((pv[1] for pv in bore), default=99),
          max((pv[1] for pv in bore), default=-99))
    ck.check(f"定位柱@({cx:.1f},{cz:.1f}) 壁Y∈[{yb[0]:.1f},{yb[1]:.1f}] 内孔Y∈[{yp[0]:.1f},{yp[1]:.1f}]",
             len(boss) > 0 and 3.9 <= yb[0] <= 4.1 and 11.9 <= yb[1] <= 12.1
             and len(bore) > 0 and yp[0] <= 0.05 and yp[1] >= 11.9)

# ===== cover(A 面顶盖) =====
print("=== cover(A面顶盖)===")
v = load_verts(parts["cover"])
ys = [pv[1] for pv in v]
print(f"  {len(v)} verts, Y [{min(ys):.2f}, {max(ys):.2f}]")

ck.check("厚 4", abs(max(ys) - 4) < 0.05 and abs(min(ys)) < 0.05)

# 锥面顶开口:45° cone 从 window_poly 扩到 (window + cover_h-0.4)
bevel = p["top_cover_height"] - 0.4  # 3.6mm
cone_top_x = WIN_H + bevel
cone_edge = [pv for pv in v if abs(pv[1] - 4) < 0.05
             and abs(abs(pv[0]) - cone_top_x) < 0.10 and abs(pv[2]) < WIN_H]
ck.check(f"顶开口锥面顶边 |x|≈{cone_top_x:.1f}(锥体扩口,直边段)", len(cone_edge) >= 2)

# 锥面角弧:锥体在四角形成的圆弧半径 ≈ window 角弧 R4.5 + bevel
# 用更宽松的容差:锥体斜面的角弧中心与 window 角心对齐
cone_arc = [pv for pv in v if abs(pv[1] - 4) < 0.05
            and WIN_H < pv[0] < WIN_H + bevel + 3
            and WIN_H < pv[2] < WIN_H + bevel + 3]
ck.check(f"顶开口角区域({len(cone_arc)} 顶点,角弧存在)",
         len(cone_arc) >= 4)

# 窗口底缘:Y=0.05 平面 |x|≈WIN_H 处应为空(钢网能塞进)
cover_tris = load_tris(parts["cover"])
wbot_ok = all(not solid(cover_tris, x, 0.05, 0.0) and not solid(cover_tris, 0.0, 0.05, x)
              for x in (WIN_H - 0.15, WIN_H - 1.0, WIN_H - 2.0))
ck.check(f"窗口底缘 Y=0.05 内部空(钢网塞得进,|x|∈[{WIN_H-2.0:.1f},{WIN_H-0.15:.1f}])",
         wbot_ok)

# 4 角定位柱过孔 Ø9.4 全厚贯穿
for cx, cz in CORNERS:
    thru = all(not solid(cover_tris, cx, y, cz) for y in (0.05, 1.0, 2.0, 3.0, 3.95))
    ck.check(f"4角柱孔@({cx:.1f},{cz:.1f}) 贯通(圆心 Y∈[0,4] 全空)", thru)

# 周圈过孔(与 base 同心,Ø3.5)
peri = [(x, BAND) for x in (-50, -25, 0, 25, 50)] + [(BAND, x) for x in (-50, -25, 0, 25, 50)]
found = sum(1 for (x, z) in peri if ring(v, x, z, 1.75, 0.15))
ck.check(f"周圈孔 {found}/{len(peri)}(Ø3.5,与 base 同心)", found == len(peri))

# ===== base(B 面底座) =====
print("=== base(B面底座)===")
v = load_verts(parts["base"])
ys = [pv[1] for pv in v]
print(f"  {len(v)} verts, Y [{min(ys):.2f}, {max(ys):.2f}]")

ck.check("厚 4,无凸点(Y max=4)", abs(max(ys) - 4) < 0.06 and abs(min(ys)) < 0.05)

# 拔模:1.0mm draft 在窗口缘,顶边 Y=4 @ |x|≈WIN_H+1.0
draft_depth = 1.0
draft_x = WIN_H + draft_depth
draft_edge = [pv for pv in v if abs(pv[1] - 4) < 0.05
              and abs(abs(pv[0]) - draft_x) < 0.10 and 51 < abs(pv[2]) < 62]
ck.check(f"窗口拔模斜面顶边 |x|≈{draft_x:.1f}({len(draft_edge)} 顶点)", len(draft_edge) >= 2)

# 周圈底孔(与 cover 同心)
found = sum(1 for (x, z) in peri if ring(v, x, z, 1.75, 0.15))
ck.check(f"周圈底孔 {found}/{len(peri)}(与 cover 同心,Ø3.5 clearance)", found == len(peri))

# 4 角定位柱孔 r=4.7 全厚贯穿(拔模斜面切到 Y≈3.60)
for cx, cz in CORNERS:
    hole = ring(v, cx, cz, 4.7, 0.15)
    yh = (min((pv[1] for pv in hole), default=99),
          max((pv[1] for pv in hole), default=-99))
    ck.check(f"4角柱孔@({cx:.1f},{cz:.1f}) 壁Y∈[{yh[0]:.1f},{yh[1]:.1f}]",
             len(hole) > 0 and yh[0] <= 0.05 and yh[1] >= 3.55)

ck.finish("v2 几何验证")
