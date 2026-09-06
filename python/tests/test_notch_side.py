# -*- coding: utf-8 -*-
"""验证 top/bottom 钢网取放缺口落在 PCB 同一条物理边缘"""
import sys
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, "e:/workspace/mason/python")
sys.path.insert(0, "e:/workspace/mason/python/tests")
from _common import gen_part, load_tris, solid

def probe(tris, bx, by, bz):
    return solid(tris, bx, bz, -by)

# 非对称板:y∈[-6,14](板子整体上移,上下边可区分)
# 板的"下边缘"(y=-6):bottom 槽缘 y=-6.2;top 镜像后该边到 y=+6.2
asym = [[-15, -6], [15, -6], [15, 14], [-15, 14], [-15, -6]]
p = {
    "pcb_size_x": 30, "pcb_size_y": 20, "pcb_thickness": 1.6,
    "pcb_outline_points": asym,
    "pcb_outline_holes": [],
    "stencil_thickness": 0.3, "stencil_frame_width": 8.0,
    "pocket_clearance": 0.2, "pad_shrink": 0.0,
    "pry_notch_sides": ["down"],
    "stencil_pads": [],
}
TOTAL = 1.6 + 0.3
ok = True

# bottom:板下边缘 y=-6 → 缺口区 y∈[-6.3,-10.3]
tris_b = load_tris(gen_part(dict(p), "stencil_bottom", name="nb_b"))
r1 = not probe(tris_b, 0, -8, TOTAL - 0.05)   # 缺口让位区应空
r2 = not probe(tris_b, 0, 8, TOTAL - 0.05)    # 板上边缘侧应实体(无边框孔)
print(f"[bottom] 板下边缘缺口空: {r1}  板上边缘实体: {r2}")
ok &= r1 and r2

# top:板下边缘镜像到 y=+6 → 缺口区 y∈[6.3,10.3]
tris_t = load_tris(gen_part(dict(p), "stencil_top", name="nb_t"))
r3 = not probe(tris_t, 0, 8, TOTAL - 0.05)    # 镜像后板下边缘缺口应空
r4 = not probe(tris_t, 0, -12, TOTAL - 0.05)  # 镜像后板上边缘(y=-14)侧实体
print(f"[top] 板下边缘(镜像)缺口空: {r3}  板上边缘(镜像)实体: {r4}")
ok &= r3 and r4

print("RESULT:", "PASS" if ok else "FAIL")
