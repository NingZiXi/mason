import sys
sys.path.insert(0, r'e:\workspace\pcb-stencil-jig\python')

from jig_generator import generate_to_file
from pathlib import Path
import hashlib

base_params = {
    "pcb_size_x": 50, "pcb_size_y": 50, "pcb_thickness": 1.6,
    "pcb_pocket_clearance": 0.15, "pcb_outline_points": [], "pcb_outline_holes": [],
    "stencil_size": 100, "screw_spacing": 25,
    "base_height": 4, "top_cover_height": 4,
    "jig_size": 140, "insert_height": 8,
    "platter_height": 4, "platter_margin": 5,
    "platter_corner_radius": 4.5, "eject_slot_width": 22,
    "stencil_lip": 1.5, "window_gap": 0.5,
    "pry_notch_sides": [], "pry_notch_scale": 1.0,
    "corner_screw_d": 5, "peri_screw_d": 3.5,
    "outer_corner_radius": 5,
    "stencil_thickness": 0.3, "pad_shrink": 0,
    "stencil_frame_width": 12, "stencil_corner_radius": 3,
    "stencil_frame_shape": "outline",
    "pocket_clearance": 0.1,
    "stencil_taper": 105, "stencil_stagger": False,
    "stencil_stagger_gap": 0.55, "stencil_stagger_offset": 0.15,
    "stencil_filter_test_points": True,
    "stencil_test_point_max_dia": 1.2, "stencil_test_point_isolation": 1.5,
    "stencil_grid": False, "stencil_grid_size": 2.0, "stencil_grid_bar": 0.5,
    "stencil_pads": [], "stencil_pads_top": [], "stencil_pads_bottom": [],
    "use_hex_nut": False, "nut_across_flats": 5.5, "nut_height": 2.5,
}

cases = [
    ("platterWidth=97(默认)", 97, 1.5),
    ("platterWidth=90", 90, 5),
    ("platterWidth=80", 80, 10),
    ("platterWidth=70", 70, 15),
]

for part_name in ["base", "cover", "insert"]:
    print(f"\n=== {part_name} ===")
    for label, pw, lip in cases:
        p = dict(base_params, platter_width=pw, stencil_lip=lip)
        out = Path(rf"C:\Users\Hszn\AppData\Local\Temp\verify_{part_name}_{pw}.stl")
        generate_to_file(p, part_name, out, "stl")
        data = out.read_bytes()
        h = hashlib.sha256(data).hexdigest()[:12]
        print(f"  {label}: sha256={h} size={len(data)}")
