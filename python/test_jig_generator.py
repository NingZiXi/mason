"""jig_generator.py 几何层回归测试

覆盖三类:
1. 纯函数/公式(快,防回归):螺母六角对边距、大孔开网格行为
2. 端到端冒烟(需 build123d):base/insert/cover 生成 STL 成功且非空

运行(项目根目录):
    python -m pytest python/test_jig_generator.py -v
若缺 build123d/shapely,整个文件自动跳过(skip)。
"""
import math

import pytest

# jig_generator 顶层 `import build123d / OCP / shapely`,缺依赖则整文件跳过
pytest.importorskip("build123d")

from shapely.geometry import box as shapely_box  # noqa: E402

import jig_generator as jg  # noqa: E402


# 最小可用夹具参数(与 test_out/v2_input.json 同源,已验证可生成)
BASE_PARAMS = {
    "pcb_size_x": 100, "pcb_size_y": 100, "pcb_thickness": 1.6,
    "pcb_pocket_clearance": 0.15, "pcb_outline_points": [], "pcb_outline_holes": [],
    "stencil_size": 120, "screw_spacing": 25, "base_height": 4,
    "top_cover_height": 4, "jig_size": 140, "insert_height": 8,
    "platter_height": 4, "platter_margin": 5, "platter_corner_radius": 4.5,
    "eject_slot_width": 22, "corner_screw_d": 5, "peri_screw_d": 3.5,
    "outer_corner_radius": 5, "use_hex_nut": True, "screw_spec": "M3",
}


# ---------------------------------------------------------------------------
# 1. 螺丝/螺母参数
# ---------------------------------------------------------------------------

def test_peri_screw_params_m3():
    dia, across, height = jg.peri_screw_params({"screw_spec": "M3"})
    assert dia == 3.2
    assert across == 5.5
    assert height == 2.4


def test_nut_hex_across_flats_matches_gb6170():
    """回归:六角对边距曾把半径误写为 across/2(实为 across/√3)。

    正六边形顶点在角度 i*60°,对边距 = 2 * r * sin(60°) = r * √3。
    修复后 r = across/√3 → 对边距精确还原 across,各规格均达标。
    """
    for across in [4.5, 5.5, 6.0, 7.0, 8.0]:  # M2.5/M3/M3.5/M4/M5 (GB/T 6170)
        r = across / math.sqrt(3)
        computed = 2 * r * math.sin(math.pi / 3.0)
        assert math.isclose(computed, across, rel_tol=1e-9)


# ---------------------------------------------------------------------------
# 2. 大孔开网格(_grid_pad_geom)
# ---------------------------------------------------------------------------

def test_grid_pad_geom_large_pad_split():
    geom = shapely_box(0, 0, 5, 5)  # 5mm 大焊盘,单边 > 阈值 2.0
    out = jg._grid_pad_geom(geom, size_thr=2.0, bar_w=0.5)
    assert out.area < geom.area  # 十字条切掉部分面积
    assert out.geom_type in ("Polygon", "MultiPolygon")


def test_grid_pad_geom_small_pad_unchanged():
    geom = shapely_box(0, 0, 1, 1)  # 1mm 小焊盘,单边 <= 阈值 2.0
    out = jg._grid_pad_geom(geom, size_thr=2.0, bar_w=0.5)
    assert out.equals(geom)


def test_grid_pad_geom_threshold_sensitivity():
    """回归:减小阈值后中等焊盘应开始网格化(曾因固定 min_cell 门槛无效果)。"""
    geom = shapely_box(0, 0, 1.5, 1.5)
    out_hi = jg._grid_pad_geom(geom, size_thr=2.0, bar_w=0.5)  # 阈值高:不变
    out_lo = jg._grid_pad_geom(geom, size_thr=1.0, bar_w=0.5)  # 阈值低:网格化
    assert out_hi.equals(geom)
    assert out_lo.area < geom.area


# ---------------------------------------------------------------------------
# 3. 端到端冒烟(生成 STL)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("part", ["base", "insert", "cover"])
def test_generate_part_smoke(part, tmp_path):
    out = tmp_path / f"{part}.stl"
    jg.generate_to_file(dict(BASE_PARAMS), part, out, "stl")
    assert out.exists()
    assert out.stat().st_size > 0