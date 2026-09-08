# -*- coding: utf-8 -*-
"""v2 三部件全几何验证(参数推导位置 + 边缘顶点判据,避开三角化盲区)

参数:pcb=100, t=1.6, clr=0.15, lip=1.5, gap=0.5, jig=140, insert=8(plate4+platter4), cover=base=4
推导(尺寸链:凸台顶面 ⊇ 钢网外缘,A/B 框窗口 = 凸台 + 机械余量 gap):
    slot ±50.15 → frame 半宽 = 50.15+0.1+12 = 62.10
    → lip=1.5 < 反向钳制 11.95 → 凸台外扩 = 11.95
    → platter ±62.10(R4.5,顶面 ⊇ 钢网外缘)
    → window = platter + window_gap(0.5) = 62.60
    → 角螺丝:s = min(jig/2-(r_out+r_post+1.0), max(win_half+3.5, jig/2-7))
                = min(70-10.5, max(66.1, 63)) = min(59.5, 66.1) = 59.5
    → 周圈带 = max(jig/2-10, maxx+4) = max(60, 66.6) = 66.6
"""
import math
import sys

sys.stdout.reconfigure(encoding="utf-8")
from _common import Checker, base_params, gen_part, load_tris, load_verts, ring, solid  # noqa: E402

ck = Checker()

SLOT_H, WIN_H = 50.15, 62.60
PLATTER_H = 62.10  # frame 反向钳制后凸台半宽(lip=1.5 < margin_min=11.95,反向扩张)
CORNER = 59.5   # jig/2-(r_out+r_post+1)=70-(5+4.5+1)=59.5(底板外缘保护)
BAND = 66.6     # 周圈孔带靠外:max(jig/2-10, maxx+4)=max(60, 66.6)=66.6

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
# 凸台台阶面 Y=8 @ PLATTER_H ±0.5(R4.5 圆角外缘顶点)
ck.check(f"凸台台阶面 Y=8 @{PLATTER_H:.1f}(压钢网,4 角圆弧外缘)",
         len([p for p in v if abs(p[1] - 8) < 0.06
              and PLATTER_H - 6.5 < abs(p[0]) < PLATTER_H and abs(p[2]) > PLATTER_H - 6.5]) > 10)
ck.check("底板顶面 Y=4 @>62(双层)",
         len([p for p in v if abs(p[1] - 4) < 0.06 and 62 < abs(p[0]) < 69]) > 10)
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
# 45° 倒角顶开口:直边 |x|≈66.20(窗口 62.60+倒角 3.6)
# 中段 |z|<60 避开 4 角圆角
bevel = [p for p in v if abs(p[1] - 4) < 0.05 and abs(abs(p[0]) - 66.20) < 0.10 and abs(p[2]) < 60]
ck.check(f"顶开口直边 |x|≈66.20({len(bevel)} 顶点)", len(bevel) >= 2)
# 顶开口角弧 R4.9(与窗口/B面同半径,非外偏放大):角心 (61.30,61.30)
arc = [p for p in v if abs(p[1] - 4) < 0.05
       and 60 < p[0] < 66 and 60 < p[2] < 66
       and abs(math.hypot(p[0] - 61.30, p[2] - 61.30) - 4.9) < 0.25]
ck.check(f"顶开口角弧 R4.9·与B面同半径({len(arc)} 顶点)", len(arc) >= 4)
# 窗口底缘 |x|≈62.50(与 base 同一 window_poly = frame 62.10 + 0.4):
#    cone 45° 倒角把窗口底面 |x|<62.70 完全切掉,窗口底面顶点不存在;
#    用射线法验证:Y=0.05 平面 |x|≈62.50 处是窗口内部(空) —— 钢网能塞进窗口
cover_tris = load_tris(parts["cover"])
wbot_ok = all(not solid(cover_tris, x, 0.05, 0.0) and not solid(cover_tris, 0.0, 0.05, x)
              for x in (62.5, 61.5, 60.0))
ck.check(f"窗口底缘 Y=0.05 内部空(钢网塞得进, |x|∈[60,62.5])",
         wbot_ok, "cone 已切掉该区, 改为射线法判贯通")
# 4 角定位柱过孔 r=4.7 全厚贯穿(收 Ø9 实心柱,免螺丝):
#    cover cone 倒角在 4 角柱孔圆心附近挖到 Y=1.7,孔壁顶点只 Y∈[0, 1.7] 可见,
#    圆周外侧被 cone 切斜面影响、不可靠;直接判圆心 Y∈[0,4] 全空即可确认孔贯通
for cx, cz in CORNERS:
    thru = all(not solid(cover_tris, cx, y, cz) for y in (0.05, 1.0, 2.0, 3.0, 3.95))
    ck.check(f"4角柱孔@({cx:.1f},{cz:.1f}) 贯通(圆心 Y∈[0,4] 全空)",
             thru, "用射线法判贯通,避开 cone 切掉孔壁顶点的视觉盲区")
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
# 拔模:斜面顶边 Y=4 @|x|≈63.60(窗口 62.60+1 拔模)
# 中段 |z|∈[51,62] 避开 4 角
bevel = [p for p in v if abs(p[1] - 4) < 0.05 and abs(abs(p[0]) - 63.60) < 0.10 and 51 < abs(p[2]) < 62]
ck.check(f"窗口拔模斜面顶边({len(bevel)} 顶点)", len(bevel) >= 2)
found = sum(1 for (x, z) in peri if ring(v, x, z, 1.75, 0.15))
ck.check(f"周圈底孔 {found}/{len(peri)}(与 cover 同心, Ø3.5 clearance)", found == len(peri))
# 4 角定位柱孔 r=4.7 全厚贯穿(与 cover 同尺寸,一一对应)
# —— 拔模斜面顶边 (|x|=63.60) 在 4 角附近覆盖到 4.7 半径处,
# 孔壁顶点 Y 上限被拔模斜面切到 3.60(底面 0,顶面拔模斜面 ≈ 4-0.4 = 3.60)
for cx, cz in CORNERS:
    hole = ring(v, cx, cz, 4.7, 0.15)
    yh = (min((p[1] for p in hole), default=99), max((p[1] for p in hole), default=-99))
    ck.check(f"4角柱孔@({cx:.1f},{cz:.1f}) 壁Y∈[{yh[0]:.1f},{yh[1]:.1f}]",
             len(hole) > 0 and yh[0] <= 0.05 and yh[1] >= 3.55)

ck.finish("v2 几何验证")
