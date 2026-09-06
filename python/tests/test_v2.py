# -*- coding: utf-8 -*-
"""v2 三部件全几何验证(参数推导位置 + 边缘顶点判据,避开三角化盲区)

参数:pcb=100, t=1.6, clr=0.15, margin=5, jig=140, insert=8(plate4+platter4), cover=base=4
推导:slot ±50.15 / platter ±55.15(R4.5) / window ±55.55 / 角螺丝 ±63(=jig/2-7)
     / 周圈带 ±60(靠外:距外缘 10mm)
"""
import math
import sys

sys.stdout.reconfigure(encoding="utf-8")
from _common import Checker, base_params, gen_part, load_verts, ring

ck = Checker()

SLOT_H, WIN_H = 50.15, 55.55
CORNER = 63.0   # max(jig/2-7, win_half+3.5) = 70-7
BAND = 60.0     # 周圈孔带靠外:jig/2-10

params = base_params(_tag="v2")
parts = {p: gen_part(params, p) for p in ("insert", "cover", "base")}

CORNERS = [(CORNER, -CORNER), (CORNER, CORNER), (-CORNER, -CORNER), (-CORNER, CORNER)]

# ===== insert =====
print("=== insert(PCB 托盘)===")
v = load_verts(parts["insert"])
ys = [p[1] for p in v]
print(f"  {len(v)} verts, Y [{min(ys):.2f}, {max(ys):.2f}]")
ck.check("总高 12(托盘8+定位柱穿盖板4,底面平)",
         abs(max(ys) - 12) < 0.05 and abs(min(ys)) < 0.05)
ck.check("PCB 槽底 Y=6.4(槽深=板厚,PCB 齐平)",
         len([p for p in v if abs(p[1] - 6.4) < 0.06 and abs(p[0]) < 50.3 and abs(p[2]) < 50.3]) > 20)
ck.check("凸台台阶面 Y=8 @55(压钢网)",
         len([p for p in v if abs(p[1] - 8) < 0.06 and 53.5 < abs(p[0]) < 56.5 and abs(p[2]) < 54]) > 10)
ck.check("底板顶面 Y=4 @>56(双层)",
         len([p for p in v if abs(p[1] - 4) < 0.06 and 56 < abs(p[0]) < 69]) > 10)
# 底部圆形顶出孔:d=30(槽最小边 100.3×0.35→35.1 封顶 30),圆心=槽质心(0,0)
hr = [p for p in v if abs(math.hypot(p[0], p[2]) - 15.0) < 0.15]
ylo = min((p[1] for p in hr), default=99)
yhi = max((p[1] for p in hr), default=-99)
ck.check(f"圆形顶出孔壁 r=15({len(hr)} 顶点, Y∈[{ylo:.1f},{yhi:.1f}])",
         len(hr) >= 8 and ylo <= 0.1 and 6.3 <= yhi <= 6.6)
# 4 角空心定位柱(外 r4.5,底段与底板融合壁面从 4 起;内孔 r2.5 全高贯穿)
for cx, cz in CORNERS:
    boss = ring(v, cx, cz, 4.5)
    bore = ring(v, cx, cz, 2.5)
    yb = (min((p[1] for p in boss), default=99), max((p[1] for p in boss), default=-99))
    yp = (min((p[1] for p in bore), default=99), max((p[1] for p in bore), default=-99))
    ck.check(f"定位柱@({cx:.1f},{cz:.1f}) 壁Y∈[{yb[0]:.1f},{yb[1]:.1f}] 内孔Y∈[{yp[0]:.1f},{yp[1]:.1f}]",
             len(boss) > 0 and 3.9 <= yb[0] <= 4.1 and 11.9 <= yb[1] <= 12.1
             and len(bore) > 0 and yp[0] <= 0.05 and yp[1] >= 11.9)

