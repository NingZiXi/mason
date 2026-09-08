import sys
sys.path.insert(0, r'e:\workspace\pcb-stencil-jig\python')

from jig_generator import plater_radius, get_polys
from shapely.geometry import box

# 默认场景:PCB 50×50, stencil 100, platterWidth=97, lip=1.5
slot = box(-25.0, -25.0, 25.0, 25.0)  # PCB 50×50

cases = [
    ("platterWidth=97(默认,唇=1.5)", dict(stencil_size=100, platter_width=97, stencil_lip=1.5)),
    ("platterWidth=90(唇=5)", dict(stencil_size=100, platter_width=90, stencil_lip=5)),
    ("platterWidth=80(唇=10)", dict(stencil_size=100, platter_width=80, stencil_lip=10)),
    ("platterWidth=70(唇=15)", dict(stencil_size=100, platter_width=70, stencil_lip=15)),
]

print("=== 默认 50×50 PCB 场景 ===")
for label, p in cases:
    full_p = {
        "pcb_size_x": 50, "pcb_size_y": 50, "pcb_thickness": 1.6,
        "pcb_pocket_clearance": 0.15, "pcb_outline_points": [],
        "pcb_outline_holes": [],
        "jig_size": 140, "window_gap": 0.5,
        "stencil_frame_width": 12, "stencil_frame_shape": "rect",
        "stencil_corner_radius": 3, "platter_corner_radius": 4.5,
        "outer_corner_radius": 5, "corner_screw_d": 5, "peri_screw_d": 3.5,
        "pry_notch_sides": [], "pry_notch_scale": 1.0,
        "stencil_taper": 105, "stencil_stagger": False, "stencil_stagger_gap": 0.55,
        "stencil_stagger_offset": 0.15, "stencil_filter_test_points": True,
        "stencil_test_point_max_dia": 1.2, "stencil_test_point_isolation": 1.5,
        "stencil_grid": False, "stencil_grid_size": 2.0, "stencil_grid_bar": 0.5,
        "stencil_pads": [], "stencil_pads_top": [], "stencil_pads_bottom": [],
        "use_hex_nut": False, "nut_across_flats": 5.5, "nut_height": 2.5,
    }
    full_p.update(p)
    slot_poly, platter_poly, window_poly, is_shaped = get_polys(full_p)
    pb = platter_poly.bounds
    wb = window_poly.bounds
    pl = (pb[2] - pb[0]) / 2
    wl = (wb[2] - wb[0]) / 2
    pw = p["platter_width"]
    expected_pl = max(pw / 2, 25.0 + 0.15)
    ok = abs(pl - expected_pl) < 0.05
    print(f"{label}: 凸台半宽 {pl:.2f} (期望 {expected_pl:.2f},差 {pl-expected_pl:+.2f}) {'✓' if ok else '✗'}  窗口 {wl:.2f}")
