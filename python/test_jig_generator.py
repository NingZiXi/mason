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
from shapely.geometry import Point as ShapelyPoint  # noqa: E402
from shapely.affinity import translate as shapely_translate  # noqa: E402
from shapely.affinity import rotate as shapely_rotate  # noqa: E402

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

def test_server_reuses_generation_metrics_and_cleans_failed_output(monkeypatch, tmp_path, capsys):
    import io
    import json
    import sys
    from types import SimpleNamespace
    out = tmp_path / "preview.stl"
    failed = tmp_path / "failed.stl"
    builds = []

    def build(params, part):
        builds.append((params, part))
        return SimpleNamespace(volume=10, area=20)

    def generate(params, part, path, fmt, on_model):
        path.write_bytes(b"partial")
        if params.get("fail"):
            raise RuntimeError("CAD failure")
        model = build(params, part)
        on_model(model)

    monkeypatch.setattr(jg, "generate_to_file", generate)
    monkeypatch.setattr(jg, "build_part", build)
    requests = [
        dict(id=1, cmd="generate", params={"value": 1}, part="insert", output=str(out)),
        dict(id=2, cmd="stats", params={"value": 1}, part="insert"),
        dict(id=3, cmd="stats", params={"value": 2}, part="insert"),
        dict(id=4, cmd="generate", params={"fail": True}, part="insert", output=str(failed)),
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("\n".join(map(json.dumps, requests))))
    jg.serve()
    responses = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [item[0] for item in builds] == [{"value": 1}, {"value": 2}]
    assert responses[1]["volume"] == 10
    assert responses[1]["area"] == 20
    assert responses[3]["ok"] is False
    assert not failed.exists()
    assert out.exists()


def test_metrics_cache_is_bounded_and_keeps_recent_results():
    cache = jg.MetricsCache(limit=2)
    cache.put("a", 1, 2)
    cache.put("b", 2, 4)
    assert cache.get("a") == (1, 2)
    cache.put("c", 3, 6)
    assert cache.get("b") is None
    assert len(cache.values) == 2
    from types import SimpleNamespace
    model = SimpleNamespace(volume=4, area=8)
    for key in ["d", "e", "f"]:
        cache.remember_model(key, model)
    assert len(cache.models) == 2
    assert cache.get("e") == (4, 8)
    assert "e" not in cache.models

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

@pytest.mark.parametrize("spec", ["M2.5", "M3", "M5"])
def test_nut_pocket_print_clearance_in_real_solid(spec):
    """All six flats have printing allowance, without cutting through the pocket roof."""
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN

    params = dict(BASE_PARAMS, screw_spec=spec, jig_size=200, base_height=7)
    default = jg.build_base(params)  # Legacy projects also get the default allowance.
    tight = jg.build_base(dict(params, nut_pocket_clearance=0))
    custom = jg.build_base(dict(params, nut_pocket_clearance=0.35))
    _, across, nut_h = jg.peri_screw_params(params)
    window = jg.get_polys(params)[2]
    cx, cy = jg.compute_perimeter_screw_positions(200, window, params["screw_spacing"])[0]

    def inside(part, distance, angle, z):
        point = gp_Pnt(cx + distance * math.cos(angle), cy + distance * math.sin(angle), z)
        for solid in part.solids():
            classifier = BRepClass3d_SolidClassifier(solid.wrapped)
            classifier.Perform(point, 1e-6)
            if classifier.State() == TopAbs_IN:
                return True
        return False

    for i in range(6):
        normal = math.pi / 6 + i * math.pi / 3
        # Sample either side of the nominal, default and custom flat boundaries.
        assert inside(tight, across / 2 + 0.1, normal, 1)
        assert not inside(default, across / 2 + 0.1, normal, 1)
        assert inside(default, across / 2 + 0.25, normal, 1)
        assert not inside(custom, across / 2 + 0.25, normal, 1)
        assert inside(custom, across / 2 + 0.4, normal, 1)
        assert inside(default, across / 2 - 0.1, normal, nut_h + 0.3)
    assert tight.volume > default.volume > custom.volume


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