# ===== cover =====
print("=== cover(A面顶盖)===")
v = load_verts(parts["cover"])
ys = [p[1] for p in v]
print(f"  {len(v)} verts, Y [{min(ys):.2f}, {max(ys):.2f}]")
ck.check("厚 4", abs(max(ys) - 4) < 0.05 and abs(min(ys)) < 0.05)
# 45° 倒角顶开口:直边 |x|≈59.15(窗口 55.55+倒角 3.6)
bevel = [p for p in v if abs(p[1] - 4) < 0.08 and abs(abs(p[0]) - 59.15) < 0.3 and abs(p[2]) < 55.5]
ck.check(f"顶开口直边 |x|≈59.15({len(bevel)} 顶点)", len(bevel) >= 2)
# 顶开口角弧 R4.9(与窗口/B面同半径,非外偏放大):角心 (54.25,54.25)
arc = [p for p in v if abs(p[1] - 4) < 0.08
       and 53 < p[0] < 60 and 53 < p[2] < 60
       and abs(math.hypot(p[0] - 54.25, p[2] - 54.25) - 4.9) < 0.25]
ck.check(f"顶开口角弧 R4.9·与B面同半径({len(arc)} 顶点)", len(arc) >= 4)
# 窗口底缘 |x|≈55.55(与 base 同一 window_poly = 凸台 55.15 + 0.4)
wbot = [p for p in v if p[1] < 0.06 and 48 < abs(p[2]) < 53 and 54.8 < abs(p[0]) < 56.3]
ck.check(f"窗口底缘 |x|≈55.55({len(wbot)} 顶点)", len(wbot) > 5)
# 4 角定位柱过孔 r=4.7 全厚贯穿(收 Ø9 实心柱,免螺丝)
for cx, cz in CORNERS:
    hole = ring(v, cx, cz, 4.7, 0.15)
    yh = (min((p[1] for p in hole), default=99), max((p[1] for p in hole), default=-99))
    ck.check(f"4角柱孔@({cx:.1f},{cz:.1f}) 壁Y∈[{yh[0]:.1f},{yh[1]:.1f}]",
             len(hole) > 0 and yh[0] <= 0.05 and yh[1] >= 3.9)
# 周圈孔 r=1.75 @ band 60(间距 25 → 每边 5 个采样;cover 过孔)
peri = [(x, BAND) for x in (-50, -25, 0, 25, 50)]
peri += [(BAND, x) for x in (-50, -25, 0, 25, 50)]
found = sum(1 for (x, z) in peri if ring(v, x, z, 1.75, 0.15))
ck.check(f"周圈孔 {found}/{len(peri)}", found == len(peri))

# ===== base =====
print("=== base(B面底座)===")
v = load_verts(parts["base"])
ys = [p[1] for p in v]
print(f"  {len(v)} verts, Y [{min(ys):.2f}, {max(ys):.2f}]")
ck.check("厚 4,无凸点(Y max=4)", abs(max(ys) - 4) < 0.06 and abs(min(ys)) < 0.05)
# 拔模:斜面顶边 Y=4 @|x|≈56.55
bevel = [p for p in v if abs(p[1] - 4) < 0.08 and 56.0 < abs(p[0]) < 57.1 and 51 < abs(p[2]) < 56]
ck.check(f"窗口拔模斜面顶边({len(bevel)} 顶点)", len(bevel) > 5)
found = sum(1 for (x, z) in peri if ring(v, x, z, 1.75, 0.15))
ck.check(f"周圈底孔 {found}/{len(peri)}(与 cover 同心, Ø3.5 clearance)", found == len(peri))
# 4 角定位柱孔 r=4.7 全厚贯穿(与 cover 同尺寸,一一对应)
for cx, cz in CORNERS:
    hole = ring(v, cx, cz, 4.7, 0.15)
    yh = (min((p[1] for p in hole), default=99), max((p[1] for p in hole), default=-99))
    ck.check(f"4角柱孔@({cx:.1f},{cz:.1f}) 壁Y∈[{yh[0]:.1f},{yh[1]:.1f}]",
             len(hole) > 0 and yh[0] <= 0.05 and yh[1] >= 3.9)

ck.finish("v2 几何验证")
