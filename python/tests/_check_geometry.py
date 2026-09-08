import sys
sys.path.insert(0, r"e:\workspace\pcb-stencil-jig\python")

from jig_generator import get_polys, compute_frame_poly

p = {
    "pcb_size_x": 50, "pcb_size_y": 50, "pcb_pocket_clearance": 0.15,
    "pcb_thickness": 1.6, "stencil_frame_width": 12, "pocket_clearance": 0.1,
    "stencil_size": 70, "platter_margin": 5.0, "platter_lip_min": 2.0,
}

slot, platter, window, _ = get_polys(p)
mn, nn, mx, xx = slot.bounds
print(f"slot 半宽 = {mx:.2f}")
mn, nn, mx, xx = platter.bounds
print(f"platter 半宽 = {mx:.2f}")
mn, nn, mx, xx = window.bounds
print(f"window 半宽 = {mx:.2f}")

frame = compute_frame_poly(p)
mn, nn, mx, xx = frame.bounds
print(f"frame 半宽 = {mx:.2f}")

print(f"\n窗口内边到凸台外缘的间隙 = window - platter = {35.4 - 30.15:.2f} mm (这就是唇)")
print(f"窗口到钢网的间隙 = window - frame = {35.4 - 35.0:.2f} mm")

print(f"\n总结(默认 pcb=50,stencil=70,jig=100):")
print(f"  凸台半宽 30.15mm → 全宽 60.3mm")
print(f"  钢网半宽 35.00mm → 全宽 70.0mm")
print(f"  A/B 框半宽 35.40mm → 全宽 70.8mm")
print(f"  唇:钢网-凸台 = 5.0mm/边(钢网四角压在凸台四周的唇上)")