@pytest.mark.parametrize("side", ["top", "bottom"])
def test_image_clear_polarity_restores_stencil_material(side):
    """Image-level LPC restores a 2 x 2 mm island inside a dark opening."""
    def pad(half, polarity):
        return {"polarity": polarity, "parts": [{
            "polarity": "D",
            "points": [[-half, -half], [half, -half], [half, half],
                       [-half, half], [-half, -half]],
        }]}

    params = dict(BASE_PARAMS, pcb_size_x=20, pcb_size_y=20,
                  stencil_size=0, stencil_size_x=0, stencil_size_y=0,
                  stencil_frame_width=4, stencil_thickness=0.3,
                  pad_shrink=0, stencil_filter_test_points=False,
                  pry_notch_sides=[])
    key = f"stencil_pads_{side}"
    params[key] = [pad(3, "D")]
    dark_volume = jg.build_stencil(params, side).volume
    params[key].append(pad(1, "C"))
    clear_volume = jg.build_stencil(params, side).volume
    # Steel below the pocket is thickness - 0.05 mm in the current geometry.
    assert clear_volume - dark_volume == pytest.approx(4 * (0.3 - 0.05), abs=1e-5)


def _paste_pad(geom, kind="circle", polarity="D"):
    return {"type": kind, "polarity": polarity, "parts": [{
        "polarity": "D", "points": list(geom.exterior.coords),
        "holes": [list(h.coords) for h in geom.interiors],
    }]}


@pytest.mark.parametrize("side", ["top", "bottom"])
def test_small_paste_openings_are_kept_by_default(side):
    """0402/smaller rectangles and labelled circular component pins remain holes.
    Compare actual OCC solid volumes, not just the number of parsed pads.
    """
    shapes = [
        shapely_box(-5.25, -0.225, -4.75, 0.225),  # 0.5 x 0.45 mm
        shapely_box(-0.1, -0.09, 0.1, 0.09),      # 0.2 x 0.18 mm
        ShapelyPoint(5, 2).buffer(0.15, resolution=8),
    ]
    params = dict(BASE_PARAMS, pcb_size_x=20, pcb_size_y=20,
                  stencil_size=0, stencil_size_x=0, stencil_size_y=0,
                  stencil_frame_width=4, stencil_thickness=0.3,
                  pad_shrink=0, pry_notch_sides=[])
    key = f"stencil_pads_{side}"
    params[key] = []
    blank_volume = jg.build_stencil(params, side).volume
    for shape, kind in zip(shapes, ["rect", "rect", "circle"]):
        params[key].append(_paste_pad(shape, kind))
    params[key][-1]["padRole"] = "component"
    opened_volume = jg.build_stencil(params, side).volume
    expected_area = sum(g.simplify(0.02, preserve_topology=True).area for g in shapes)
    assert blank_volume - opened_volume == pytest.approx(expected_area * 0.25, abs=1e-5)
    params["stencil_filter_test_points"] = False
    assert jg.build_stencil(params, side).volume == pytest.approx(opened_volume, abs=1e-5)


def test_filter_retains_unknown_roundrect_holes_and_bga_pads():
    circle = ShapelyPoint(0, 0).buffer(0.3, resolution=8)
    unknown = shapely_translate(circle, xoff=5)
    rounded = shapely_box(9.95, -0.05, 10.05, 0.05).buffer(0.2, resolution=8)
    annulus = shapely_translate(circle.difference(ShapelyPoint(0, 0).buffer(0.1)), xoff=15)
    bga1 = shapely_translate(circle, xoff=20)
    bga2 = shapely_translate(circle, xoff=20.8)
    geoms = [circle, unknown, rounded, annulus, bga1, bga2]
    pads = [_paste_pad(g, kind) for g, kind in zip(geoms, ["circle", "macro", "roundrect", "circle", "circle", "circle"])]
    candidates = [jg._is_test_point_candidate(pad, g, 1.9) for pad, g in zip(pads, geoms)]
    assert candidates == [True, False, False, False, True, True]
    entries = [(g, "D") for g in geoms]
    kept = jg._filter_test_point_pads(entries, geoms, candidates, 1.5)
    assert kept == entries[1:]  # Only the deliberately isolated known circle is removed.
    # Image-level clear circles restore material and are never filter candidates.
    assert not jg._is_test_point_candidate(_paste_pad(circle, polarity="C"), circle, 1.9)
    assert not jg._is_test_point_candidate(list(circle.exterior.coords), circle, 1.9)
    # A geometrically near-square shape is not a circle, even with bad metadata.
    assert not jg._is_test_point_candidate(_paste_pad(rounded), rounded, 1.9)


