"""导出当前默认参数下的 STL,然后用 trimesh 剖面看 XZ 平面"""
import sys, os
sys.path.insert(0, r"e:\workspace\pcb-stencil-jig\python")
from jig_generator import build_base, build_cover, build_insert
import trimesh, numpy as np

p = {
    "pcb_size_x": 50, "pcb_size_y": 50, "pcb_pocket_clearance": 0.15,
    "pcb_thickness": 1.6, "stencil_frame_width": 12, "pocket_clearance": 0.1,
    "stencil_size": 70, "platter_margin": 5.0, "platter_lip_min": 2.0,
    "jig_size": 100,
    "base_height": 4, "top_cover_height": 4, "insert_height": 8,
    "corner_screw_d": 5, "screw_spacing": 12, "outer_corner_radius": 5,
    "pcb_outline_points": [], "pcb_outline_holes": [],
    "screw_spec": "M3",
    "use_hex_nut": True, "eject_slot_width": 22,
}

os.makedirs(r"e:\workspace\pcb-stencil-jig\python\out", exist_ok=True)

cover = build_cover(p)
cover.export(r"e:\workspace\pcb-stencil-jig\python\out\_cover.stl")
base = build_base(p)
base.export(r"e:\workspace\pcb-stencil-jig\python\out\_base.stl")
ins = build_insert(p)
ins.export(r"e:\workspace\pcb-stencil-jig\python\out\_insert.stl")

print("exported")
import trimesh
for name in ("cover", "base", "insert"):
    m = trimesh.load(rf"e:\workspace\pcb-stencil-jig\python\out\_{name}.stl")
    bs = m.bounds
    print(f"{name} bounds: x[{bs[0][0]:.1f},{bs[1][0]:.1f}] y[{bs[0][1]:.1f},{bs[1][1]:.1f}] z[{bs[0][2]:.1f},{bs[1][2]:.1f}]")
    # 在 Y=0 截面取 XZ 投影,列出所有 y=0 顶点
    plane_v = m.vertices[np.abs(m.vertices[:, 1]) < 0.05]
    if len(plane_v) > 0:
        xs = np.sort(np.unique(np.round(plane_v[:, 0], 2)))
        zs = np.sort(np.unique(np.round(plane_v[:, 2], 2)))
        print(f"  Y=0 截面 X 唯一值: {xs[:30]}...")