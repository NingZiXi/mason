import sys
sys.path.insert(0, r'e:\workspace\pcb-stencil-jig\python')

from jig_generator import get_polys, compute_frame_poly
from shapely.geometry import box

# 新默认值:pcb=50×50, stencil=100, platterWidth=70, lip=15
p = {
    "pcb_size_x": 50, "pcb_size_y": 50, "pcb_thickness": 1.6,
    "pcb_pocket_clearance": 0.15, "pcb_outline_points": [], "pcb_outline_holes": [],
    "stencil_size": 100, "jig_size": 140, "window_gap": 0.5,
    "stencil_frame_width": 12, "stencil_frame_shape": "outline",
    "stencil_corner_radius": 3, "platter_corner_radius": 4.5,
    "outer_corner_radius": 5, "corner_screw_d": 5, "peri_screw_d": 3.5,
    "stencil_lip": 15, "platter_width": 70,
    "pry_notch_sides": [], "pry_notch_scale": 1.0,
    "stencil_taper": 105, "stencil_stagger": False,
    "stencil_grid": False, "stencil_grid_size": 2.0, "stencil_grid_bar": 0.5,
    "stencil_pads": [], "stencil_pads_top": [], "stencil_pads_bottom": [],
    "use_hex_nut": False,
    "pocket_clearance": 0.1,
}

slot, platter, window, _ = get_polys(p)
frame = compute_frame_poly(p)

def bbox_half(poly):
    minx, miny, maxx, maxy = poly.bounds
    return max(maxx - minx, maxy - miny) / 2

sh = bbox_half(slot)
ph = bbox_half(platter)
wh = bbox_half(window)
fh = bbox_half(frame)
print(f"默认参数验证(pcb=50×50, stencil=100, platterWidth=70, lip=15):")
print(f"  PCB 槽半宽: {sh:.2f} mm")
print(f"  凸台半宽: {ph:.2f} mm  (期望 35 = pw/2)")
print(f"  窗口半宽: {wh:.2f} mm  (期望 35.5 = 凸台 + gap)")
print(f"  钢网外缘半宽: {fh:.2f} mm  (= stencil_size/2 = 50)")
print()
print(f"  唇(lip) = (stencil - platterWidth)/2 = (100-70)/2 = 15 mm  ✓ 60% of lipMax=(100-50)/2=25")
print(f"  slider 位置 = 15 / 25 = 60%  ✓")