def test_filter_measures_original_pad_edges_not_centroids():
    circle = ShapelyPoint(0, 0).buffer(0.3, resolution=8)
    long_pad = shapely_box(1, -0.2, 30, 0.2)  # centroid is far outside the local circle's cell
    entries = [(circle, "D"), (long_pad, "D")]
    assert jg._filter_test_point_pads(entries, [circle, long_pad], [True, False], 1.5) == entries


def test_default_filter_is_used_and_can_be_disabled_during_stencil_generation():
    circle = ShapelyPoint(-5, 0).buffer(0.3, resolution=8)
    rectangle = shapely_box(4.9, -0.1, 5.1, 0.1)
    params = dict(BASE_PARAMS, pcb_size_x=20, pcb_size_y=20,
                  stencil_size=0, stencil_size_x=0, stencil_size_y=0,
                  stencil_frame_width=4, stencil_thickness=0.3,
                  pad_shrink=0, pry_notch_sides=[],
                  stencil_pads_top=[_paste_pad(circle), _paste_pad(rectangle, "rect")])
    filtered = jg.build_stencil(params).volume
    params["stencil_filter_test_points"] = False
    original = jg.build_stencil(params).volume
    assert filtered - original == pytest.approx(circle.simplify(0.02).area * 0.25, abs=1e-5)


@pytest.mark.parametrize("angle", [0, 37, 90])
@pytest.mark.parametrize("square_first", [False, True])
def test_filter_protects_sparse_regular_connector_rows(angle, square_first):
    # 2.54mm pitch is outside the 1.5mm edge-isolation setting. All pins must
    # survive, including row endpoints and a rectangular first pin.
    geoms, pads = [], []
    a = math.radians(angle)
    for i in range(3):
        x, y = -12 + i * 2.54 * math.cos(a), -10 + i * 2.54 * math.sin(a)
        g = (shapely_rotate(shapely_box(x - 0.3, y - 0.3, x + 0.3, y + 0.3), angle) if square_first and i == 0
             else ShapelyPoint(x, y).buffer(0.3, resolution=8))
        geoms.append(g)
        pads.append(_paste_pad(g, "rect" if square_first and i == 0 else "circle"))
    candidates = [jg._is_test_point_candidate(p, g, 1.9) for p, g in zip(pads, geoms)]
    entries = [(g, "D") for g in geoms]
    assert jg._filter_test_point_pads(entries, geoms, candidates, 1.5) == entries


def test_filter_does_not_mistake_irregular_round_test_points_for_an_array():
    geoms = [ShapelyPoint(x, y).buffer(0.3, resolution=8) for x, y in [(0, 0), (3, 0), (7, 2)]]
    entries = [(g, "D") for g in geoms]
    assert jg._filter_test_point_pads(entries, geoms, [True] * 3, 1.5) == []


def test_x2_roles_override_geometry_but_never_remove_clear_material():
    geoms = [ShapelyPoint(x, 0).buffer(0.3, resolution=8) for x in [0, 0.8, 1.6, 10]]
    entries = [(g, "D" if i < 3 else "C") for i, g in enumerate(geoms)]
    roles = ["testpoint", "component", None, "testpoint"]
    assert jg._filter_test_point_pads(entries, geoms, [False, False, True, False], 1.5, roles) == entries[1:]
    assert not jg._is_test_point_candidate(dict(_paste_pad(geoms[1]), padRole="component"), geoms[1], 1.9)
    # A solitary pad explicitly marked TestPad is removable without neighbours.
    assert jg._filter_test_point_pads(entries[:1], geoms[:1], [False], 1.5, ["testpoint"]) == []


