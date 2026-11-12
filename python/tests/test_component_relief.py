"""Second-face tray regression checks; no pytest dependency required.

Run with the bundled interpreter:
  src-tauri/resources/python-env/python.exe -B python/tests/test_component_relief.py
"""
import copy
import json
import math
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import jig_generator as jg
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.TopAbs import TopAbs_IN, TopAbs_ON
from OCP.gp import gp_Pnt
from shapely.geometry import Point, Polygon, box
from shapely.ops import unary_union


BASE = {
    "pcb_size_x": 40, "pcb_size_y": 30, "pcb_thickness": 1.6,
    "pcb_pocket_clearance": 0.2, "pcb_outline_points": [], "pcb_outline_holes": [],
    "stencil_size_x": 70, "stencil_size_y": 60, "stencil_lip": 8,
    "screw_spacing": 0, "base_height": 4, "top_cover_height": 4,
    "jig_size": 110, "insert_height": 8, "platter_height": 4,
    "platter_margin": 5, "platter_corner_radius": 3, "outer_corner_radius": 3,
    "window_gap": 0.5, "eject_slot_width": 0, "pry_notch_sides": [],
    "corner_screw_d": 5, "post_clearance": 0.225, "peri_screw_d": 3.2,
    "use_hex_nut": True, "screw_spec": "M3",
}


def region(identity="pocket-1", **changes):
    result = dict(id=identity, shape="rect", x=0, y=0, width=8, height=6)
    result.update(changes)
    return result


def params(**changes):
    p = copy.deepcopy(BASE)
    p.update(component_relief_enabled=True, component_relief_depth=3,
             jig_print_side="top", component_relief_regions=[region()])
    p.update(changes)
    return p


def polygon_region(identity="polygon-1", points=None, **changes):
    # The concave corner must retain support instead of cutting its whole bbox.
    result = region(identity, shape="polygon", points=points if points is not None else [
        [2, -4], [12, -4], [12, 0], [6, 0], [6, 5], [2, 5],
    ])
    result.update(changes)
    return result


def inside(part, x, y, z):
    for solid in part.solids():
        classifier = BRepClass3d_SolidClassifier(solid.wrapped)
        classifier.Perform(gp_Pnt(x, y, z), 1e-6)
        if classifier.State() in (TopAbs_IN, TopAbs_ON):
            return True
    return False


def c_slot_ring():
    """A valid open C-shaped PCB cutout; the default eject disk closes its gap."""
    angles = [math.radians(30 + index * 300 / 60) for index in range(61)]
    return [[-8 + 8 * math.cos(angle), 8 * math.sin(angle)] for angle in angles] + [
        [-8 + 5 * math.cos(angle), 5 * math.sin(angle)] for angle in reversed(angles)]


