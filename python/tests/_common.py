# -*- coding: utf-8
"""几何验证测试公共工具:路径定位 / 部件生成 / STL 解析 / check 汇总

设计要点:
- 产物(STL/JSON)写入 tempfile 临时目录,不污染仓库
- 生成用 sys.executable 起子进程(与生产 scad.rs 链路一致:CLI --input/--output)
- 坐标系:STL 导出前 rotate(Axis.X, -90) → build (x,y,z) → STL (x,z,-y);
  高度 = STL Y;孔圆周在 XZ 平面,圆心 = (cx, -cy)
"""
import json
import math
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PY_DIR = TESTS_DIR.parent            # python/
ROOT = PY_DIR.parent                 # 仓库根
GEN = PY_DIR / "jig_generator.py"

sys.path.insert(0, str(PY_DIR))

WORKDIR = Path(tempfile.mkdtemp(prefix="jig_test_"))


def gen_part(params, part, name=None, fmt="stl"):
    """生成单个部件 STL,返回路径(子进程调 CLI,失败抛异常打印 stderr)"""
    name = name or f"{params.get('_tag', 't')}_{part}"
    inp = WORKDIR / f"{name}.json"
    inp.write_text(json.dumps(params), encoding="utf-8")
    out = WORKDIR / f"{name}.{fmt}"
    r = subprocess.run(
        [sys.executable, str(GEN), "--input", str(inp),
         "--output", str(out), "--part", part, "--format", fmt],
        capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{part} 生成失败:\n{r.stderr[-1500:]}")
    return out


def load_tris(path):
    """二进制 STL → (n,3,3) float64 三角形数组"""
    raw = Path(path).read_bytes()
    n = struct.unpack("<I", raw[80:84])[0]
    tris, off = [], 84
    for _ in range(n):
        t = []
        for k in range(3):
            x, y, z = struct.unpack("<fff", raw[off + 12 + k * 12: off + 24 + k * 12])
            t.append((x, y, z))
        tris.append(t)
        off += 50
    return tris


def load_verts(path):
    """二进制 STL → 顶点列表[(x,y,z)]"""
    return [p for tri in load_tris(path) for p in tri]


def solid(tris, x, y, z):
    """XZ 平面投影射线法:(x,z) 处高度 y 是否实体(交点奇偶性)"""
    cnt = 0
    for (a, b, c) in tris:
        x0, z0 = a[0], a[2]; x1, z1 = b[0], b[2]; x2, z2 = c[0], c[2]
        d = (x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0)
        if abs(d) < 1e-12:
            continue
        s = ((x - x0) * (z2 - z0) - (z - z0) * (x2 - x0)) / d
        t_ = ((z - z0) * (x1 - x0) - (x - x0) * (z1 - z0)) / d
        if s < -1e-9 or t_ < -1e-9 or s + t_ > 1 + 1e-9:
            continue
        yi = a[1] + s * (b[1] - a[1]) + t_ * (c[1] - a[1])
        if yi > y:
            cnt += 1
    return cnt % 2 == 1


def ring(verts, cx, cz, r, tol=0.12):
    """孔壁顶点:圆心 (cx,cz) 在 XZ 平面,半径 r"""
    return [p for p in verts if abs(math.hypot(p[0] - cx, p[2] - cz) - r) < tol]


class Checker:
    """check 汇总:全部通过 exit 0,否则 exit 1(供 CI 判定)"""

    def __init__(self):
        self.fails = 0

    def check(self, label, cond, detail=""):
        print(f"  {label}: {'OK' if cond else 'FAIL'}{detail}")
        if not cond:
            self.fails += 1
        return bool(cond)

    def finish(self, title):
        ok = self.fails == 0
        print("\n" + "=" * 40)
        print(f"{title}: {'全部通过' if ok else f'{self.fails} 项失败'}")
        sys.exit(0 if ok else 1)


def base_params(**over):
    """常用默认参数(与 App 默认值一致),测试用 kwargs 覆盖"""
    p = {
        "pcb_size_x": 100, "pcb_size_y": 100, "pcb_thickness": 1.6,
        "pcb_pocket_clearance": 0.15,
        "pcb_outline_points": [], "pcb_outline_holes": [],
        "stencil_size": 0, "screw_spacing": 25,
        "base_height": 4, "top_cover_height": 4,
        "jig_size": 140, "insert_height": 8,
        "platter_height": 4, "platter_margin": 5,
        "platter_corner_radius": 4.5, "eject_slot_width": 22,
        # 默认 100×100 PCB:platterWidth=100(刚好盖住),lip=1.5(钢网为 0 时)
        "platter_width": 100,
        "stencil_lip": 1.5, "window_gap": 0.5,
        "pry_notch_sides": [], "pry_notch_scale": 1.0,
        "corner_screw_d": 5, "peri_screw_d": 3.5,
        "outer_corner_radius": 5, "base_support_pips": True,
    }
    p.update(over)
    return p