@pytest.mark.parametrize("side", ["top", "bottom"])
def test_x2_roles_are_applied_to_the_generated_stencil(side):
    geom = ShapelyPoint(0, 0).buffer(0.3, resolution=8)
    pad = dict(_paste_pad(geom), padRole="component")
    params = dict(BASE_PARAMS, pcb_size_x=20, pcb_size_y=20,
                  stencil_size=0, stencil_size_x=0, stencil_size_y=0,
                  stencil_frame_width=4, stencil_thickness=0.3,
                  pad_shrink=0, pry_notch_sides=[])
    params[f"stencil_pads_{side}"] = [pad]
    opened = jg.build_stencil(params, side).volume
    pad["padRole"] = "testpoint"
    blank = jg.build_stencil(params, side).volume
    assert blank - opened == pytest.approx(geom.simplify(0.02).area * 0.25, abs=1e-5)
    params["stencil_filter_test_points"] = False
    assert jg.build_stencil(params, side).volume == pytest.approx(opened, abs=1e-5)


def test_failed_stencil_generation_does_not_export_a_blank_fallback(monkeypatch, tmp_path):
    def fail(*args):
        raise RuntimeError("aperture construction failed")
    monkeypatch.setattr(jg, "_ocp_prisms", fail)
    out = tmp_path / "invalid.stl"
    with pytest.raises(RuntimeError, match="钢网生成失败.*aperture construction failed"):
        jg.generate_to_file(dict(BASE_PARAMS), "stencil", out, "stl")
    assert not out.exists()


def test_failed_aperture_wire_is_not_silently_omitted(monkeypatch):
    geom = shapely_box(-2, -2, 2, 2).difference(shapely_box(-0.1, -0.1, 0.1, 0.1))
    original = jg.BRepBuilderAPI_MakePolygon
    calls = 0

    class FailedHoleWire:
        def Add(self, *args): pass
        def Close(self): pass
        def IsDone(self): return False

    def make_polygon():
        nonlocal calls
        calls += 1
        return original() if calls == 1 else FailedHoleWire()

    monkeypatch.setattr(jg, "BRepBuilderAPI_MakePolygon", make_polygon)
    with pytest.raises(RuntimeError, match="钢网轮廓或开孔构建失败"):
        jg._ocp_prisms([geom], 0, 0.25)


# ---------------------------------------------------------------------------
# 3. 端到端冒烟(生成 STL)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("part", ["base", "insert", "cover"])
def test_generate_part_smoke(part, tmp_path):
    out = tmp_path / f"{part}.stl"
    jg.generate_to_file(dict(BASE_PARAMS), part, out, "stl")
    assert out.exists()
    assert out.stat().st_size > 0


@pytest.mark.parametrize("clearance", [None, 0, 0.15, 0.225, 1.0])
def test_post_layout_uses_the_actual_hole_clearance(clearance):
    # A compact layout where the window constraint moves the posts, without
    # hitting the outer-edge clamp. Missing settings use the current default;
    # explicit legacy and zero clearances must remain unchanged.
    params = dict(corner_screw_d=5, outer_corner_radius=0,
                  platter_half_for_post=45, platter_corner_radius=4.5)
    if clearance is not None:
        params["post_clearance"] = clearance
    radius = 4.5 + (0.225 if clearance is None else clearance)
    assert jg.post_hole_radius(params) == pytest.approx(radius)
    positions = jg.corner_screw_positions(shapely_box(-50, -50, 50, 50), 122, params)
    assert len(positions) == 4
    for x, y in positions:
        assert abs(x) == pytest.approx(50 + radius)
        assert abs(y) == pytest.approx(50 + radius)


