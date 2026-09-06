# -*- coding: utf-8 -*-
"""B 面底座螺母反沉孔验证(M3 · 六角)

设计:
- 底面 (z = 0) 开口,深度 = nut_height + 0.2
- 形状:正六边形,内切圆 = nut_across_flats / 2(对边=直径)
- 开启时:周圈螺丝位 z<nut_height+0.2 应空;关闭时:同样位置应实体

用 OCC BRepClass3d_SolidClassifier 验证(几何真值),跟 test_holes 同套路。
"""
import sys

sys.stdout.reconfigure(encoding="utf-8")
from _common import Checker, base_params

import jig_generator as jg
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.gp import gp_Pnt
from OCP.TopAbs import TopAbs_IN

ck = Checker()

params_on = base_params(_tag="nut_on", stencil_size=140, screw_spacing=25,
                       jig_size=200, base_height=4, peri_screw_d=3.5,
                       use_hex_nut=True, nut_across_flats=5.5, nut_height=2.7)
params_off = dict(params_on, use_hex_nut=False)

bas_on = jg.build_base(params_on)
bas_off = jg.build_base(params_off)

win = jg.get_polys(params_on)[2]
peris = jg.compute_perimeter_screw_positions(
    params_on["jig_size"], win, params_on["screw_spacing"])
print(f"周圈螺丝位 {len(peris)} 颗,首孔 ({peris[0][0]:.1f},{peris[0][1]:.1f})")


def inside(part, x, y, z):
    for c in part:
        cls = BRepClass3d_SolidClassifier(c.wrapped)
        cls.Perform(gp_Pnt(x, y, z), 1e-6)
        if cls.State() == TopAbs_IN:
            return True
    return False


def solid_list(p):
    return list(p.solids())


bas_on_s = solid_list(bas_on)
bas_off_s = solid_list(bas_off)

px, py = peris[0]
across = params_on["nut_across_flats"]
nut_h = params_on["nut_height"]


def hexagon_inset_points(cx, cy, r, n=6):
    """返回正 n 边形顶点列表,内切圆半径 = r(对边 = 2r)"""
    import math
    return [(cx + r * math.cos(2 * math.pi * i / n),
             cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


print("=== use_hex_nut = True ===")
# 1) 底面中心空(z=0 是空气):六边形内切圆内任意点 z=0 应空
hex_in = hexagon_inset_points(px, py, across / 2.0)
import math
r_in = across / 2.0 * math.cos(math.pi / 6) * 0.9  # 在内切圆内,远离边
ck.check("底面 (z=0) 中心空(沉孔开口)",
         not inside(bas_on_s, px, py, 0.0))
ck.check(f"底面 (z=0) (px+r_in,py) 空(沉孔内)",
         not inside(bas_on_s, px + r_in, py, 0.0))
# 2) 沉孔底部(z=base_h - nut_h - 0.21) 应空
ck.check(f"沉孔深 z={4.0 - nut_h - 0.21:.2f} 空(沉孔底)",
         not inside(bas_on_s, px, py, 4.0 - nut_h - 0.21))
# 3) 沉孔顶部上方(z = base_h - 0.5,平台位置,远离沉孔深 2.7;
#    测试点放在沉孔外的实体位置 (px+r_in, py),因为螺丝位中心被周圈
#    通孔贯穿,任何 z 都是空)
ck.check(f"沉孔上方 z={4.0 - 0.5:.2f} 实(平台位置,沉孔外侧)",
         inside(bas_on_s, px + r_in, py, 4.0 - 0.5))
# 4) 六边形顶点 z=nut_h/2 应空(沉孔壁还在)
ck.check("六边形顶点 z=1.5 空(在沉孔内)",
         not inside(bas_on_s, hex_in[0][0], hex_in[0][1], 1.5))
# 5) 六边形顶点外 1mm z=1.5 应实体(超出沉孔,但仍在自攻底孔外)
ck.check("六边形外 1mm z=1.5 实(沉孔壁外)",
         inside(bas_on_s, hex_in[0][0] + math.cos(math.pi / 6),
                hex_in[0][1] + math.sin(math.pi / 6), 1.5))
# 6) 自攻底孔中心 z=base_h/2 仍空(贯穿,与螺母沉孔同位)
ck.check(f"自攻底孔 z=2 空(贯穿自攻底孔,沉孔同位)",
         not inside(bas_on_s, px, py, 2.0))

print("=== use_hex_nut = False ===")
# 关闭:自攻底孔位置 z=0 在贯穿底孔内应空(自攻底孔贯穿 -0.1..4.1),
# 沉孔不存在,但自攻底孔仍在
ck.check("底面 z=0 空(自攻底孔贯穿,即便关闭螺母槽也空)",
         not inside(bas_off_s, px, py, 0.0))
ck.check("中段 z=2 空(自攻底孔仍在)",
         not inside(bas_off_s, px, py, 2.0))
# 关闭模式应没有螺母沉孔独有的 z=base_h - 0.5 平台(没被螺母掏空,
# 应保持实体)——但 z=base_h - 0.5 = 3.5 > 自攻底孔顶部 z=4.1 - 还需检查
ck.check("关闭模式 z=base_h-0.5 实(平台未被螺母掏空)",
         inside(bas_off_s, px + r_in, py, 4.0 - 0.5))

print("=== 两种模式整体包围盒一致 ===")
on_bb = bas_on.bounding_box()
off_bb = bas_off.bounding_box()
ck.check(f"X 范围一致 on={on_bb.min.X:.2f}..{on_bb.max.X:.2f} "
         f"off={off_bb.min.X:.2f}..{off_bb.max.X:.2f}",
         abs(on_bb.min.X - off_bb.min.X) < 0.05
         and abs(on_bb.max.X - off_bb.max.X) < 0.05)
ck.check(f"Z 高一致 on={on_bb.min.Z:.2f}..{on_bb.max.Z:.2f} "
         f"off={off_bb.min.Z:.2f}..{off_bb.max.Z:.2f}",
         abs(on_bb.min.Z - off_bb.min.Z) < 0.05
         and abs(on_bb.max.Z - off_bb.max.Z) < 0.05)

ck.finish("B 面六角螺母沉孔验证")