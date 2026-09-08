# -*- coding: utf-8 -*-
"""异形板(L形+内孔)验证 —— 射线法判据
核心判据:凸台壁/凸台顶面沿完整圆角矩形采样,用垂直射线与网格求交的
奇偶性判断材料区间(对稀疏三角化鲁棒,顶点法会漏判)
坐标系:STL = build rotate(X,-90) → (x,y,z)→(x,z,-y);高度=Y;build (x,y)→STL XZ (x,-y)
"""
import math
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
from _common import Checker, base_params, gen_part  # 先导入 _common(负责把 python/ 加入 sys.path)

import jig_generator as jg

ck = Checker()

params = base_params(
    _tag="irr", pcb_size_x=100, pcb_size_y=80, stencil_size=110,
    jig_size=160, platter_margin=5,
    pcb_outline_points=[[-50, -40], [50, -40], [50, 10], [20, 10], [20, 40],
                        [-50, 40], [-50, -40]],
    pcb_outline_holes=[[  # 圆孔 r=12 @ (0,10)
        [round(12.0 * math.cos(a), 3), round(10.0 + 12.0 * math.sin(a), 3)]
        for a in [i * math.pi / 12 for i in range(24)]
    ]])

# --- 生成 3 部件(insert 详细验证,cover/base 冒烟) ---
parts = {}
for part in ["insert", "cover", "base"]:
    parts[part] = gen_part(params, part)
    print(f"[OK] {part} 生成成功")

slot_poly, platter_poly, window_poly, is_shaped = jg.get_polys(params)
assert is_shaped, "应识别为异形板"
print(f"凸台多边形: {len(platter_poly.exterior.coords)} 顶点闭合, "
      f"bounds {tuple(round(b, 2) for b in platter_poly.bounds)}")

# --- STL 网格 + 垂直射线求交(Möller–Trumbore 向量化) ---
def load_tris_np(path):
    import struct
    raw = path.read_bytes()
    n = struct.unpack("<I", raw[80:84])[0]
    data = np.frombuffer(raw, dtype=np.uint8, count=n * 50, offset=84)
    return data.reshape(n, 50)[:, 12:48].copy().view(np.float32).reshape(n, 3, 3).astype(np.float64)

TRIS = load_tris_np(parts["insert"])
V0, V1, V2 = TRIS[:, 0], TRIS[:, 1], TRIS[:, 2]
E1, E2 = V1 - V0, V2 - V0
OY = -10.0  # 射线起点 Y(部件下方)

def hit_ys(sx, sz):
    """过 (sx,sz) 的竖直射线与网格的全部交点 Y 坐标(升序)"""
    pv = np.stack([E2[:, 2], np.zeros(len(E2)), -E2[:, 0]], axis=1)
    det = np.einsum("ij,ij->i", E1, pv)
    m = np.abs(det) > 1e-12
    tv = np.array([sx, OY, sz]) - V0
    u = np.einsum("ij,ij->i", tv, pv) / np.where(m, det, 1)
    qv = np.cross(tv, E1)
    v = qv[:, 1] / np.where(m, det, 1)   # dot(D,qvec) = qvec.y
    t = np.einsum("ij,ij->i", E2, qv) / np.where(m, det, 1)
    hit = m & (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9) & (t > 1e-6)
    return np.sort(t[hit] + OY)

def solid_at(sx, sz, y):
    """(sx,sz) 处高度 y 是否实体(交点数奇偶性)"""
    return bool(len([t for t in hit_ys(sx, sz) if t < y]) % 2)

def sample_boundary(poly, step=2.0):
    pts = list(poly.exterior.coords)
    out = []
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        d = math.hypot(x2 - x1, y2 - y1)
        for s in range(max(1, int(d / step))):
            t = s / max(1, int(d / step))
            # 微偏移避免射线正穿网格顶点/棱
            out.append((x1 + (x2 - x1) * t + 1e-4, -(y1 + (y2 - y1) * t) + 1e-4))
    return out

print("=== insert 射线几何验证 ===")

# 1. 凸台壁完整性:壁内缩 0.15 采样,Y=5.5 须全实体
samples = sample_boundary(platter_poly.buffer(-0.15, join_style=1))
gaps = [(round(sx, 2), round(sz, 2)) for sx, sz in samples if not solid_at(sx, sz, 5.5)]
ck.check(f"凸台壁完整({len(samples)} 采样, 缺口 {len(gaps)})", not gaps,
         f" 首个缺口: {gaps[0]}" if gaps else "")