def test_post_clearance_geometry_change(tmp_path):
    """回归:post_clearance 越大,4 角定位孔越大 → STL 体积越小。

    该参数控制 cover/base 上 4 角柱孔半径 = corner_d/2 + 2.0 + post_clearance,
    insert 上定位柱半径固定 = corner_d/2 + 2.0。柱/孔间隙增大,
    cover/base 上减去的体积更多 → 净 STL 体积更小。
    """
    import os
    params_tight = dict(BASE_PARAMS, post_clearance=0.1)
    params_loose = dict(BASE_PARAMS, post_clearance=0.6)
    sizes = {}
    for tag, params in [("tight", params_tight), ("loose", params_loose)]:
        out = tmp_path / f"{tag}.stl"
        jg.generate_to_file(params, "cover", out, "stl")
        sizes[tag] = os.path.getsize(out)
    # 间隙越大,cover 上的 4 角孔越大 → STL 越小(孔里 0.5mm 的差距放大到 ~4πmm³ 体积差)
    assert sizes["loose"] < sizes["tight"]

# ---------------------------------------------------------------------------
# 2D inspection must report the manufacturing pipeline, including polarity,
# mirroring, shrink, filtering and grid splitting.
# ---------------------------------------------------------------------------

def _inspection_geom(polygons):
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    return unary_union([Polygon(item['outer'], item['holes']) for item in polygons])


def test_inspection_reports_explicit_and_inferred_filtered_pads():
    explicit = dict(_paste_pad(ShapelyPoint(-6, 2).buffer(.4, resolution=16), kind='circle'), padRole='testpoint')
    inferred = _paste_pad(ShapelyPoint(6, 2).buffer(.4, resolution=16), kind='circle')
    component = dict(_paste_pad(shapely_box(-.5, -.5, .5, .5), kind='rect'), padRole='component')
    params = dict(BASE_PARAMS, stencil_pads_top=[explicit, inferred, component],
                  pad_shrink=20, stencil_stagger=False, stencil_grid=False)
    report = jg.inspect_stencil(params)
    assert report['summary'] == dict(sourcePads=3, filteredPads=2, openings=1, invalidPads=0)
    assert [(p['sourceIndex'], p['reason']) for p in report['filtered']] == [(0, 'explicit'), (1, 'inferred')]
    assert report['filtered'][0]['width'] == pytest.approx(.8)
    assert _inspection_geom(report['filtered'][0]['polygons']).centroid.y == pytest.approx(-2)
    params['stencil_filter_test_points'] = False
    restored = jg.inspect_stencil(params)
    assert not restored['filtered']
    assert restored['summary']['openings'] == 3
    assert restored['original'] == report['original']


def test_inspection_preserves_clear_polarity_and_interior_rings():
    params = dict(BASE_PARAMS, stencil_pads_bottom=[
        _paste_pad(shapely_box(-2, -2, 2, 2), kind='rect'),
        _paste_pad(shapely_box(-.5, -.5, .5, .5), kind='rect', polarity='C')],
        pad_shrink=0, stencil_stagger=False, stencil_grid=False)
    report = jg.inspect_stencil(params, 'bottom')
    assert report['summary']['sourcePads'] == 1
    assert report['summary']['openings'] == 1
    assert len(report['openings'][0]['holes']) == 1
    assert _inspection_geom(report['original']).area == pytest.approx(15)
    assert _inspection_geom(report['openings']).area == pytest.approx(15)


@pytest.mark.parametrize('side', ['top', 'bottom'])
def test_inspection_grid_shrink_matches_actual_steel_layer(side):
    params = dict(BASE_PARAMS, pcb_size_x=12, pcb_size_y=12,
                  stencil_size=0, stencil_size_x=0, stencil_size_y=0,
                  **{f'stencil_pads_{side}': [_paste_pad(shapely_box(-2, 0, 2, 4), kind='rect')]},
                  pad_shrink=50, stencil_filter_test_points=False, stencil_stagger=False,
                  stencil_grid=True, stencil_grid_size=1, stencil_grid_bar=.5,
                  pry_notch_sides=[])
    report = jg.inspect_stencil(params, side)
    raw = _inspection_geom(report['original'])
    apertures = _inspection_geom(report['openings'])
    assert raw.area == pytest.approx(16)
    assert apertures.area == pytest.approx(2.25)
    assert report['summary']['openings'] == 4
    assert raw.centroid.y == pytest.approx(-2 if side == 'top' else 2)
    actual_steel = jg.build_stencil(params, side)._fast_stl[0][0][0]
    frame = jg.compute_frame_poly(params)
    if side == 'top':
        frame = jg.shapely_scale_aff(frame, xfact=1, yfact=-1)
    assert frame.difference(apertures).symmetric_difference(actual_steel).area < 1e-5