class ComponentReliefTests(unittest.TestCase):
    def test_retraced_board_cutout_keeps_both_repaired_holes(self):
        # A closed internal Gerber contour with a retraced bridge passes the
        # outline parser, then repairs to two separate square cutouts.
        ring = [[-10, -8], [-4, -8], [-4, -2], [-10, -2], [-10, -8],
                [4, -8], [10, -8], [10, -2], [4, -2], [4, -8]]
        self.assertFalse(Polygon(ring).is_valid)
        self.assertEqual(Polygon(ring).buffer(0).geom_type, "MultiPolygon")
        for enabled in (False, True):
            for side in ("top", "bottom"):
                for clearance in (0, 0.2):
                    with self.subTest(enabled=enabled, side=side, clearance=clearance):
                        p = params(component_relief_enabled=enabled, jig_print_side=side,
                                   pcb_pocket_clearance=clearance,
                                   pcb_outline_points=[[-20, -15], [20, -15], [20, 15], [-20, 15]],
                                   pcb_outline_holes=[ring],
                                   component_relief_regions=[region(x=0, y=8, width=3, height=3)])
                        original = copy.deepcopy(p)
                        self.assertEqual(len(jg._insert_board_holes(p)), 2)
                        with patch.object(jg, "poly_solid", side_effect=AssertionError("preflight built CAD")), \
                                patch.object(jg, "_ocp_prisms", side_effect=AssertionError("preflight built CAD")):
                            self.assertEqual(jg.validate_component_relief(p), {"valid": True})
                        self.assertEqual(p, original)
                        # Disabled-relief builders retain their legacy derived
                        # parameter writes; the caller keeps the canonical input.
                        part = jg.build_insert(copy.deepcopy(p))
                        self.assertTrue(part.is_valid)
                        self.assertEqual(len(part.solids()), 1)
                        y = 5 if enabled and side == "bottom" else -5
                        for z in (0.5, 5.5):
                            self.assertFalse(inside(part, -7, y, z))
                            self.assertFalse(inside(part, 7, y, z))
                            self.assertTrue(inside(part, 0, y, z))
                        self.assertEqual(p, original)

    def test_existing_cutout_and_eject_ring_rejects_detached_tray_in_every_relief_mode(self):
        for enabled in (False, True):
            for through in (False, True):
                for side in ("top", "bottom"):
                    with self.subTest(enabled=enabled, through=through, side=side):
                        p = params(component_relief_enabled=enabled, jig_print_side=side,
                                   pcb_outline_holes=[c_slot_ring()], eject_slot_width=22,
                                   component_relief_regions=[region(x=12, y=8, width=3, height=3,
                                                                    through=through, depth=2)])
                        original = copy.deepcopy(p)
                        with patch.object(jg, "poly_solid", side_effect=AssertionError("preflight built CAD")):
                            result = jg.validate_component_relief(p)
                            self.assertFalse(result["valid"])
                            self.assertIn("悬空", result["error"])
                            self.assertFalse(jg.merge_component_relief(p, selected_ids=[])["valid"])
                            with self.assertRaisesRegex(ValueError, "悬空"):
                                jg.build_insert(copy.deepcopy(p))
                        self.assertEqual(p, original)

    def test_cutout_and_eject_ring_is_an_actual_second_cad_solid(self):
        p = params(pcb_outline_holes=[c_slot_ring()], eject_slot_width=22,
                   component_relief_regions=[region(x=12, y=8, width=3, height=3, depth=2)])
        # Independently retain the original defective construction once: the
        # 2D guard must detect a real disconnected solid, not just a visual gap.
        with patch.object(jg, "_validate_insert_connectivity"):
            part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertEqual(len(part.solids()), 2)
        self.assertTrue(inside(part, -8, 0, 0.5))
        self.assertTrue(inside(part, -8, 0, 6.3))

    def test_open_c_slot_is_valid_when_eject_hole_is_disabled_or_does_not_close_it(self):
        for diameter, enabled in ((0, False), (4, True)):
            with self.subTest(diameter=diameter, enabled=enabled):
                p = params(pcb_outline_holes=[c_slot_ring()], eject_slot_width=22 if enabled else 0,
                           eject_hole_diameter=diameter,
                           component_relief_regions=[region(x=12, y=8, width=3, height=3, through=True)])
                self.assertEqual(jg.validate_component_relief(p), {"valid": True})
                self.assertTrue(jg.merge_component_relief(p, selected_ids=[])["valid"])
                part = jg.build_insert(p)
                self.assertTrue(part.is_valid)
                self.assertEqual(len(part.solids()), 1)

    def test_disabled_relief_ignores_old_invalid_fields_but_still_checks_real_tray_cuts(self):
        p = dict(BASE, component_relief_enabled=False, component_relief_depth="old-invalid-value",
                 jig_print_side="old-invalid-value", component_relief_regions={"old": "invalid"},
                 pcb_outline_holes=[c_slot_ring()], eject_slot_width=0)
        original = copy.deepcopy(p)
        self.assertEqual(jg.validate_component_relief(p), {"valid": True})
        self.assertEqual(p, original)
        result = jg.validate_component_relief(dict(p, eject_slot_width=22))
        self.assertFalse(result["valid"])
        self.assertIn("悬空", result["error"])
        empty = params(component_relief_regions=[], pcb_outline_holes=[c_slot_ring()], eject_slot_width=22)
        self.assertFalse(jg.validate_component_relief(empty)["valid"])

    def test_thin_pcb_rejects_support_lost_to_the_real_top_bevel(self):
        for side in ("top", "bottom"):
            for through in (False, True):
                with self.subTest(side=side, through=through):
                    p = params(pcb_thickness=0.4, stencil_lip=14.8, jig_print_side=side,
                               component_relief_regions=[region(width=39.9, height=30, through=through)])
                    original = copy.deepcopy(p)
                    # Nominal edge strips still have 3 mm²; the top bevel is
                    # what removes them at the actual 7.6 mm PCB datum.
                    self.assertAlmostEqual(40 * 30 - 39.9 * 30, 3)
                    with patch.object(jg, "poly_solid", side_effect=AssertionError("preflight built CAD")):
                        validation = jg.validate_component_relief(p)
                    self.assertFalse(validation["valid"])
                    self.assertIn("凸台圆角、倒角", validation["error"])
                    with self.assertRaisesRegex(ValueError, "没有可承托区域"):
                        jg.build_insert(p)
                    self.assertFalse(jg.merge_component_relief(p, selected_ids=[])["valid"])
                    self.assertEqual(p, original)

    def test_normal_pcb_does_not_reject_the_same_supported_edge_strips(self):
        p = params(pcb_thickness=1.6, stencil_lip=14.8,
                   component_relief_regions=[region(width=39.9, height=30)])
        self.assertEqual(jg.validate_component_relief(p), {"valid": True})
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertTrue(inside(part, 19.975, 0, 6.399))
        self.assertTrue(inside(part, -19.975, 0, 6.399))

    def test_thin_supported_pcb_section_matches_actual_bevel_without_changing_geometry(self):
        for radius in (0, 3, 10):
            with self.subTest(radius=radius):
                p = params(pcb_thickness=0.4, stencil_lip=14.8, platter_corner_radius=radius,
                           component_relief_regions=[region(width=39, height=30)])
                normalized = jg._jig_component_params(p)
                _, platter, _, _ = jg.get_polys(normalized)
                relief = jg._component_relief_geometry(normalized)
                section = jg._insert_support_footprint(normalized, platter)
                expected = box(-20, -15, 20, 15).intersection(section).difference(relief).area
                self.assertGreater(expected, 1)
                self.assertEqual(jg.validate_component_relief(p), {"valid": True})
                part = jg.build_insert(p)
                self.assertTrue(part.is_valid)
                self.assertEqual(len(part.solids()), 1)
                # Independent OCC intersection at the PCB datum validates the
                # analytic parallel-edge section, including polygonal arcs.
                dz = 1e-5
                slab = jg.bd.Box(40, 30, dz, align=(jg.bd.Align.CENTER, jg.bd.Align.CENTER, jg.bd.Align.MIN))
                slab = slab.moved(jg.bd.Location((0, 0, 7.6 - dz)))
                common = part.intersect(slab)
                pieces = list(common) if isinstance(common, list) else ([common] if common else [])
                self.assertAlmostEqual(sum(piece.volume for piece in pieces) / dz, expected, delta=0.001)

    def test_rounded_platter_corners_do_not_count_as_support_outside_the_solid(self):
        p = params(stencil_lip=14.8, component_relief_regions=[
            region("left", x=-0.1, width=39.8, height=30),
            region("right-lower", x=19.9, y=-0.1, width=0.2, height=29.8)])
        # The nominal 0.2 × 0.2 corner is entirely outside the R3 platter.
        validation = jg.validate_component_relief(p)
        self.assertFalse(validation["valid"])
        self.assertIn("没有可承托区域", validation["error"])
        squared = dict(p, platter_corner_radius=0)
        self.assertEqual(jg.validate_component_relief(squared), {"valid": True})

    def test_pcb_reaching_the_lower_plate_is_not_restricted_by_the_platter(self):
        p = params(base_height=1.6, pcb_thickness=1.6, stencil_lip=14.8,
                   component_relief_regions=[
                       region("left", x=-0.1, width=39.8, height=30),
                       region("right-lower", x=19.9, y=-0.1, width=0.2, height=29.8)])
        normalized = jg._jig_component_params(p)
        _, platter, _, _ = jg.get_polys(normalized)
        self.assertIsNone(jg._insert_support_footprint(normalized, platter))
        self.assertEqual(jg.validate_component_relief(p), {"valid": True})
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertTrue(inside(part, 19.9, 14.9, 6.399))

    def test_low_platter_keeps_the_existing_unapplied_chamfer_fallback(self):
        for height in (0.5, 0.75):
            with self.subTest(height=height):
                p = params(base_height=height, pcb_thickness=0.4, stencil_lip=14.8,
                           component_relief_regions=[region(width=39.9, height=30)])
                normalized = jg._jig_component_params(p)
                _, platter, _, _ = jg.get_polys(normalized)
                original = jg.poly_solid(platter.exterior.coords, height)
                actual = jg.chamfer_platter_top(original, height)
                self.assertAlmostEqual(original.volume, actual.volume, places=7)
                self.assertTrue(jg._insert_support_footprint(normalized, platter).equals(platter))
                self.assertEqual(jg.validate_component_relief(p), {"valid": True})
                self.assertTrue(inside(jg.build_insert(p), 19.975, 0, 7.599))

    def test_through_normalization_keeps_blind_depth_without_thickening_tray(self):
        for pocket in (region(through=True, depth=20),
                       region(shape="circle", width=6, height=6, through=True, depth=20),
                       polygon_region(through=True, depth=20)):
            with self.subTest(shape=pocket["shape"]):
                p = params(component_relief_regions=[pocket])
                original = copy.deepcopy(p)
                normalized = jg._jig_component_params(p)
                self.assertEqual(normalized["insert_height"], 8)
                self.assertTrue(normalized["component_relief_regions"][0]["through"])
                self.assertEqual(normalized["component_relief_regions"][0]["depth"], 20)
                self.assertEqual(p, original)
        p = params(component_relief_depth=20, component_relief_regions=[
            region("through", x=-10, through=True),
            region("blind", x=10, width=6, depth=8)])
        normalized = jg._jig_component_params(p)
        self.assertAlmostEqual(normalized["insert_height"], 10.8)
        self.assertEqual(normalized["component_relief_regions"][0]["depth"], 20)

    def test_through_false_is_omitted_and_matches_legacy_geometry(self):
        legacy = params(component_relief_regions=[region()])
        explicit_false = params(component_relief_regions=[region(through=False)])
        self.assertEqual(jg._jig_component_params(legacy), jg._jig_component_params(explicit_false))
        result = jg.merge_component_relief(explicit_false, 1)
        self.assertTrue(result["valid"], result)
        self.assertNotIn("through", result["regions"][0])

    def test_through_only_region_opens_full_tray_without_changing_requested_height(self):
        p = params(component_relief_regions=[region(through=True, depth=20)])
        original = copy.deepcopy(p)
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertEqual(len(part.solids()), 1)
        self.assertAlmostEqual(part.bounding_box().max.Z, 12, places=5)
        for z in (0.01, 0.6, 3, 6.3):
            self.assertFalse(inside(part, 0, 0, z))
        self.assertTrue(inside(part, 10, 0, 0.6))
        self.assertTrue(inside(part, 10, 0, 6.3))
        self.assertEqual(p, original)

    def test_through_layout_precedes_blind_depths_and_keeps_cutters_disjoint(self):
        pockets = [region("shallow", x=-3, width=14, height=8, depth=3),
                   region("deep", shape="circle", x=3, width=10, height=10, depth=8),
                   region("through", width=8, height=6, through=True, depth=20)]
        for ordered in (pockets, list(reversed(pockets))):
            with self.subTest(order=[p["id"] for p in ordered]):
                p = params(component_relief_regions=ordered)
                normalized = jg._jig_component_params(p)
                self.assertAlmostEqual(normalized["insert_height"], 10.8)
                footprint, layers = jg._component_relief_layout(normalized)
                self.assertEqual([depth for depth, _ in layers], [None, 8, 3])
                through = jg._component_relief_region_polygon(pockets[2])
                self.assertLess(layers[0][1].symmetric_difference(through).area, 1e-8)
                self.assertLess(unary_union([geometry for _, geometry in layers]).symmetric_difference(footprint).area, 1e-8)
                for index, (_, first) in enumerate(layers):
                    for _, second in layers[index + 1:]:
                        self.assertLess(first.intersection(second).area, 1e-8)
                part = jg.build_insert(p)
                self.assertTrue(part.is_valid)
                self.assertEqual(len(part.solids()), 1)
                self.assertFalse(inside(part, 0, 0, 0.6))
                self.assertFalse(inside(part, 0, 0, 8))  # through beats both floors
                self.assertTrue(inside(part, 6, 0, 1.1))
                self.assertFalse(inside(part, 6, 0, 1.3))
                self.assertTrue(inside(part, -7, 0, 6.1))
                self.assertFalse(inside(part, -7, 0, 6.3))

    def test_through_stl_step_roundtrip_preserves_mixed_floors_and_bottom_mirror(self):
        p = params(jig_print_side="bottom", eject_slot_width=22,
                   component_relief_regions=[polygon_region(through=True, depth=20),
                       region("shallow", x=10, y=-3, width=10, height=4, depth=3),
                       region("deep", shape="circle", x=-10, y=6, width=6, height=6, depth=8)])
        original = copy.deepcopy(p)
        normalized = jg._jig_component_params(p)
        self.assertAlmostEqual(normalized["insert_height"], 10.8)
        self.assertTrue(normalized["component_relief_regions"][0]["through"])
        self.assertEqual(normalized["component_relief_regions"][0]["points"],
                         [[x, -y] for x, y in original["component_relief_regions"][0]["points"]])
        self._assert_roundtrip_floors(p, [
            (0.137, 0.193, None), (8.137, 2.193, None),
            (4.413, -4.293, None), (13.137, 3.193, 6.2),
            (-10.137, -6.193, 1.2), (9.137, -3.193, 9.2),
        ])
        self.assertEqual(p, original)

    def test_through_merge_preserves_saved_depth_and_never_merges_with_blind_mode(self):
        p = params(jig_print_side="bottom", component_relief_regions=[
            region("through-a", x=-5, y=4, width=4, height=4, through=True, depth=2),
            region("through-b", x=-0.5, y=4, width=4, height=4, through=True, depth=9),
            region("blind", x=4, y=4, width=4, height=4, depth=2)])
        original = copy.deepcopy(p)
        result = jg.merge_component_relief(p, 1)
        self.assertTrue(result["valid"], result)
        self.assertEqual((result["merged"], result["skipped"]), (0, 0))
        self.assertEqual(len(result["regions"]), 3)
        self.assertTrue(result["regions"][0]["through"])
        self.assertEqual(result["regions"][0]["depth"], 2)
        self.assertEqual(result["regions"][0]["y"], 4)  # canonical; never mirrored on return
        self.assertTrue(result["regions"][1]["through"])
        self.assertEqual(result["regions"][1]["depth"], 9)
        self.assertNotIn("through", result["regions"][2])
        self.assertEqual(result["regions"][2]["depth"], 2)
        again = jg.merge_component_relief(dict(p, component_relief_regions=result["regions"]), 1)
        self.assertEqual(again["regions"], result["regions"])
        self.assertEqual(p, original)

    def test_same_depth_through_regions_merge_and_remain_idempotent(self):
        pockets = [region("a", x=-3, through=True, depth=8),
                   region("b", x=3.5, through=True, depth=8)]
        p = params(component_relief_regions=pockets)
        result = jg.merge_component_relief(p, 1)
        self.assertTrue(result["valid"], result)
        self.assertEqual((result["merged"], result["skipped"]), (1, 0))
        self.assertTrue(result["regions"][0]["through"])
        self.assertEqual(result["regions"][0]["depth"], 8)
        again = jg.merge_component_relief(dict(p, component_relief_regions=result["regions"]), 1)
        self.assertEqual(again["regions"], result["regions"])

    def test_through_support_checks_still_include_all_regions_and_eject_hole(self):
        p = params(component_relief_regions=[
            region("left", x=-11.5, width=17, height=30, through=True),
            region("right", x=11.5, width=17, height=30, depth=2),
            region("down", y=-9, width=6, height=12, through=True),
            region("up", y=9, width=6, height=12, depth=8)])
        self.assertTrue(jg.validate_component_relief(p)["valid"])
        validation = jg.validate_component_relief(dict(p, eject_slot_width=22))
        self.assertFalse(validation["valid"])
        self.assertIn("没有可承托区域", validation["error"])
        invalid = params(component_relief_regions=[region(width=40, height=30, through=True)])
        self.assertFalse(jg.validate_component_relief(invalid)["valid"])

    def test_through_ring_rejects_floating_tray_island_consistently(self):
        ring = [region("left", x=-1, width=1, height=3, through=True),
                region("right", x=1, width=1, height=3, through=True),
                region("down", y=-1, width=3, height=1, through=True),
                region("up", y=1, width=3, height=1, through=True)]
        p = params(component_relief_regions=ring)
        validation = jg.validate_component_relief(p)
        self.assertFalse(validation["valid"])
        self.assertIn("悬空", validation["error"])
        merged = jg.merge_component_relief(p, 1)
        self.assertFalse(merged["valid"])
        self.assertEqual(merged["regions"], jg._jig_component_params(p)["component_relief_regions"])
        self.assertIn("悬空", merged["error"])

    def test_through_and_blind_ring_keeps_floor_connected_and_valid(self):
        ring = [region("blind-left", x=-1, width=1, height=3, depth=3),
                region("blind-right", x=1, width=1, height=3, depth=3),
                region("blind-down", y=-1, width=3, height=1, depth=3),
                region("blind-up", y=1, width=3, height=1, depth=3)]
        p = params(component_relief_regions=ring + [
            region("through", x=10, width=4, height=4, through=True, depth=20)])
        self.assertTrue(jg.validate_component_relief(p)["valid"])
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertEqual(len(part.solids()), 1)
        self.assertFalse(inside(part, 10, 0, 0.1))
        self.assertTrue(inside(part, 0, 0, 0.1))
        self.assertTrue(inside(part, 0, 0, 3))

    def test_through_flag_and_saved_depth_require_valid_values(self):
        for through in (None, 0, 1, "true", [], {}, float("nan")):
            with self.subTest(through=through):
                p = params(component_relief_regions=[region(through=through)])
                with self.assertRaisesRegex(ValueError, "贯穿开关"):
                    jg._jig_component_params(p)
                self.assertFalse(jg.validate_component_relief(p)["valid"])
                self.assertFalse(jg.merge_component_relief(p)["valid"])
        for depth in (None, 0, 20.01, True, float("inf")):
            with self.subTest(depth=depth):
                p = params(component_relief_regions=[region(through=True, depth=depth)])
                self.assertFalse(jg.validate_component_relief(p)["valid"])

    def test_through_worker_validates_merges_and_exports_before_next_request(self):
        p = params(component_relief_regions=[
            region("a", x=-3, width=6, through=True, depth=3),
            region("b", x=3.5, width=6, through=True, depth=3)])
        with tempfile.TemporaryDirectory(prefix="mason-through-worker-") as directory:
            output = Path(directory) / "through.stl"
            requests = [
                {"id": 1, "cmd": "validate_component_relief", "params": dict(
                    p, component_relief_regions=[region(through=1)])},
                {"id": 2, "cmd": "merge_component_relief", "params": p, "gap": 1},
                {"id": 3, "cmd": "generate", "part": "insert", "params": p,
                 "format": "stl", "output": str(output)},
                {"id": 4, "cmd": "ping"}, {"id": 5, "cmd": "shutdown"},
            ]
            process = subprocess.run([sys.executable, "-B", str(Path(jg.__file__).resolve()), "--server"],
                                     input="\n".join(json.dumps(request) for request in requests) + "\n",
                                     capture_output=True, text=True, encoding="utf-8", timeout=45)
            self.assertEqual(process.returncode, 0, process.stderr)
            responses = [json.loads(line) for line in process.stdout.splitlines() if line.strip()]
            self.assertEqual([response["id"] for response in responses], [1, 2, 3, 4, 5])
            self.assertTrue(all(response["ok"] for response in responses), responses)
            self.assertFalse(responses[0]["validation"]["valid"])
            self.assertEqual(responses[1]["merge"]["merged"], 1)
            self.assertTrue(responses[1]["merge"]["regions"][0]["through"])
            self.assertEqual(responses[1]["merge"]["regions"][0]["depth"], 3)
            self.assertEqual(responses[2]["path"], str(output))
            self.assertGreater(output.stat().st_size, 1000)
            self.assertTrue(responses[3]["pong"])

    def test_merge_overlaps_touches_and_short_gaps_without_shrinking_pockets(self):
        for separation, gap in ((4, 0), (6, 0), (6.5, 1), (7, 1)):
            with self.subTest(separation=separation, gap=gap):
                pockets = [region("left", x=-separation / 2, width=6),
                           region("right", x=separation / 2, width=6)]
                p = params(component_relief_regions=pockets)
                original = copy.deepcopy(p)
                result = jg.merge_component_relief(p, gap)
                self.assertTrue(result["valid"], result)
                self.assertEqual((result["merged"], result["skipped"]), (1, 0))
                self.assertEqual(len(result["regions"]), 1)
                actual = jg._component_relief_region_polygon(result["regions"][0])
                expected = unary_union([jg._component_relief_region_polygon(r) for r in pockets])
                self.assertLess(expected.difference(actual).area, 1e-8)
                self.assertEqual(actual.bounds, expected.bounds)
                self.assertEqual(result["regions"][0]["depth"], 3)
                self.assertEqual(p, original)

    def test_selected_merge_preserves_unselected_neighbours_and_raw_region_fields(self):
        pockets = [region("left", x=-6, width=6), region("middle", width=6),
                   region("neighbour", x=6, width=6, through=False),
                   polygon_region("far", points=[[12, 6], [16, 6], [16, 10], [12, 10]],
                                  x=99, y=88, width=99, height=88)]
        p = params(jig_print_side="bottom", component_relief_regions=pockets)
        original = copy.deepcopy(p)
        result = jg.merge_component_relief(p, 1, ["left", "middle"])
        self.assertTrue(result["valid"], result)
        self.assertEqual(result["merged"], 1)
        self.assertEqual([r["id"] for r in result["regions"]], ["left", "neighbour", "far"])
        self.assertEqual(result["regions"][1:], pockets[2:])
        self.assertNotIn("depth", result["regions"][1])
        self.assertIs(result["regions"][1]["through"], False)
        self.assertEqual(jg._component_relief_region_polygon(result["regions"][0]).bounds,
                         (-9, -3, 3, 3))
        self.assertEqual(p, original)

    def test_selected_merge_connects_distant_regions_while_legacy_keeps_its_gap_limit(self):
        p = params(component_relief_regions=[
            region("a", x=-3, width=6), region("b", x=3.5, width=6),
            region("far", x=14, width=3, through=False)])
        original = copy.deepcopy(p)
        selected = jg.merge_component_relief(p, 1, ["a", "b", "far"])
        self.assertTrue(selected["valid"], selected)
        self.assertEqual(selected["merged"], 2)
        self.assertEqual(len(selected["regions"]), 1)
        self.assertEqual(jg.merge_component_relief(p, 1)["merged"], 1)
        empty = jg.merge_component_relief(p, 1, [])
        self.assertTrue(empty["valid"], empty)
        self.assertEqual(empty["regions"], p["component_relief_regions"])
        self.assertEqual((empty["merged"], empty["skipped"]), (0, 0))
        self.assertEqual(p, original)

    def test_selected_merge_wraps_far_rectangles_and_their_full_gap_in_one_box(self):
        pockets = [region("left", x=-13, y=5, width=4, height=4),
                   region("right", x=13, y=5, width=4, height=4),
                   region("untouched", y=-8, width=5, height=3, depth=7, through=False)]
        p = params(jig_print_side="bottom", component_relief_regions=pockets)
        original = copy.deepcopy(p)
        result = jg.merge_component_relief(p, 1, ["left", "right"])
        self.assertTrue(result["valid"], result)
        self.assertEqual(result["merged"], 1)
        self.assertEqual(result["regions"][1], pockets[2])
        merged = jg._component_relief_region_polygon(result["regions"][0])
        source = unary_union([jg._component_relief_region_polygon(r) for r in pockets[:2]])
        self.assertLess(source.difference(merged).area, 1e-8)
        self.assertEqual(merged.geom_type, "Polygon")
        self.assertFalse(merged.interiors)
        self.assertEqual(result["regions"][0]["shape"], "rect")
        self.assertEqual(merged.bounds, (-15, 3, 15, 7))
        self.assertAlmostEqual(merged.area, 120)
        self.assertTrue(merged.covers(box(-11, 3, 11, 7)))
        self.assertGreater(result["regions"][0]["y"], 0)
        self.assertEqual(p, original)

    def test_selected_merge_wraps_three_far_pockets_in_one_complete_rectangle(self):
        pockets = [region("left", x=-13, y=-8, width=3, height=3),
                   region("top", y=9, width=3, height=3),
                   region("right", x=13, y=-8, width=3, height=3)]
        p = params(component_relief_regions=pockets)
        result = jg.merge_component_relief(p, .8, [r["id"] for r in pockets])
        self.assertTrue(result["valid"], result)
        self.assertEqual(result["merged"], 2)
        merged = jg._component_relief_region_polygon(result["regions"][0])
        source = unary_union([jg._component_relief_region_polygon(r) for r in pockets])
        self.assertLess(source.difference(merged).area, 1e-8)
        self.assertEqual(result["regions"][0]["shape"], "rect")
        self.assertEqual(merged.bounds, (-14.5, -9.5, 14.5, 10.5))
        self.assertTrue(merged.covers(box(-12, -7, 12, 8)))
        self.assertAlmostEqual(merged.area, 29 * 20)

    def test_selected_merge_wraps_far_circles_without_approximating_or_expanding_bounds(self):
        for radius in (3, 10):
            with self.subTest(radius=radius):
                pockets = [region("left", shape="circle", x=-radius * 2, y=4,
                                  width=radius * 2, height=radius * 2),
                           region("right", shape="circle", x=radius * 2, y=4,
                                  width=radius * 2, height=radius * 2)]
                p = params(pcb_size_x=100, pcb_size_y=80, stencil_size_x=130,
                           stencil_size_y=110, jig_size=160, component_relief_regions=pockets)
                result = jg.merge_component_relief(p, 1, ["left", "right"])
                self.assertTrue(result["valid"], result)
                self.assertEqual(result["merged"], 1)
                merged = jg._component_relief_region_polygon(result["regions"][0])
                source = unary_union([jg._component_relief_region_polygon(r) for r in pockets])
                self.assertLess(source.difference(merged).area, 1e-8)
                self.assertEqual(result["regions"][0]["shape"], "rect")
                self.assertEqual(merged.bounds, (-radius * 3, 4 - radius, radius * 3, 4 + radius))
                self.assertTrue(merged.covers(box(-radius, 4 - radius, radius, 4 + radius)))

    def test_selected_merge_uses_actual_polygon_bounds_and_never_reapplies_existing_clearance(self):
        # Automatic proposals already include the requested allowance in their
        # saved dimensions. Neither the compatibility gap nor PCB-slot clearance
        # may expand the enclosing rectangle again.
        pockets = [polygon_region("poly", points=[[-14.6, 2.4], [-10.4, 2.4],
                                                   [-10.4, 6.6], [-12, 4]],
                                  x=99, y=88, width=99, height=88, depth=4),
                   region("right", x=12, y=5, width=7.2, height=5.2, depth=4)]
        expected_bounds = (-14.6, 2.4, 15.6, 7.6)
        for clearance in (0, .2, .6):
            for gap in (0, 1, 5):
                with self.subTest(clearance=clearance, gap=gap):
                    p = params(pcb_pocket_clearance=clearance, component_relief_regions=pockets)
                    original = copy.deepcopy(p)
                    result = jg.merge_component_relief(p, gap, ["poly", "right"])
                    self.assertTrue(result["valid"], result)
                    self.assertEqual(result["merged"], 1)
                    actual = jg._component_relief_region_polygon(result["regions"][0])
                    for value, expected in zip(actual.bounds, expected_bounds):
                        self.assertAlmostEqual(value, expected)
                    self.assertEqual(result["regions"][0]["depth"], 4)
                    self.assertEqual(p, original)

    def test_selected_box_merge_preserves_singletons_of_other_modes_and_depths_exactly(self):
        pockets = [region("left", x=-13, y=4, width=4, height=3),
                   region("deep", y=-6, width=3, height=3, depth=8, through=False),
                   region("right", x=13, y=4, width=4, height=3),
                   region("through", y=-6, x=8, width=3, height=3, through=True),
                   region("unselected", y=-6, x=-8, width=3, height=3, through=False)]
        original = copy.deepcopy(pockets)
        result = jg.merge_component_relief(params(component_relief_regions=pockets), 0,
                                         ["left", "deep", "right", "through"])
        self.assertTrue(result["valid"], result)
        self.assertEqual(result["merged"], 1)
        self.assertEqual([r["id"] for r in result["regions"]], ["left", "deep", "through", "unselected"])
        self.assertEqual(result["regions"][1:], [pockets[1], pockets[3], pockets[4]])
        self.assertEqual(pockets, original)

    def test_selected_box_merge_rejects_whole_board_through_cut_without_partial_fallback(self):
        pockets = [region("lower-left", x=-18, y=-13, width=4, height=4, through=True),
                   region("upper-right", x=18, y=13, width=4, height=4, through=True)]
        p = params(component_relief_regions=pockets)
        original = copy.deepcopy(p)
        self.assertTrue(jg.validate_component_relief(p)["valid"])
        result = jg.merge_component_relief(p, 0, ["lower-left", "upper-right"])
        self.assertFalse(result["valid"], result)
        self.assertEqual(result["merged"], 0)
        self.assertEqual(result["regions"], pockets)
        self.assertIn("覆盖了整块", result["error"])
        self.assertEqual(p, original)

    def test_selected_far_through_merge_preserves_mode_depth_and_is_idempotent(self):
        pockets = [region("left", x=-13, y=4, width=4, height=3, through=True, depth=8),
                   region("right", x=13, y=4, width=4, height=3, through=True, depth=8)]
        p = params(component_relief_regions=pockets)
        result = jg.merge_component_relief(p, 0, ["left", "right"])
        self.assertTrue(result["valid"], result)
        self.assertEqual(result["merged"], 1)
        self.assertTrue(result["regions"][0]["through"])
        self.assertEqual(result["regions"][0]["depth"], 8)
        again = jg.merge_component_relief(dict(p, component_relief_regions=result["regions"]),
                                         0, [result["regions"][0]["id"]])
        self.assertTrue(again["valid"], again)
        self.assertEqual(again["regions"], result["regions"])

    def test_selected_merge_rejects_stale_duplicate_or_malformed_selection(self):
        p = params(component_relief_regions=[region("a", x=-3), region("b", x=3)])
        original = copy.deepcopy(p)
        for selection in (["missing"], ["a", "a"], "a", [True], [None], [1]):
            with self.subTest(selection=selection):
                result = jg.merge_component_relief(p, 1, selection)
                self.assertFalse(result["valid"], result)
                self.assertEqual(result["regions"], original["component_relief_regions"])
                self.assertEqual((result["merged"], result["skipped"]), (0, 0))
                self.assertEqual(p, original)

    def test_selected_merge_respects_saved_depth_and_cut_mode(self):
        pockets = [region("blind", x=-3, width=6, depth=3),
                   region("deep", x=3, width=6, depth=8),
                   region("through", width=6, depth=3, through=True),
                   region("untouched", x=12, width=3)]
        result = jg.merge_component_relief(params(component_relief_regions=pockets), 1,
                                         ["blind", "deep", "through"])
        self.assertTrue(result["valid"], result)
        self.assertEqual(result["merged"], 0)
        self.assertEqual(result["regions"], pockets)

    def test_selected_merge_validates_result_with_unselected_support_cuts(self):
        selected = [region("left", x=-10.25, y=7.5, width=19.5, height=15),
                    region("right", x=10.25, y=7.5, width=19.5, height=15)]
        # This fixed lower cut leaves only the narrow upper bridge supporting
        # the board. It must be included when checking the selected merge.
        untouched = region("lower", y=-7.5, width=40, height=15)
        p = params(component_relief_regions=selected + [untouched])
        self.assertTrue(jg.validate_component_relief(p)["valid"])
        self.assertTrue(jg.merge_component_relief(params(component_relief_regions=selected),
                                                1, ["left", "right"])["valid"])
        result = jg.merge_component_relief(p, 1, ["left", "right"])
        self.assertFalse(result["valid"], result)
        self.assertIn("覆盖了整块", result["error"])
        self.assertEqual(result["regions"], p["component_relief_regions"])

    def test_selected_box_merge_includes_inner_blank_area_and_keeps_unselected_regions(self):
        pockets = [region("left", x=-1, width=1, height=3, depth=3),
                   region("right", x=1, width=1, height=3, depth=3),
                   region("down", y=-1, width=3, height=1, depth=8),
                   region("up", y=1, width=3, height=1, depth=8)]
        result = jg.merge_component_relief(params(component_relief_regions=pockets), 1,
                                         ["left", "right"])
        self.assertTrue(result["valid"], result)
        self.assertEqual(result["merged"], 1)
        self.assertEqual(result["regions"][1:], pockets[2:])
        merged = jg._component_relief_region_polygon(result["regions"][0])
        self.assertEqual(merged.bounds, (-1.5, -1.5, 1.5, 1.5))
        self.assertTrue(merged.covers(box(-.5, -.5, .5, .5)))

    def test_merge_keeps_distant_regions_and_does_not_swell_single_regions(self):
        p = params(component_relief_regions=[polygon_region(),
                   region("far", x=-14, width=4)])
        expected = jg._jig_component_params(p)["component_relief_regions"]
        for gap in (0, 1, 5):
            result = jg.merge_component_relief(p, gap)
            self.assertTrue(result["valid"], result)
            self.assertEqual(result["regions"], expected)
            self.assertEqual((result["merged"], result["skipped"]), (0, 0))
        singleton = params(component_relief_regions=[polygon_region()])
        first = jg.merge_component_relief(singleton, 5)
        again = jg.merge_component_relief(dict(singleton, component_relief_regions=first["regions"]), 5)
        self.assertEqual(first["regions"], again["regions"])

    def test_merge_uses_effective_depth_and_never_enlarges_a_different_depth(self):
        deep = region("deep", x=2, width=4, height=4, depth=8)
        p = params(component_relief_depth=3, component_relief_regions=[
            region("legacy", x=-5, width=4, height=4),
            region("same-depth", x=-0.5, width=4, height=4, depth=3), deep,
        ])
        result = jg.merge_component_relief(p, 1)
        self.assertTrue(result["valid"], result)
        self.assertEqual(result["merged"], 1)
        self.assertEqual([r["depth"] for r in result["regions"]], [3, 8])
        self.assertEqual(result["regions"][1], deep)

    def test_merge_bottom_face_returns_canonical_polygon_and_explicit_depth(self):
        pockets = [region("left", x=-3, y=6, width=6, height=4, depth=7),
                   region("right", x=3.5, y=6, width=6, height=4, depth=7)]
        p = params(jig_print_side="bottom", component_relief_regions=pockets)
        original = copy.deepcopy(p)
        result = jg.merge_component_relief(p, 1)
        self.assertTrue(result["valid"], result)
        merged = result["regions"][0]
        self.assertEqual(merged["y"], 6)
        self.assertEqual(merged["depth"], 7)
        self.assertTrue(all(y >= 4 for _, y in merged["points"]))
        normalized = jg._jig_component_params(dict(p, component_relief_regions=result["regions"]))
        self.assertEqual(normalized["component_relief_regions"][0]["y"], -6)
        self.assertEqual(p, original)

    def test_merge_preserves_support_island_and_continues_other_local_groups(self):
        ring = [region("left", x=-5, width=2, height=12),
                region("right", x=5, width=2, height=12),
                region("down", y=-5, width=12, height=2),
                region("up", y=5, width=12, height=2)]
        p = params(component_relief_regions=ring + [
            region("a", x=12, width=2, height=3),
            region("b", x=15, width=2, height=3)])
        result = jg.merge_component_relief(p, 1)
        self.assertTrue(result["valid"], result)
        self.assertEqual((result["merged"], result["skipped"]), (3, 1))
        self.assertEqual(len(result["regions"]), 3)
        relief = unary_union([jg._component_relief_region_polygon(r) for r in result["regions"]])
        self.assertLess(relief.intersection(box(-4, -4, 4, 4)).area, 1e-8)
        self.assertLess(unary_union([jg._component_relief_region_polygon(r) for r in ring]).difference(relief).area, 1e-8)
        self.assertTrue(all(not jg._component_relief_region_polygon(r).interiors for r in result["regions"]))

    def test_merge_preserves_small_existing_hole_instead_of_closing_it_away(self):
        pockets = [region("left", x=-1, width=1, height=3),
                   region("right", x=1, width=1, height=3),
                   region("down", y=-1, width=3, height=1),
                   region("up", y=1, width=3, height=1)]
        result = jg.merge_component_relief(params(component_relief_regions=pockets), 5)
        self.assertTrue(result["valid"], result)
        self.assertEqual((result["merged"], result["skipped"]), (2, 1))
        self.assertEqual(len(result["regions"]), 2)
        relief = unary_union([jg._component_relief_region_polygon(r) for r in result["regions"]])
        self.assertLess(relief.intersection(box(-0.5, -0.5, 0.5, 0.5)).area, 1e-8)
        again = jg.merge_component_relief(params(component_relief_regions=result["regions"]), 5)
        self.assertEqual(result["regions"], again["regions"])

    def test_merge_preserves_support_island_surrounded_by_different_depths(self):
        pockets = [region("left", x=-1, width=1, height=3, depth=3),
                   region("right", x=1, width=1, height=3, depth=3),
                   region("down", y=-1, width=3, height=1, depth=8),
                   region("up", y=1, width=3, height=1, depth=8)]
        result = jg.merge_component_relief(params(component_relief_regions=pockets), 1)
        self.assertTrue(result["valid"], result)
        self.assertEqual((result["merged"], result["skipped"]), (0, 4))
        self.assertEqual(result["regions"], pockets)

    def test_merge_preserves_regions_when_exterior_exceeds_vertex_limit(self):
        pockets = [polygon_region(name, points=[
            [cx + 3.5 * math.cos(i * 2 * math.pi / 128),
             3.5 * math.sin(i * 2 * math.pi / 128)] for i in range(128)])
            for name, cx in (("left", -4), ("right", 4))]
        p = params(component_relief_regions=pockets)
        result = jg.merge_component_relief(p, 1)
        self.assertTrue(result["valid"], result)
        self.assertEqual((result["merged"], result["skipped"]), (0, 2))
        self.assertEqual(result["regions"], jg._jig_component_params(p)["component_relief_regions"])

    def test_merge_can_reduce_a_subgroup_when_whole_group_exceeds_vertex_limit(self):
        pockets = [polygon_region(name, points=[
            [cx + 3.5 * math.cos(i * 2 * math.pi / 128),
             3.5 * math.sin(i * 2 * math.pi / 128)] for i in range(128)])
            for name, cx in (("left", -4), ("right", 4))]
        pockets.append(region("inside-right", x=4, width=3, height=3))
        p = params(component_relief_regions=pockets)
        result = jg.merge_component_relief(p, 1)
        self.assertTrue(result["valid"], result)
        self.assertEqual((result["merged"], result["skipped"]), (1, 1))
        self.assertEqual(len(result["regions"]), 2)
        self.assertEqual(result["regions"][0], jg._jig_component_params(p)["component_relief_regions"][0])
        original = unary_union([jg._component_relief_region_polygon(r) for r in pockets])
        actual = unary_union([jg._component_relief_region_polygon(r) for r in result["regions"]])
        self.assertLess(original.symmetric_difference(actual).area, 1e-8)

    def test_merge_rejects_whole_board_support_loss_and_returns_original_draft(self):
        pockets = [region("left", x=-10.25, width=19.5, height=30),
                   region("right", x=10.25, width=19.5, height=30)]
        p = params(component_relief_regions=pockets)
        self.assertTrue(jg.validate_component_relief(p)["valid"])
        result = jg.merge_component_relief(p, 1)
        self.assertFalse(result["valid"])
        self.assertIn("覆盖了整块", result["error"])
        self.assertEqual((result["merged"], result["skipped"]), (0, 0))
        self.assertEqual(result["regions"], jg._jig_component_params(p)["component_relief_regions"])

    def test_merge_is_idempotent_and_builds_no_cad(self):
        p = params(component_relief_regions=[
            region("a", x=-7, y=-2, width=4, height=4),
            region("b", x=-2.5, y=-2, width=4, height=4),
            region("c", x=2, y=-2, width=4, height=4),
            region("far", x=12, y=7, width=3, height=3)])
        with patch.object(jg, "build_insert", side_effect=AssertionError("merge built CAD")), \
                patch.object(jg, "_ocp_prisms", side_effect=AssertionError("merge extruded a pocket")):
            first = jg.merge_component_relief(p, 1)
            again = jg.merge_component_relief(dict(p, component_relief_regions=first["regions"]), 1)
        self.assertTrue(first["valid"], first)
        self.assertEqual(first["merged"], 2)
        self.assertEqual(again["merged"], 0)
        self.assertEqual(first["regions"], again["regions"])

    def test_merge_validates_gap_and_invalid_polygon_without_mutating_input(self):
        for gap in (-1, 5.01, True, "1", float("nan"), float("inf")):
            p = params()
            original = copy.deepcopy(p)
            result = jg.merge_component_relief(p, gap)
            self.assertFalse(result["valid"], result)
            self.assertIn("合并间距", result["error"])
            self.assertEqual(p, original)
        p = params(component_relief_regions=[
            polygon_region(points=[[0, 0], [4, 4], [0, 4], [4, 0]])])
        result = jg.merge_component_relief(p, 1)
        self.assertFalse(result["valid"])
        self.assertIn("不能自交", result["error"])
        self.assertEqual(result["regions"], p["component_relief_regions"])

    def test_merge_disabled_plan_still_checks_side_and_complete_support(self):
        p = params(component_relief_enabled=False, jig_print_side="sideways")
        result = jg.merge_component_relief(p, 1)
        self.assertFalse(result["valid"])
        self.assertIn("刷锡面", result["error"])
        p = params(component_relief_enabled=False, component_relief_regions=[
            region("left", x=-10.25, width=19.5, height=30),
            region("right", x=10.25, width=19.5, height=30)])
        result = jg.merge_component_relief(p, 1)
        self.assertFalse(result["valid"])
        self.assertIn("覆盖了整块", result["error"])

    def test_merge_server_returns_result_and_survives_rejected_request(self):
        pockets = [region("a", x=-3, width=6), region("b", x=3.5, width=6)]
        p = params(jig_print_side="bottom", component_relief_regions=pockets)
        requests = [
            {"id": 1, "cmd": "merge_component_relief", "params": p, "gap": -1},
            {"id": 2, "cmd": "merge_component_relief", "params": p, "gap": 1},
            {"id": 3, "cmd": "ping"}, {"id": 4, "cmd": "shutdown"},
        ]
        process = subprocess.run([sys.executable, "-B", str(Path(jg.__file__).resolve()), "--server"],
                                 input="\n".join(json.dumps(request) for request in requests) + "\n",
                                 capture_output=True, text=True, encoding="utf-8", timeout=45)
        self.assertEqual(process.returncode, 0, process.stderr)
        responses = [json.loads(line) for line in process.stdout.splitlines() if line.strip()]
        self.assertEqual([response["id"] for response in responses], [1, 2, 3, 4])
        self.assertTrue(all(response["ok"] for response in responses))
        self.assertFalse(responses[0]["merge"]["valid"])
        self.assertTrue(responses[1]["merge"]["valid"])
        self.assertEqual(responses[1]["merge"]["merged"], 1)
        self.assertEqual(responses[1]["merge"]["regions"][0]["depth"], 3)
        self.assertTrue(responses[2]["pong"])

    def test_merge_worker_forwards_selected_ids_and_retains_unselected_regions(self):
        pockets = [region("a", x=-6, width=6), region("b", width=6),
                   region("c", x=6, width=6, through=False)]
        p = params(component_relief_regions=pockets)
        requests = [
            {"id": 1, "cmd": "merge_component_relief", "params": p, "gap": 1,
             "selected_ids": ["a", "b"]},
            {"id": 2, "cmd": "merge_component_relief", "params": p, "gap": 1,
             "selected_ids": []},
            {"id": 3, "cmd": "merge_component_relief", "params": p, "gap": 1,
             "selected_ids": ["missing"]},
            {"id": 4, "cmd": "ping"}, {"id": 5, "cmd": "shutdown"},
        ]
        process = subprocess.run([sys.executable, "-B", str(Path(jg.__file__).resolve()), "--server"],
                                 input="\n".join(json.dumps(request) for request in requests) + "\n",
                                 capture_output=True, text=True, encoding="utf-8", timeout=45)
        self.assertEqual(process.returncode, 0, process.stderr)
        responses = [json.loads(line) for line in process.stdout.splitlines() if line.strip()]
        self.assertEqual([r["id"] for r in responses], [1, 2, 3, 4, 5])
        self.assertTrue(all(r["ok"] for r in responses))
        self.assertEqual(responses[0]["merge"]["merged"], 1)
        self.assertEqual(responses[0]["merge"]["regions"][-1], pockets[-1])
        self.assertEqual(responses[1]["merge"]["regions"], pockets)
        self.assertFalse(responses[2]["merge"]["valid"])
        self.assertTrue(responses[3]["pong"])

    def test_independent_depths_ignore_new_region_default_and_set_tray_height(self):
        p = params(component_relief_depth=20, component_relief_regions=[
            region("shallow", x=-10, width=6, depth=3),
            region("deep", shape="circle", x=10, width=6, height=6, depth=8),
        ])
        original = copy.deepcopy(p)
        normalized = jg._jig_component_params(p)
        self.assertAlmostEqual(normalized["insert_height"], 10.8)
        self.assertEqual([r["depth"] for r in normalized["component_relief_regions"]], [3, 8])
        part = jg.build_insert(p)
        self.assertEqual(p, original)
        self.assertTrue(part.is_valid)
        self.assertEqual(len(part.solids()), 1)
        self.assertTrue(inside(part, -10, 0, 6.1))
        self.assertFalse(inside(part, -10, 0, 6.3))
        self.assertTrue(inside(part, 10, 0, 1.1))
        self.assertFalse(inside(part, 10, 0, 1.3))
        self.assertTrue(inside(part, 0, 10, 9.1))  # PCB datum remains 9.2
        self.assertAlmostEqual(part.bounding_box().max.Z, 14.8, places=5)

    def test_overlapping_regions_use_deepest_floor_independent_of_order(self):
        pockets = [region("shallow", x=-3, width=14, height=8, depth=3),
                   region("deep", shape="circle", x=3, width=10, height=10, depth=8)]
        volumes = []
        for ordered in (pockets, list(reversed(pockets))):
            with self.subTest(order=[p["id"] for p in ordered]):
                p = params(component_relief_regions=ordered)
                part = jg.build_insert(p)
                self.assertTrue(part.is_valid)
                self.assertEqual(len(part.solids()), 1)
                self.assertTrue(inside(part, -7, 0, 6.1))
                self.assertFalse(inside(part, -7, 0, 6.3))
                self.assertTrue(inside(part, 0.5, 0, 1.1))
                self.assertFalse(inside(part, 0.5, 0, 1.3))  # shared region is deep
                self.assertFalse(inside(part, 6, 0, 1.3))
                volumes.append(part.volume)
        self.assertAlmostEqual(volumes[0], volumes[1], places=5)

    def test_legacy_missing_depth_uses_global_and_explicit_depth_stays_fixed(self):
        legacy = params(component_relief_depth=7, component_relief_regions=[region()])
        explicit = params(component_relief_depth=20, component_relief_regions=[region(depth=7)])
        old_part, new_part = jg.build_insert(legacy), jg.build_insert(explicit)
        self.assertAlmostEqual(old_part.volume, new_part.volume, places=5)
        self.assertEqual(jg._jig_component_params(legacy)["component_relief_regions"][0]["depth"], 7)
        changed_default = dict(explicit, component_relief_depth=0.5)
        self.assertAlmostEqual(jg.build_insert(changed_default).volume, new_part.volume, places=5)
        mixed = params(component_relief_depth=6, component_relief_regions=[region(depth=2), region("legacy", x=10)])
        self.assertAlmostEqual(jg._jig_component_params(mixed)["insert_height"], 8.8)

    def test_invalid_region_depths_are_rejected_by_generation_and_preflight(self):
        for invalid in (None, True, False, "3", float("nan"), float("inf"), -1, 0.49, 20.01):
            for pocket in (region(depth=invalid), polygon_region(depth=invalid)):
                with self.subTest(depth=invalid, shape=pocket["shape"]):
                    p = params(component_relief_regions=[pocket])
                    with self.assertRaisesRegex(ValueError, "区域的深度"):
                        jg._jig_component_params(p)
                    validation = jg.validate_component_relief(p)
                    self.assertFalse(validation["valid"])
                    self.assertIn("区域的深度", validation["error"])
        for boundary in (0.5, 20):
            self.assertTrue(jg.validate_component_relief(params(component_relief_regions=[region(depth=boundary)]))["valid"])

    def test_bottom_print_mirrors_independent_depths_without_reassigning_them(self):
        p = params(jig_print_side="bottom", component_relief_regions=[
            polygon_region(depth=8), region("shallow", x=-10, y=6, width=6, height=4, depth=2),
        ])
        original = copy.deepcopy(p)
        normalized = jg._jig_component_params(p)
        self.assertEqual([r["depth"] for r in normalized["component_relief_regions"]], [8, 2])
        self.assertEqual(jg._jig_component_params(normalized), normalized)
        part = jg.build_insert(p)
        self.assertEqual(p, original)
        self.assertFalse(inside(part, 8, 2, 1.3))
        self.assertTrue(inside(part, -10, -6, 7.1))
        self.assertFalse(inside(part, -10, -6, 7.3))
        self.assertTrue(inside(part, -10, 6, 8.5))
        self.assertTrue(inside(part, 9, -3, 9.1))  # concave corner still supports

    def test_independent_depth_stl_step_roundtrip_preserves_overlap_and_bottom_view(self):
        p = params(jig_print_side="bottom", component_relief_depth=18, eject_slot_width=22,
                   component_relief_regions=[polygon_region(depth=8),
                       region("shallow", x=10, y=-3, width=10, height=4, depth=3)])
        self._assert_roundtrip_floors(p, [
            (0.137, 0.193, None), (8.137, 2.193, 1.2),  # deep overlap + through hole
            (13.137, 3.193, 6.2),  # shallow-only area
            (4.413, -4.293, 1.2), (9.137, -3.193, 9.2),  # polygon notch supports
        ])

    def test_preflight_accepts_empty_and_disabled_plans_without_changing_inputs(self):
        for p in (params(component_relief_regions=[]), dict(BASE, component_relief_enabled=False)):
            original = copy.deepcopy(p)
            self.assertEqual(jg.validate_component_relief(p), {"valid": True})
            self.assertEqual(p, original)

    def test_preflight_accepts_polygon_and_builds_no_cad(self):
        p = params(jig_print_side="bottom", component_relief_depth=10,
                   component_relief_regions=[polygon_region()])
        original = copy.deepcopy(p)
        with patch.object(jg, "build_insert", side_effect=AssertionError("preflight built CAD")), \
                patch.object(jg, "poly_solid", side_effect=AssertionError("preflight built a solid")), \
                patch.object(jg, "_ocp_prisms", side_effect=AssertionError("preflight extruded a pocket")):
            self.assertEqual(jg.validate_component_relief(p), {"valid": True})
        self.assertEqual(p, original)

    def test_preflight_reports_whole_board_support_loss_and_invalid_polygon(self):
        for pocket, expected in (
            (polygon_region(points=[[-20, -15], [20, -15], [20, 15], [-20, 15]]), "覆盖了整块"),
            (polygon_region(points=[[0, 0], [4, 4], [0, 4], [4, 0]]), "不能自交"),
        ):
            with self.subTest(expected=expected):
                p = params(component_relief_regions=[pocket])
                original = copy.deepcopy(p)
                validation = jg.validate_component_relief(p)
                self.assertFalse(validation["valid"])
                self.assertIn(expected, validation["error"])
                self.assertEqual(p, original)

    def test_preflight_uses_eject_hole_when_validating_support(self):
        p = params(component_relief_regions=[
            region("left", x=-11.5, width=17, height=30),
            region("right", x=11.5, width=17, height=30),
            region("down", y=-9, width=6, height=12),
            region("up", y=9, width=6, height=12),
        ])
        self.assertEqual(jg.validate_component_relief(p), {"valid": True})
        opened = dict(p, eject_slot_width=22)
        original = copy.deepcopy(opened)
        validation = jg.validate_component_relief(opened)
        self.assertFalse(validation["valid"])
        self.assertIn("没有可承托区域", validation["error"])
        self.assertEqual(opened, original)

    def test_takeout_notches_cannot_remove_the_last_pcb_support_on_any_side(self):
        plans = {
            "down": [region("left", x=-12.5, width=15, height=30),
                     region("right", x=12.5, width=15, height=30),
                     region("middle", y=1, width=10, height=28)],
            "up": [region("left", x=-12.5, width=15, height=30),
                   region("right", x=12.5, width=15, height=30),
                   region("middle", y=-1, width=10, height=28)],
            "left": [region("down", y=-10, width=40, height=10),
                     region("up", y=10, width=40, height=10),
                     region("middle", x=1, width=38, height=10)],
            "right": [region("down", y=-10, width=40, height=10),
                      region("up", y=10, width=40, height=10),
                      region("middle", x=-1, width=38, height=10)],
        }
        for side, pockets in plans.items():
            for print_side in ("top", "bottom"):
                with self.subTest(side=side, print_side=print_side):
                    canonical = copy.deepcopy(pockets)
                    if print_side == "bottom":
                        for pocket in canonical:
                            pocket["y"] = -pocket["y"]
                    p = params(pry_notch_sides=[side], jig_print_side=print_side,
                               component_relief_regions=canonical)
                    original = copy.deepcopy(p)
                    validation = jg.validate_component_relief(p)
                    self.assertFalse(validation["valid"])
                    self.assertIn("取放缺口", validation["error"])
                    with self.assertRaisesRegex(ValueError, "没有可承托区域"):
                        jg.build_insert(p)
                    self.assertFalse(jg.merge_component_relief(p, selected_ids=[])["valid"])
                    self.assertEqual(p, original)
                    # Turning off only the offending notch restores a usable plan.
                    self.assertEqual(jg.validate_component_relief(dict(p, pry_notch_sides=[])),
                                     {"valid": True})

    def test_takeout_notch_retains_real_support_away_from_its_cut(self):
        p = params(pry_notch_sides=["down"], component_relief_regions=[
            region("middle", y=1, width=40, height=28)])
        self.assertEqual(jg.validate_component_relief(p), {"valid": True})
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertEqual(len(part.solids()), 1)
        self.assertFalse(inside(part, 0, -14, 6.399))
        self.assertTrue(inside(part, 12, -14, 6.399))
        self.assertFalse(inside(part, 12, 0, 6.399))

    def test_takeout_notch_above_thick_pcb_datum_does_not_remove_support(self):
        p = params(pcb_thickness=3.5, pry_notch_sides=["down"], component_relief_regions=[
            region("left", x=-12.5, width=15, height=30),
            region("right", x=12.5, width=15, height=30),
            region("middle", y=1, width=10, height=28)])
        self.assertEqual(jg.validate_component_relief(p), {"valid": True})
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertEqual(len(part.solids()), 1)
        self.assertTrue(inside(part, 0, -14, 4.499))
        self.assertFalse(inside(part, 0, 0, 4.499))

    def test_preflight_server_keeps_worker_alive_after_invalid_plan(self):
        invalid = params(component_relief_regions=[
            polygon_region(points=[[-20, -15], [20, -15], [20, 15], [-20, 15]]),
        ])
        requests = [
            {"id": 1, "cmd": "validate_component_relief", "params": invalid},
            {"id": 2, "cmd": "validate_component_relief", "params": params(component_relief_regions=[polygon_region()])},
            {"id": 3, "cmd": "ping"}, {"id": 4, "cmd": "shutdown"},
        ]
        process = subprocess.run([sys.executable, "-B", str(Path(jg.__file__).resolve()), "--server"],
                                 input="\n".join(json.dumps(request) for request in requests) + "\n",
                                 capture_output=True, text=True, encoding="utf-8", timeout=45)
        self.assertEqual(process.returncode, 0, process.stderr)
        responses = [json.loads(line) for line in process.stdout.splitlines() if line.strip()]
        self.assertEqual([response["id"] for response in responses], [1, 2, 3, 4])
        self.assertTrue(all(response["ok"] for response in responses))
        self.assertFalse(responses[0]["validation"]["valid"])
        self.assertIn("覆盖了整块", responses[0]["validation"]["error"])
        self.assertEqual(responses[1]["validation"], {"valid": True})
        self.assertTrue(responses[2]["pong"])

    def test_concave_polygon_cuts_its_shape_and_derives_bbox(self):
        pocket = polygon_region(x=100, y=-100, width=1, height=1)
        p = params(component_relief_regions=[pocket])
        original = copy.deepcopy(p)
        normalized = jg._jig_component_params(p)
        actual = normalized["component_relief_regions"][0]
        self.assertEqual([actual[key] for key in ("x", "y", "width", "height")], [7, 0.5, 10, 9])
        relief = jg._component_relief_geometry(normalized)
        self.assertAlmostEqual(relief.area, 60)
        self.assertLess(relief.symmetric_difference(Polygon(pocket["points"])).area, 1e-8)
        part = jg.build_insert(p)
        self.assertEqual(p, original)
        self.assertTrue(part.is_valid)
        self.assertFalse(inside(part, 4, 3, 5))
        self.assertFalse(inside(part, 9, -2, 5))
        self.assertTrue(inside(part, 9, 3, 6))  # concave corner stays a support
        self.assertTrue(inside(part, 4, 3, 3))

    def test_polygon_bottom_view_mirrors_vertices_and_bbox_once(self):
        vertices = [[-14, 3], [-4, 3], [-4, 6], [-9, 6], [-9, 10], [-14, 10]]
        p = params(jig_print_side="bottom", component_relief_regions=[polygon_region(points=vertices)])
        original = copy.deepcopy(p)
        normalized = jg._jig_component_params(p)
        pocket = normalized["component_relief_regions"][0]
        self.assertEqual(pocket["points"], [[x, -y] for x, y in vertices])
        self.assertEqual([pocket[key] for key in ("x", "y", "width", "height")], [-9, -6.5, 10, 7])
        self.assertEqual(jg._jig_component_params(normalized), normalized)
        part = jg.build_insert(p)
        self.assertEqual(p, original)
        self.assertFalse(inside(part, -12, -8, 5))
        self.assertTrue(inside(part, -6, -8, 6))  # preserved concave corner
        self.assertTrue(inside(part, -12, 8, 6))  # no second mirrored pocket

    def test_polygon_merges_with_legacy_shapes_and_clips_board_holes(self):
        pocket = polygon_region()
        hole = [[7, -3], [9, -3], [9, -1], [7, -1]]
        p = params(pcb_outline_holes=[hole], component_relief_regions=[
            pocket, region("rect", x=18, width=8),
            region("circle", shape="circle", x=12, y=1, width=6, height=6),
        ])
        relief = jg._component_relief_geometry(jg._jig_component_params(p))
        expected = (Polygon(pocket["points"]).union(box(14, -3, 22, 3))
                    .union(Point(12, 1).buffer(3, resolution=24))
                    .intersection(box(-20, -15, 20, 15).difference(Polygon(hole))))
        self.assertLess(relief.symmetric_difference(expected).area, 1e-8)
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertFalse(inside(part, 8, -2, 0.6))  # internal PCB hole stays through
        self.assertFalse(inside(part, 19.5, 0, 5))
        self.assertTrue(inside(part, 20.1, 0, 5))  # outside locating wall intact
        self.assertTrue(inside(part, 8, 4, 6))  # not erased by polygon bbox

    def test_polygon_deep_relief_preserves_eject_hole_floor_and_support(self):
        p = params(component_relief_depth=10, eject_slot_width=22,
                   component_relief_regions=[polygon_region()])
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertEqual(len(part.solids()), 1)
        self.assertFalse(inside(part, 0, 0, 0.6))
        self.assertFalse(inside(part, 4, 0, 4))  # polygon and circular hole connect
        self.assertTrue(inside(part, 8, -2, 1.1))
        self.assertFalse(inside(part, 8, -2, 1.3))
        self.assertTrue(inside(part, 9, 3, 11))
        self.assertAlmostEqual(part.bounding_box().max.Z, 16.8, places=5)

    def test_polygon_rejects_invalid_counts_vertices_and_topology(self):
        too_many = [[math.cos(i * 2 * math.pi / 129), math.sin(i * 2 * math.pi / 129)]
                    for i in range(129)]
        invalid = [
            None, [], [[0, 0], [1, 1]], too_many,
            [[0, 0], [1, 0], [0, float("nan")]],
            [[0, 0], [1, 0], [0, float("inf")]],
            [[0, 0], [1, 0], [0, 601]],
            [[0, 0], [1, 0], [True, 1]],
            [[0, 0], [1, 0], ["0", 1]],
            [[0, 0], [1], [0, 1]],
            [[0, 0], [1, 0, 2], [0, 1]],
            [[0, 0], [1, 0], [2, 0]],  # zero area
            [[0, 0], [4, 4], [0, 4], [4, 0]],  # self crossing
            [[0, 0], [5, 0], [0, 5], [4, 5], [1, 0]],  # crossing, nonzero signed area
            [[0, 0], [4, 0], [4, 4], [4, 0], [0, 4]],  # repeated edge
            [[0, 0], [4, 0], [4, 0], [0, 4]],
            [[0, 0], [4, 0], [0, 4], [0, 0]],  # duplicate closing vertex
            [[0, 0], [1e-8, 0], [0, 1]],  # degenerate edge
            [[0, 0], [1e-4, 0], [0, 1e-4]],  # negligible area
        ]
        for points in invalid:
            with self.subTest(points=points), self.assertRaises(ValueError):
                jg._jig_component_params(params(component_relief_regions=[
                    dict(polygon_region(), points=points),
                ]))

    def test_polygon_accepts_128_vertices_and_both_windings(self):
        vertices = [[10 * math.cos(i * 2 * math.pi / 128),
                     10 * math.sin(i * 2 * math.pi / 128)] for i in range(128)]
        for points in (vertices, list(reversed(vertices))):
            normalized = jg._jig_component_params(params(component_relief_regions=[
                polygon_region(points=points),
            ]))
            relief = jg._component_relief_geometry(normalized)
            self.assertAlmostEqual(relief.area, Polygon(vertices).area)

    def test_polygon_support_check_includes_legacy_eject_hole(self):
        pockets = [polygon_region(str(i), points=vertices) for i, vertices in enumerate([
            [[-20, -15], [-3, -15], [-3, 15], [-20, 15]],
            [[3, -15], [20, -15], [20, 15], [3, 15]],
            [[-3, -15], [3, -15], [3, -3], [-3, -3]],
            [[-3, 3], [3, 3], [3, 15], [-3, 15]],
        ])]
        p = jg._jig_component_params(params(component_relief_regions=pockets))
        relief = jg._component_relief_geometry(p)
        self.assertAlmostEqual(box(-20, -15, 20, 15).difference(relief).area, 36)
        eject = jg._eject_hole_geometry(jg.get_polys(p)[0], 22)
        with self.assertRaisesRegex(ValueError, "没有可承托区域"):
            jg._component_relief_geometry(p, eject)
        with self.assertRaisesRegex(ValueError, "覆盖了整块"):
            jg._component_relief_geometry(jg._jig_component_params(params(component_relief_regions=[
                polygon_region(points=[[-20, -15], [20, -15], [20, 15], [-20, 15]]),
            ])))

    def test_polygon_stl_and_step_roundtrip_preserve_concavity_and_1_2_mm_floor(self):
        p = params(component_relief_depth=10, eject_slot_width=22,
                   component_relief_regions=[polygon_region()])
        self._assert_roundtrip_floors(p, [
            (0.137, 0.193, None), (8.137, -2.193, 1.2),
            (4.413, 4.293, 1.2), (9.137, 3.193, 11.2),
        ])

    def _assert_roundtrip_floors(self, p, probes):
        from OCP.BRepCheck import BRepCheck_Analyzer
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector
        from OCP.STEPControl import STEPControl_Reader
        from OCP.StlAPI import StlAPI_Reader
        from OCP.TopoDS import TopoDS_Shape
        from OCP.gp import gp_Dir, gp_Lin

        def unique(heights):
            result = []
            for value in sorted(heights):
                if not result or abs(value - result[-1]) > 1e-5:
                    result.append(value)
            return result

        with tempfile.TemporaryDirectory(prefix="mason-polygon-relief-") as directory:
            for fmt in ("stl", "step"):
                with self.subTest(format=fmt):
                    path = Path(directory) / ("polygon-tray." + fmt)
                    jg.generate_to_file(copy.deepcopy(p), "insert", path, fmt)
                    self.assertGreater(path.stat().st_size, 1000)
                    if fmt == "stl":
                        shape = TopoDS_Shape()
                        self.assertTrue(StlAPI_Reader().Read(shape, str(path)))
                        raw = path.read_bytes()
                        count = struct.unpack_from("<I", raw, 80)[0]
                        triangles = [struct.unpack_from("<9f", raw, 84 + i * 50 + 12)
                                     for i in range(count)]

                        def vertical_hits(x, board_y):
                            hits = []
                            for triangle in triangles:
                                ax, ay, az, bx, by, bz, cx, cy, cz = triangle
                                determinant = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
                                if abs(determinant) < 1e-12:
                                    continue
                                u = ((x - ax) * (cz - az) - (-board_y - az) * (cx - ax)) / determinant
                                v = ((-board_y - az) * (bx - ax) - (x - ax) * (bz - az)) / determinant
                                if u >= -1e-9 and v >= -1e-9 and u + v <= 1 + 1e-9:
                                    hits.append(ay + u * (by - ay) + v * (cy - ay))
                            return unique(hits)
                    else:
                        reader = STEPControl_Reader()
                        self.assertEqual(reader.ReadFile(str(path)), IFSelect_RetDone)
                        self.assertGreater(reader.TransferRoots(), 0)
                        shape = reader.OneShape()
                        intersector = IntCurvesFace_ShapeIntersector()
                        intersector.Load(shape, 1e-7)

                        def vertical_hits(x, board_y):
                            intersector.Perform(gp_Lin(gp_Pnt(x, -10, -board_y), gp_Dir(0, 1, 0)), 0, 100)
                            return unique([intersector.Pnt(i).Y() for i in range(1, intersector.NbPnt() + 1)])

                    self.assertTrue(BRepCheck_Analyzer(shape).IsValid())
                    for x, y, expected_top in probes:
                        observed = vertical_hits(x, y)
                        if expected_top is None:
                            self.assertEqual(observed, [])
                            continue
                        self.assertEqual(len(observed), 2, observed)
                        self.assertAlmostEqual(observed[0], 0, places=4)
                        self.assertAlmostEqual(observed[1], expected_top, places=4)

    def test_rectangular_pocket_preserves_support_and_closed_floor(self):
        p = params(eject_slot_width=0)
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertEqual(len(part.solids()), 1)
        self.assertFalse(inside(part, 0, 0, 5))
        self.assertTrue(inside(part, 0, 0, 3))
        self.assertTrue(inside(part, 10, 0, 6))
        self.assertFalse(inside(part, 10, 0, 7))  # PCB still sits at z=6.4
        self.assertTrue(inside(part, 0, 0, 0.6))  # no central eject hole

    def test_overlapping_eject_hole_stays_through_and_connects_to_relief(self):
        p = params(eject_slot_width=22, component_relief_regions=[region(x=6)])
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertEqual(len(part.solids()), 1)
        self.assertFalse(inside(part, 0, 0, 0.6))  # original round through hole
        self.assertFalse(inside(part, 4, 0, 4))  # connected hole and pocket
        self.assertFalse(inside(part, 8, 0, 5))
        self.assertTrue(inside(part, 8, 0, 3))  # pocket floor outside the hole
        self.assertTrue(inside(part, 15, 0, 6))  # bare PCB still supported

    def test_separate_eject_hole_and_relief_keep_independent_floors(self):
        p = params(eject_slot_width=22, component_relief_regions=[
            region(x=13, y=7, width=6, height=4),
        ])
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertFalse(inside(part, 0, 0, 0.6))
        self.assertFalse(inside(part, 13, 7, 5))
        self.assertTrue(inside(part, 13, 7, 3))
        self.assertTrue(inside(part, 10, 0, 6))

    def test_deep_relief_keeps_1_2_mm_floor_outside_eject_hole(self):
        p = params(eject_slot_width=22, component_relief_depth=10,
                   component_relief_regions=[region(x=6)])
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertEqual(len(part.solids()), 1)
        self.assertFalse(inside(part, 0, 0, 0.6))
        self.assertTrue(inside(part, 8, 0, 1.1))
        self.assertFalse(inside(part, 8, 0, 1.3))
        self.assertTrue(inside(part, 15, 0, 11))
        self.assertFalse(inside(part, 15, 0, 11.3))  # unchanged PCB thickness
        self.assertAlmostEqual(part.bounding_box().max.Z, 16.8, places=5)

    def test_manual_eject_diameter_changes_real_hole_without_changing_legacy_auto(self):
        p = params(eject_slot_width=22, component_relief_regions=[])
        original = copy.deepcopy(p)
        legacy = jg.build_insert(copy.deepcopy(p))
        automatic = jg.build_insert(dict(p, eject_hole_diameter=0))
        self.assertAlmostEqual(legacy.volume, automatic.volume, places=5)
        slot = jg.get_polys(copy.deepcopy(p))[0]
        self.assertLess(jg._eject_hole_geometry(slot, 22).symmetric_difference(
            jg._eject_hole_geometry(slot, 22, 0)).area, 1e-10)
        small = jg.build_insert(dict(p, eject_hole_diameter=12))
        large = jg.build_insert(dict(p, eject_hole_diameter=20))
        for part in (small, large):
            self.assertTrue(part.is_valid)
            self.assertEqual(len(part.solids()), 1)
            self.assertFalse(inside(part, 0, 0, 0.6))
            self.assertTrue(inside(part, 11, 0, 0.6))
        self.assertTrue(inside(small, 8, 0, 0.6))
        self.assertFalse(inside(large, 8, 0, 0.6))
        expected_volume = (jg._eject_hole_geometry(slot, 22, 20).area
                           - jg._eject_hole_geometry(slot, 22, 12).area) * 6.4
        self.assertAlmostEqual(small.volume - large.volume, expected_volume, places=4)
        self.assertEqual(p, original)

    def test_manual_eject_diameter_is_clamped_and_can_open_small_boards(self):
        for width, height, requested, expected in ((40, 30, 40, 26.4),
                                                    (20, 18, 6, 6),
                                                    (8, 8, 40, 4.4),
                                                    (6, 6, 4, 0)):
            with self.subTest(width=width, requested=requested):
                slot = jg.get_polys(dict(BASE, pcb_size_x=width, pcb_size_y=height))[0]
                self.assertAlmostEqual(jg._eject_hole_diameter(slot, requested), expected)
                actual = jg._eject_hole_geometry(slot, 22, requested)
                if not expected:
                    self.assertIsNone(actual)
                else:
                    self.assertAlmostEqual(actual.bounds[2] - actual.bounds[0], expected)
                    self.assertLess(actual.difference(slot).area, 1e-8)
        small = dict(BASE, pcb_size_x=20, pcb_size_y=18, eject_slot_width=22,
                     eject_hole_diameter=6)
        slot = jg.get_polys(small)[0]
        self.assertIsNone(jg._eject_hole_geometry(slot, 22))
        part = jg.build_insert(small)
        self.assertFalse(inside(part, 0, 0, 0.6))
        self.assertTrue(inside(part, 4, 0, 0.6))
        closed = jg.build_insert(dict(small, eject_slot_width=0))
        self.assertTrue(inside(closed, 0, 0, 0.6))

    def test_invalid_manual_eject_diameters_are_rejected_even_when_switched_off(self):
        for value in (True, False, None, "12", float("nan"), float("inf"), -1, 2, 3.9, 40.1):
            for enabled in (False, True):
                with self.subTest(value=value, enabled=enabled):
                    p = params(component_relief_enabled=enabled, component_relief_regions=[],
                               eject_slot_width=0, eject_hole_diameter=value)
                    with self.assertRaisesRegex(ValueError, "顶出孔直径"):
                        jg.build_insert(p)
                    validation = jg.validate_component_relief(p)
                    self.assertFalse(validation["valid"])
                    self.assertIn("顶出孔直径", validation["error"])
                    merged = jg.merge_component_relief(p, selected_ids=[])
                    self.assertFalse(merged["valid"])
                    self.assertIn("顶出孔直径", merged["error"])

    def test_manual_eject_support_check_uses_exact_selected_diameter(self):
        p = params(eject_slot_width=22, eject_hole_diameter=4, component_relief_regions=[
            region("left", x=-11.5, width=17, height=30),
            region("right", x=11.5, width=17, height=30),
            region("down", y=-9, width=6, height=12),
            region("up", y=9, width=6, height=12),
        ])
        self.assertEqual(jg.validate_component_relief(p), {"valid": True})
        self.assertTrue(jg.merge_component_relief(p, selected_ids=[])["valid"])
        self.assertTrue(jg.build_insert(p).is_valid)
        opened = dict(p, eject_hole_diameter=12)
        self.assertFalse(jg.validate_component_relief(opened)["valid"])
        self.assertFalse(jg.merge_component_relief(opened, selected_ids=[])["valid"])
        with self.assertRaisesRegex(ValueError, "没有可承托区域"):
            jg.build_insert(opened)

    def test_manual_eject_roundtrips_stl_step_with_blind_and_through_relief(self):
        for diameter in (6, 14):
            with self.subTest(diameter=diameter):
                p = params(eject_slot_width=22, eject_hole_diameter=diameter,
                           component_relief_regions=[
                               region("through", x=8, y=5, width=4, height=4, through=True),
                               region("blind", x=-12, y=-5, width=4, height=4, depth=3),
                           ])
                self._assert_roundtrip_floors(p, [
                    (0.137, 0.193, None),
                    (4.137, 0.193, 6.4 if diameter == 6 else None),
                    (8.137, 5.193, None), (-12.137, -5.193, 3.4),
                ])

    def test_eject_switch_and_adaptive_size_remain_unchanged(self):
        p = params(component_relief_regions=[region(x=6)])
        closed = jg.build_insert(p)
        self.assertTrue(inside(closed, 0, 0, 0.6))
        for width in (1, 22, 40):
            with self.subTest(width=width):
                opened = jg.build_insert(dict(p, eject_slot_width=width))
                self.assertFalse(inside(opened, 0, 0, 0.6))
                self.assertFalse(inside(opened, 5.8, 0, 0.6))
                self.assertTrue(inside(opened, 6.2, 0, 0.6))
        small = dict(p, pcb_size_x=20, pcb_size_y=18, eject_slot_width=22)
        self.assertIsNone(jg._eject_hole_geometry(jg.get_polys(small)[0], 22))
        large = dict(p, pcb_size_x=150, pcb_size_y=120)
        footprint = jg._eject_hole_geometry(jg.get_polys(large)[0], 22)
        self.assertEqual(footprint.bounds, (-15.0, -15.0, 15.0, 15.0))

    def test_eject_hole_preserves_concave_position_and_outline_clipping(self):
        # The U-shaped slot has its centroid in the opening. The old fallback
        # puts the hole at a representative material point and clips the disk.
        outline = [[-30, -20], [30, -20], [30, 20], [20, 20],
                   [20, -10], [-20, -10], [-20, 20], [-30, 20]]
        p = dict(BASE, pcb_outline_points=outline)
        slot = jg.get_polys(p)[0]
        self.assertFalse(slot.contains(slot.centroid))
        center = slot.representative_point()
        diameter = min(min(slot.bounds[2] - slot.bounds[0],
                           slot.bounds[3] - slot.bounds[1]) * 0.35, 30)
        expected = center.buffer(diameter / 2, resolution=16).intersection(slot)
        actual = jg._eject_hole_geometry(slot, 22)
        self.assertLess(actual.symmetric_difference(expected).area, 1e-8)
        self.assertLess(actual.area, Point(center.x, center.y).buffer(diameter / 2, resolution=16).area)

    def test_manual_eject_tangent_to_concave_arm_keeps_only_extrudable_areas(self):
        # The ordinary 11 mm slider value touches the distant arm at one point.
        # Shapely returns Polygon + Point; trying to extrude the collection used
        # to fail after the exact support preflight had already accepted it.
        outline = unary_union([
            box(-11, -20, 0, 20), box(0, 15, 12, 20),
            box(7, 5, 12, 15), box(4, -5, 12, 5),
        ])
        p = params(pcb_size_x=23, pcb_size_y=40, pcb_pocket_clearance=0,
                   pcb_outline_points=[[x - 0.5, y] for x, y in list(outline.exterior.coords)[:-1]],
                   eject_slot_width=22, eject_hole_diameter=11,
                   component_relief_regions=[region(x=-7, y=-10, width=3, height=4, depth=2)])
        original = copy.deepcopy(p)
        slot = jg.get_polys(copy.deepcopy(p))[0]
        raw = slot.centroid.buffer(5.5, resolution=16).intersection(slot)
        self.assertEqual(raw.geom_type, "GeometryCollection")
        actual = jg._eject_hole_geometry(slot, 22, 11)
        self.assertEqual(actual.geom_type, "Polygon")
        self.assertLess(actual.symmetric_difference(raw).area, 1e-8)
        self.assertEqual(jg.validate_component_relief(p), {"valid": True})
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertEqual(len(part.solids()), 1)
        self.assertFalse(inside(part, -2, 2, 0.6))
        self.assertTrue(inside(part, 5, 2, 0.6))
        self._assert_roundtrip_floors(p, [
            (-2.137, 2.193, None), (5.137, 2.193, 6.4),
            (-7.137, -10.193, 4.4), (0.137, -10.193, 8),
        ])
        self.assertEqual(p, original)

    def test_combined_relief_and_eject_hole_cannot_remove_all_support(self):
        p = params(component_relief_regions=[
            region("left", x=-11.5, width=17, height=30),
            region("right", x=11.5, width=17, height=30),
            region("down", y=-9, width=6, height=12),
            region("up", y=9, width=6, height=12),
        ])
        supported = jg.build_insert(p)
        self.assertTrue(inside(supported, 0, 0, 6))  # center island on its own
        with self.assertRaisesRegex(ValueError, "没有可承托区域"):
            jg.build_insert(dict(p, eject_slot_width=22))

    def test_disabled_relief_preserves_legacy_eject_hole(self):
        p = dict(BASE, eject_slot_width=22)
        old = jg.build_insert(copy.deepcopy(p))
        p.update(component_relief_enabled=False, component_relief_depth=10,
                 jig_print_side="bottom", component_relief_regions=[region()])
        disabled = jg.build_insert(p)
        self.assertAlmostEqual(old.volume, disabled.volume, places=5)
        self.assertFalse(inside(disabled, 0, 0, 0.6))
        self.assertTrue(inside(disabled, 10, 0, 6))

    def test_overlapping_pockets_union_and_clip_before_locating_wall(self):
        p = params(component_relief_regions=[
            region("rect", x=10),
            dict(id="circle", shape="circle", x=18, y=0, width=10, height=10),
        ])
        oriented = jg._jig_component_params(p)
        relief = jg._component_relief_geometry(oriented)
        expected = box(6, -3, 14, 3).union(Point(18, 0).buffer(5, resolution=24)).intersection(box(-20, -15, 20, 15))
        self.assertLess(relief.symmetric_difference(expected).area, 1e-8)
        part = jg.build_insert(p)
        self.assertTrue(part.is_valid)
        self.assertEqual(len(part.solids()), 1)
        self.assertFalse(inside(part, 13.5, 0, 5))
        self.assertFalse(inside(part, 19.5, 0, 5))
        self.assertTrue(inside(part, 20.1, 0, 5))  # locating wall not widened

    def test_tall_parts_extend_tray_and_alignment_posts_together(self):
        p = params(component_relief_depth=10)
        original = copy.deepcopy(p)
        part = jg.build_part(p, "insert")
        self.assertEqual(p, original)
        self.assertFalse(inside(part, 0, 0, 2))
        self.assertTrue(inside(part, 0, 0, 0.6))
        self.assertTrue(inside(part, 10, 0, 11))
        self.assertAlmostEqual(part.bounding_box().max.Z, 16.8, places=5)
        normalized = jg._jig_component_params(p)
        self.assertAlmostEqual(normalized["insert_height"] - p["pcb_thickness"] - 10, 1.2)

    def test_bottom_print_mirrors_outline_holes_and_pockets_once(self):
        outline = [[-20, -15], [20, -15], [20, 0], [0, 0], [0, 15], [-20, 15]]
        hole = [[-13, 6], [-9, 6], [-9, 10], [-13, 10]]
        p = params(jig_print_side="bottom", pcb_outline_points=outline,
                   pcb_outline_holes=[hole], component_relief_regions=[region(y=-7, x=-8)])
        original = copy.deepcopy(p)
        direct = jg.build_insert(p)
        self.assertEqual(p, original)
        self.assertFalse(inside(direct, -8, 7, 5))  # mirrored component pocket
        self.assertTrue(inside(direct, -8, -7, 5))
        self.assertFalse(inside(direct, -11, -8, 0.6))  # mirrored board cutout
        self.assertTrue(inside(direct, 10, -7, 7))  # outside mirrored L-board
        self.assertFalse(inside(direct, 10, 7, 7))
        via_dispatch = jg.build_part(p, "insert")
        self.assertAlmostEqual(direct.volume, via_dispatch.volume, places=5)
        self.assertFalse(inside(via_dispatch, -8, 7, 5))

    def test_region_union_can_preserve_internal_support_island(self):
        p = params(component_relief_regions=[
            dict(id="left", shape="rect", x=-6, y=0, width=4, height=16),
            dict(id="right", shape="rect", x=6, y=0, width=4, height=16),
            dict(id="up", shape="rect", x=0, y=6, width=16, height=4),
            dict(id="down", shape="rect", x=0, y=-6, width=16, height=4),
        ])
        relief = jg._component_relief_geometry(jg._jig_component_params(p))
        self.assertEqual(len(relief.interiors), 1)
        part = jg.build_insert(p)
        self.assertTrue(inside(part, 0, 0, 6))
        self.assertFalse(inside(part, 6, 0, 6))
        self.assertEqual(len(part.solids()), 1)

    def test_concave_board_tangency_keeps_polygonal_pocket(self):
        outline = [[-10, -10], [10, -10], [10, 10], [5, 10],
                   [5, -5], [-5, -5], [-5, 10], [-10, 10]]
        p = params(pcb_outline_points=outline, component_relief_regions=[
            region(x=2.5, y=2.5, width=15, height=5),
        ])
        relief = jg._component_relief_geometry(jg._jig_component_params(p))
        self.assertAlmostEqual(relief.area, 25)
        self.assertEqual(relief.geom_type, "Polygon")
        part = jg.build_insert(p)
        self.assertFalse(inside(part, 7, 2, 5))
        self.assertTrue(inside(part, -7, 2, 5))

    def test_disabled_fields_have_no_geometric_effect(self):
        p = copy.deepcopy(BASE)
        old = jg.build_insert(copy.deepcopy(p))
        p.update(component_relief_enabled=False, component_relief_depth=10,
                 jig_print_side="bottom", component_relief_regions=[region()])
        disabled = jg.build_insert(p)
        self.assertAlmostEqual(old.volume, disabled.volume, places=5)
        self.assertTrue(inside(disabled, 0, 0, 5))

    def test_enabled_without_regions_keeps_nominal_height(self):
        p = params(component_relief_regions=[], component_relief_depth=20)
        self.assertEqual(jg._jig_component_params(p)["insert_height"], 8)
        self.assertIsNone(jg._component_relief_geometry(jg._jig_component_params(p)))

    def test_bad_shapes_counts_and_numbers_are_rejected(self):
        bad = [
            {"component_relief_depth": float("inf")},
            {"component_relief_depth": 0},
            {"component_relief_depth": True},
            {"component_relief_enabled": "true"},
            {"jig_print_side": "sideways"},
            {"component_relief_regions": [dict(region(), width=-1)]},
            {"component_relief_regions": [dict(region(), x=float("nan"))]},
            {"component_relief_regions": [dict(region(), y=True)]},
            {"component_relief_regions": [dict(region(), shape="circle", width=4, height=6)]},
            {"component_relief_regions": [region(), region()]},
            {"component_relief_regions": [region(str(i)) for i in range(101)]},
        ]
        for changes in bad:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                jg._jig_component_params(params(**changes))

    def test_outside_and_full_board_pockets_are_rejected(self):
        for pockets in ([region(x=100)], [dict(region(), width=100, height=100)]):
            with self.subTest(pockets=pockets), self.assertRaises(ValueError):
                jg._component_relief_geometry(jg._jig_component_params(params(component_relief_regions=pockets)))

    def test_printed_stencil_does_not_consume_jig_relief_or_side(self):
        p = dict(BASE, stencil_thickness=0.3, stencil_frame_width=12, stencil_frame_shape="outline",
                 pocket_clearance=0.3, pad_shrink=0, stencil_stagger=False, stencil_grid=False)
        old = jg.build_stencil(copy.deepcopy(p), "bottom")
        p.update(component_relief_enabled=True, component_relief_depth=10,
                 jig_print_side="bottom", component_relief_regions=[region()])
        new = jg.build_part(p, "stencil_bottom")
        self.assertAlmostEqual(old.volume, new.volume, places=6)
        self.assertAlmostEqual(old.bounding_box().max.Z, new.bounding_box().max.Z, places=6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
