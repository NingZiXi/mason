# -*- coding: utf-8 -*-
"""钢网尺寸适配验证(射线法实体探测)

新语义(plater_radius 反向钳制)—— 凸台顶面 ⊇ 钢网外缘是用户的物理约束:
  platter_half = max(platter_width / 2, slot_half)
  唇宽 stencil_lip = (stencil_size - platter_width) / 2

不变量:
- platter_width 必须 ≤ stencil_size,否则 lip 为负(无意义)
- 默认 platter_width = stencil_size - 2*lip,唇 = stencil_size - platter_width 是双边
- 凸台始终 ≥ 槽包围盒半宽(slotHalfMax),PCB 不会悬空
- 凸台 < stencil_size 时,钢网外缘的一部分直接放在唇上,
  唇厚 = 凸台高度(默认 4mm),几何上不会塌

测试设计:让 platter_width 接近 stencil_size(唇很小),
凸台 = max(platter_width/2, slot_half)。
- 100 板 + 唇 1mm → platter_width=98 → platter_half = max(49, 50.15) = 50.15
  (slot_half 反向钳制占主导,因为 pcb 比 platter_width 还大)
- 100 板 + 唇 5mm → platter_width=110 → platter_half = 55(platter_width 主导)
- 130 钢网 + 唇 1mm → platter_width=128 → platter_half = max(64, 50.15) = 64
- 140 钢网 + 唇 1mm → platter_width=138 → platter_half = max(69, 50.15) = 69

不变量:platter 顶面外缘 = platter_width/2(凸台本身)或 slot_half(PCB 大)
"""
import sys

sys.stdout.reconfigure(encoding="utf-8")
from _common import Checker, base_params, gen_part, load_tris, solid

ck = Checker()


def gen_insert(stencil, platter_width=None, stencil_lip=None):
    """platter_width + 2*stencil_lip = stencil_size(联动不变量)"""
    if platter_width is None and stencil_lip is None:
        platter_width = stencil - 2  # 默认唇 1mm
        stencil_lip = 1.0
    elif stencil_lip is None:
        stencil_lip = (stencil - platter_width) / 2
    return load_tris(gen_part(base_params(
        _tag=f"st_s{stencil}", stencil_size=stencil,
        platter_width=platter_width, stencil_lip=stencil_lip,
        jig_size=200), "insert"))


print("=== stencil=110:platter_width=108(唇=1),platter_half=max(54, 50.15)=54 ===")
tris = gen_insert(110, platter_width=108)
ck.check("x=54(凸台内,半宽 54) 实体", solid(tris, 54, 7, 0))
ck.check("x=55(凸台外) 空", not solid(tris, 55, 7, 0))
ck.check("y 向对称 (z=-54) 实体", solid(tris, 0, 7, -54))

print("=== stencil=130:platter_width=128(唇=1),platter_half=max(64, 50.15)=64 ===")
tris = gen_insert(130, platter_width=128)
ck.check("x=64(凸台内,半宽 64) 实体", solid(tris, 64, 7, 0))
ck.check("x=65(凸台外) 空", not solid(tris, 65, 7, 0))

print("=== stencil=140:platter_width=138(唇=1),platter_half=max(69, 50.15)=69 ===")
tris = gen_insert(140, platter_width=138)
ck.check("x=69(凸台内,半宽 69) 实体", solid(tris, 69, 7, 0))
ck.check("x=70(凸台外) 空", not solid(tris, 70, 7, 0))

ck.finish("钢网适配验证")