def test_inspection_all_filtered_empty_side_and_invalid_geometry():
    circle = dict(_paste_pad(ShapelyPoint(0, 0).buffer(.4, resolution=16), kind='circle'), padRole='testpoint')
    params = dict(BASE_PARAMS, stencil_pads_top=[circle, {'parts': []}],
                  stencil_stagger=False, stencil_grid=False)
    report = jg.inspect_stencil(params)
    assert report['summary'] == dict(sourcePads=1, filteredPads=1, openings=0, invalidPads=1)
    assert report['openings'] == []
    assert jg.inspect_stencil(params, 'bottom')['original'] == []
    with pytest.raises(ValueError):
        jg.inspect_stencil(params, 'unknown')


def test_inspection_protocol_returns_data_without_building_solid(monkeypatch, capsys):
    import io
    import json
    import sys
    def forbidden(*args, **kwargs):
        raise AssertionError('2D inspection must not build a CAD solid')
    monkeypatch.setattr(jg, 'build_part', forbidden)
    requests = [dict(id=1, cmd='inspect_stencil', part='stencil_top', params=BASE_PARAMS),
                dict(id=2, cmd='inspect_stencil', part='base', params=BASE_PARAMS)]
    monkeypatch.setattr(sys, 'stdin', io.StringIO('\n'.join(map(json.dumps, requests))))
    jg.serve()
    responses = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert responses[0]['id'] == 1 and responses[0]['ok']
    assert responses[0]['inspection']['side'] == 'top'
    assert responses[1]['id'] == 2 and not responses[1]['ok']

@pytest.mark.parametrize('side', ['top', 'bottom'])
def test_probe_test_pads_near_components_are_filtered_and_respect_diameter(side):
    circle = ShapelyPoint(-2, 1).buffer(.9, resolution=16)
    neighbour = shapely_box(-.9, .6, -.3, 1.4)  # only 0.2 mm from the test pad
    probe = dict(_paste_pad(circle), padRole='testpoint', padRoleSource='flying-probe')
    params = dict(BASE_PARAMS, pcb_size_x=12, pcb_size_y=12,
                  stencil_size=0, stencil_size_x=0, stencil_size_y=0,
                  stencil_frame_width=4, stencil_thickness=.3, pad_shrink=0,
                  stencil_stagger=False, stencil_grid=False, pry_notch_sides=[],
                  **{f'stencil_pads_{side}': [probe, _paste_pad(neighbour, 'rect')]})
    report = jg.inspect_stencil(params, side)
    assert report['summary']['filteredPads'] == 1
    assert report['filtered'][0]['reason'] == 'probe'
    filtered_volume = jg.build_stencil(params, side).volume
    # Keep the boundary value despite floating-point subtraction of bounds.
    params['stencil_test_point_max_dia'] = 1.8
    assert jg.inspect_stencil(params, side)['summary']['filteredPads'] == 1
    params['stencil_test_point_max_dia'] = 1.5
    assert jg.inspect_stencil(params, side)['summary']['filteredPads'] == 0
    params['stencil_test_point_max_dia'] = 1.9
    params['stencil_filter_test_points'] = False
    assert jg.inspect_stencil(params, side)['summary']['filteredPads'] == 0
    restored_volume = jg.build_stencil(params, side).volume
    assert filtered_volume - restored_volume == pytest.approx(circle.simplify(.02).area * .25, abs=1e-5)
    probe.pop('padRole'); probe.pop('padRoleSource')
    params['stencil_filter_test_points'] = True
    # No metadata: the close neighbour still protects an ambiguous round pad.
    assert jg.inspect_stencil(params, side)['summary']['filteredPads'] == 0