# 2. 凸台顶面完整性:内缩 0.85 采样,Y=7.9 须全实体
#    (取放缺口设计性地切开凸台顶缘 → 排除缺口脚印:下边 z>37 且 |x|<9)
samples_t = sample_boundary(platter_poly.buffer(-0.85, join_style=1))
gaps_t = [(round(sx, 2), round(sz, 2)) for sx, sz in samples_t
          if not (sz > 37 and abs(sx) < 9)   # 缺口区
          and not solid_at(sx, sz, 7.9)]
ck.check(f"凸台顶面完整({len(samples_t)} 采样, 缺口 {len(gaps_t)})", not gaps_t,
         f" 首个缺口: {gaps_t[0]}" if gaps_t else "")

# 3. 底部圆形顶出孔:圆心=槽质心,d=28.1(r=14.05);圆内 Y=3 空,圆外实体
ctr = slot_poly.centroid
if not slot_poly.contains(ctr):
    ctr = slot_poly.representative_point()
ecx, ecz = ctr.x + 1e-3, -ctr.y + 1e-3
r_hole = 14.05
ck.check("圆形顶出孔(圆心及圆内 Y=3 空)",
         all(not solid_at(ecx + dx, ecz + dz, 3.0)
             for dx, dz in [(0, 0), (r_hole - 2, 0), (-r_hole + 2, 0)]))
ck.check("圆孔外 Y=3 实体",
         solid_at(ecx + r_hole + 2, ecz, 3.0) and solid_at(ecx - r_hole - 2, ecz, 3.0))

# 4. PCB 槽底 Y=6.4:槽内 Y=6.2 实体 / Y=6.6 空(L 两臂各一点)
for sx, sz, name in [(30, 20, "下臂"), (-30, -25, "上臂")]:
    ck.check(f"槽底 6.4 {name}(6.2 实体/6.6 空)",
             solid_at(sx + 1e-3, sz + 1e-3, 6.2) and not solid_at(sx + 1e-3, sz + 1e-3, 6.6))

# 5. 板内孔挖穿:孔心 build(0,10)→STL(0,-10),全高空;孔外实体
ck.check("内孔挖穿(孔心 Y=1/7 空)",
         not solid_at(1e-3, -10, 1.0) and not solid_at(1e-3, -10, 7.0))
ck.check("内孔外实体(孔壁旁 Y=5 / 撬口旁顶面 Y=7.5)",
         solid_at(13.0, -10, 5.0) and solid_at(13.0, -42, 7.5))

# 6. 顶面 Y=8 与总高(网格顶点级)
allv = TRIS.reshape(-1, 3)
ck.check("总高 12(托盘8+定位柱4) / 底 0",
         abs(allv[:, 1].max() - 12) < 0.05 and abs(allv[:, 1].min()) < 0.05)

# 7. 4 角空心定位柱(外 r4.5;内孔 r2.5 全高贯穿)
#    s = jig/2-(r_out+r_post+1)=80-11.5=68.5 兜底(异形板窗口 53+jig/2-7=73
#    不受外缘圆角重叠约束——按新 corner_screw_positions 钳到 69.5)
def ring_v(cx, cz, r, tol=0.12):
    return [p for p in allv if abs(math.hypot(p[0] - cx, p[2] - cz) - r) < tol]

# 用 generate 实际返回值(不重复推导):boss 圆心 (s,s)/(s,-s)/...
sp = jg.corner_screw_positions(window_poly, params["jig_size"], params)
for bx, by in sp:
    # STL:build (x,y)→XZ (x,-y),所以 build 角点 (bx,by)→STL (bx, -by)
    cx, cz = bx, -by
    boss = ring_v(cx, cz, 4.5)
    bore = ring_v(cx, cz, 2.5)
    yb = (min((p[1] for p in boss), default=99), max((p[1] for p in boss), default=-99))
    yp = (min((p[1] for p in bore), default=99), max((p[1] for p in bore), default=-99))
    ck.check(f"定位柱@({bx:.1f},{by:.1f}) 壁Y∈[{yb[0]:.1f},{yb[1]:.1f}] 内孔Y∈[{yp[0]:.1f},{yp[1]:.1f}]",
             len(boss) > 0 and 3.9 <= yb[0] <= 4.1 and 11.9 <= yb[1] <= 12.1
             and len(bore) > 0 and yp[0] <= 0.05 and yp[1] >= 11.9)

# 8. cover/base 冒烟
for part, hmax in [("cover", 4.0), ("base", 4.0)]:
    vs = load_tris_np(parts[part]).reshape(-1, 3)
    ck.check(f"{part} 厚度(Y max={hmax})",
             abs(vs[:, 1].max() - hmax) < 0.06 and abs(vs[:, 1].min()) < 0.05)
ck.check("cover 窗口轮廓规整(≤40 顶点圆角矩形)",
         len(window_poly.exterior.coords) <= 40,
         f"({len(window_poly.exterior.coords)} 顶点)")

ck.finish("异形板验证")
