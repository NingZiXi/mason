# -*- coding: utf-8 -*-
"""钢网扩张后取放缺口行为验证:

新语义(plater_radius 唇宽驱动,逐轴):platter_half = max(stencil_half - lip, slot_half)
本测试把凸台半宽固定为 58.15mm(壁深 8mm),即 100 板(slot_half=50.15)外扩 8mm:
- 有钢网:stencil_half - lip = 58.15 → stencil_size = 2*(58.15+1.5) = 119.3
- 无钢网:platter_margin = 8.0 兜底外扩到 58.15
两种途径得到同一凸台几何,便于对比。

- 缺口穿透判定:壁深 8 < 10(reach)+3 → 缺口完全切穿 8mm 壁,落到 base 底板
  → (0, y=7, z=57.5) 空,(0, y=7, z=60) 仍是底板本体(10mm 深,在 z=58-60 区间)

STL 映射:build (x,y,z)→(x,z,-y);build down 边(y=-50.15)→ STL z=+50.15
"""
import sys

sys.stdout.reconfigure(encoding="utf-8")
from _common import Checker, base_params, gen_part, load_tris, solid

ck = Checker()

# 100 板 + 0.15 间隙 → 槽半宽 50.15;目标凸台半宽 58.15(壁深 8mm)
SLOT_HALF = 50.15
WALL = 8.0
LIP = 1.5


def gen_insert(with_stencil=True):
    over = dict(jig_size=200, pry_notch_sides=["down"])
    if with_stencil:
        over["stencil_size"] = 2 * (SLOT_HALF + WALL + LIP)  # → platter_half 58.15
    else:
        over["stencil_size"] = 0
        over["platter_margin"] = WALL  # → platter_half 50.15+8 = 58.15
    return load_tris(gen_part(base_params(
        _tag=f"ns_{'s' if with_stencil else 's0'}", **over), "insert"))


print("=== 100 板 + 钢网(platter 半宽 58.15,壁深 8 < 10+3)===")
tris = gen_insert(True)
# 浅壁 → 10mm 缺口切穿 8mm 凸台壁,继续探入底板(直到底板本体边界):
# 槽缘 build y=-50.15 → 缺口区 build y∈[-60.15, -47.65] → STL z∈[47.65, 60.15]
# 凸台壁 z=58.15(已切穿),底板本体延伸到 z=70(jig/2=70)。壁深=8mm
ck.check("缺口中心 (0, y=7, z=55) 空(10mm 缺口内)", not solid(tris, 0, 7, 55))
ck.check("缺口底外凸台壁 (0, y=7, z=60) 空(壁深 8 < 缺口 10, 切穿到 base)",
         not solid(tris, 0, 7, 60))
ck.check("缺口旁凸台壁 (±18, y=7, z=55) 实体",
         solid(tris, 18, 7, 55) and solid(tris, -18, 7, 55))
ck.check("板下探入 (0, y=6, z=49) 空", not solid(tris, 0, 6, 49))
# 外口漏斗加宽:窄缺口(如 12mm 口)此点会实体 —— 验证加宽生效
ck.check("外口加宽 (±10, y=7, z=59.5) 空(窄口会实体)",
         (not solid(tris, 10, 7, 59.5)) and (not solid(tris, -10, 7, 59.5)))

print("=== 无钢网回归(platter_margin 兜底半宽 58.15,壁浅 → 切穿)===")
tris = gen_insert(False)
ck.check("缺口贯穿 (0, y=7, z=57.5) 空", not solid(tris, 0, 7, 57.5))
ck.check("缺口外实体 (±12, y=7, z=57.5) 实体",
         solid(tris, 12, 7, 57.5) and solid(tris, -12, 7, 57.5))

ck.finish("钢网扩张缺口验证")