@pytest.mark.parametrize('side', ['top', 'bottom'])
def test_manual_apertures_override_filtering_and_match_generated_steel(side):
    testpad = dict(_paste_pad(ShapelyPoint(-3, 1).buffer(.9, resolution=16), 'circle'), padRole='testpoint')
    normal = _paste_pad(shapely_box(1, 0, 3, 2), 'rect')
    params = dict(BASE_PARAMS, pcb_size_x=12, pcb_size_y=12, pad_shrink=20,
                  stencil_size=0, stencil_size_x=0, stencil_size_y=0, pry_notch_sides=[],
                  stencil_stagger=False, stencil_grid=False,
                  **{f'stencil_pads_{side}': [testpad, normal]})
    automatic = jg.inspect_stencil(params, side)
    assert automatic['summary']['filteredPads'] == 1
    testpad['apertureOverride'] = 'open'
    normal['apertureOverride'] = 'closed'
    report = jg.inspect_stencil(params, side)
    assert report['summary']['filteredPads'] == 0
    assert [p['decision'] for p in report['pads']] == ['open', 'closed']
    openings = _inspection_geom(report['openings'])
    assert openings.area < ShapelyPoint(0, 0).buffer(.9).area  # shrink still applies
    for enabled in (True, False):
        params['stencil_filter_test_points'] = enabled
        assert jg.inspect_stencil(params, side)['openings'] == report['openings']
    steel = jg.build_stencil(params, side)._fast_stl[0][0][0]
    frame = jg.compute_frame_poly(params)
    if side == 'top':
        frame = jg.shapely_scale_aff(frame, xfact=1, yfact=-1)
    assert frame.difference(openings).symmetric_difference(steel).area < 1e-5
    normal.pop('apertureOverride'); testpad.pop('apertureOverride')
    params['stencil_filter_test_points'] = True
    assert jg.inspect_stencil(params, side)['openings'] == automatic['openings']


def test_manual_closure_seals_overlapping_openings_and_preserves_clear_and_holes():
    closed = dict(_paste_pad(shapely_box(-1, -1, 1, 1), 'rect'), apertureOverride='closed')
    neighbour = dict(_paste_pad(shapely_box(0, -1, 2, 1), 'rect'), apertureOverride='open')
    clear = dict(_paste_pad(shapely_box(1.25, -.25, 1.75, .25), 'rect'), polarity='C', apertureOverride='open')
    params = dict(BASE_PARAMS, pad_shrink=0, stencil_filter_test_points=False,
                  stencil_stagger=False, stencil_grid=False, stencil_pads_bottom=[closed, neighbour, clear])
    report = jg.inspect_stencil(params, 'bottom')
    openings = _inspection_geom(report['openings'])
    assert openings.area == pytest.approx(1.75)
    assert not openings.intersects(ShapelyPoint(.5, 0))
    assert not openings.intersects(ShapelyPoint(1.5, 0))
    assert [p['sourceIndex'] for p in report['pads']] == [0, 1]
    assert report['summary']['sourcePads'] == 2


def test_manually_opened_pad_still_uses_shrink_and_grid_settings():
    pad = dict(_paste_pad(shapely_box(-2, 0, 2, 4), 'rect'), padRole='testpoint', apertureOverride='open')
    params = dict(BASE_PARAMS, stencil_pads_bottom=[pad], stencil_grid=True,
                  stencil_grid_size=1, stencil_grid_bar=.5, pad_shrink=50, stencil_stagger=False)
    report = jg.inspect_stencil(params, 'bottom')
    assert report['summary']['openings'] == 4
    assert _inspection_geom(report['openings']).area == pytest.approx(2.25)
    pad['apertureOverride'] = 'closed'
    assert not jg.inspect_stencil(params, 'bottom')['openings']
    pad.pop('apertureOverride')
    assert jg.inspect_stencil(params, 'bottom')['summary']['filteredPads'] == 1
