# -*- coding: utf-8 -*-
"""周圈螺丝规格切换测试:screw_spec 决定周圈孔径 / 螺母反沉孔尺寸
(GB/T 5277 + GB/T 6170);用 ray-cast 验证 4 个规格对应的孔径
和螺母反沉孔尺寸正确。

孔位由 compute_perimeter_screw_positions 从窗口几何动态推导
(窗口半宽 = 凸台半宽 + window_gap;凸台 = 钢网 - 唇,逐轴),
避免硬编码坐标随钢网/唇宽语义变化而失效。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import (
    base_params, gen_part, load_tris, solid, Checker,
)

import jig_generator as jg

# base 默认高度 4mm;测高度 2(贯穿孔中间)
BASE_MID_Y = 2.0
# 螺母沉孔深 < 2.7(M3);测试深 1.0 一定在沉孔内
NUT_HOLE_Y = 1.0


def is_hole(tris, x, z, d, y):
    """(x, z) 半径 d/2 内、y 高度处,期望孔 = 不在实体内"""
    # 中心点不应在实体(通孔 z=-0.1..4.1 贯穿)
    return not solid(tris, x, y, z)


def gen_base_with(spec=None, use_hex=True, **extra):
    p = base_params(
        _tag=f"spec_{spec or 'default'}",
        use_hex_nut=use_hex,
        **extra,
    )
    if spec:
        p["screw_spec"] = spec
    return p


def peri_positions(p):
    """从几何推导周圈螺丝圆心坐标(jig/间距取自参数)"""
    jig = float(p["jig_size"])
    spacing = float(p["screw_spacing"])
    _slot, _platter, win, _shaped = jg.get_polys(dict(p))
    return jg.compute_perimeter_screw_positions(jig, win, spacing)


def run():
    ck = Checker()

    # 规格 → 期望孔径(per screw_spec_helper);测 4 个
    expected = [
        ("M2.5", 2.7),
        ("M3",   3.2),
        ("M4",   4.3),
        ("M5",   5.3),
    ]

    positions = peri_positions(base_params(_tag="pos_probe"))
    assert positions, "周圈螺丝位为空,无法验证"
    print(f"=== 周圈孔径验证(screw_spec → Ø),孔位 {len(positions)} 个 ===")

    # 每个规格的中心点位应为空(通孔贯穿 base)
    for spec, d in expected:
        tris = load_tris(gen_part(gen_base_with(spec=spec), "base"))
        n_hole = sum(
            1 for (x, z) in positions
            if is_hole(tris, x, z, d, BASE_MID_Y)
        )
        ck.check(f"{spec} Ø{d} 孔中心空({n_hole}/{len(positions)})",
                 n_hole == len(positions))

    # 兼容:不传 screw_spec 默认 M3
    p_default = base_params(_tag="default", use_hex_nut=True)
    tris = load_tris(gen_part(p_default, "base"))
    n = sum(1 for (x, z) in positions if is_hole(tris, x, z, 3.2, BASE_MID_Y))
    ck.check(f"默认(无 screw_spec)→ M3 Ø3.2 孔({n}/{len(positions)})",
             n == len(positions))

    # 兼容:用户手动覆盖 peri_screw_d 应优先于 screw_spec
    p_override = base_params(
        _tag="override",
        screw_spec="M3", peri_screw_d=4.5, use_hex_nut=True,
    )
    tris = load_tris(gen_part(p_override, "base"))
    n_ovr = sum(1 for (x, z) in positions
                if is_hole(tris, x, z, 4.5, BASE_MID_Y))
    ck.check(f"M3 规格下手动覆盖 Ø4.5({n_ovr}/{len(positions)})",
             n_ovr == len(positions))

    print("\n=== 螺母反沉孔尺寸(nut_across_flats)===")
    # M5 螺母对边 8mm;以 (x, z) 沉孔中心、y=1.0(沉孔内 0..2.7) 应该空
    spec = "M5"
    d_nut = 8.0  # 螺母对边
    tris = load_tris(gen_part(gen_base_with(spec=spec), "base"))
    n_inside = sum(1 for (x, z) in positions
                   if is_hole(tris, x, z, d_nut, NUT_HOLE_Y))
    ck.check(f"{spec} 螺母对边{d_nut} 沉孔内 y={NUT_HOLE_Y} 空({n_inside}/{len(positions)})",
             n_inside == len(positions))

    print(f"\n  验证 {len(expected)} 规格 × {len(positions)} 采样点")
    ck.finish("screw_spec 规格联动")


if __name__ == "__main__":
    run()
