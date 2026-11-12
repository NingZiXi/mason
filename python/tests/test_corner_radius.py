"""Zero-radius settings must produce square corners in all three jig parts."""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import jig_generator as jg
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.TopAbs import TopAbs_IN
from OCP.gp import gp_Pnt
from shapely.geometry import box


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


class CornerRadiusTests(unittest.TestCase):
    def test_zero_outer_radius_preserves_full_square_area(self):
        part = jg.rounded_square_solid(20, 4, 0)
        self.assertTrue(part.is_valid)
        self.assertEqual(len(part.solids()), 1)
        self.assertAlmostEqual(part.volume, 20 * 20 * 4, places=6)

    def test_positive_outer_radius_keeps_rounded_geometry(self):
        for radius in (0.1, 3):
            with self.subTest(radius=radius):
                part = jg.rounded_square_solid(20, 4, radius)
                self.assertTrue(part.is_valid)
                self.assertAlmostEqual(part.volume, (400 - (4 - math.pi) * radius ** 2) * 4,
                                       places=6)

    def test_zero_outer_radius_builds_all_parts_with_square_external_corners(self):
        for builder in (jg.build_insert, jg.build_base, jg.build_cover):
            for platter_radius in (0, 3):
                with self.subTest(part=builder.__name__, platter_radius=platter_radius):
                    params = dict(BASE, outer_corner_radius=0, platter_corner_radius=platter_radius)
                    part = builder(params)
                    self.assertTrue(part.is_valid)
                    self.assertEqual(len(part.solids()), 1)
                    classifier = BRepClass3d_SolidClassifier(part.solids()[0].wrapped)
                    classifier.Perform(gp_Pnt(54.9, 54.9, 2), 1e-6)
                    self.assertEqual(classifier.State(), TopAbs_IN)
                    self.assertEqual(params["outer_corner_radius"], 0)
                    self.assertEqual(params["platter_corner_radius"], platter_radius)

    def test_zero_platter_radius_gives_square_platter_and_matching_window(self):
        for radius in (0, 0.0):
            with self.subTest(radius=radius):
                params = dict(BASE, platter_corner_radius=radius)
                _, platter, window, _ = jg.get_polys(params)
                self.assertEqual(len(platter.exterior.coords), 5)
                self.assertEqual(len(window.exterior.coords), 5)
                self.assertAlmostEqual(platter.symmetric_difference(box(*platter.bounds)).area, 0)
                self.assertAlmostEqual(window.symmetric_difference(box(*window.bounds)).area, 0)
                self.assertEqual(window.bounds, tuple(value + (-0.5 if index < 2 else 0.5)
                                                     for index, value in enumerate(platter.bounds)))

    def test_positive_and_legacy_empty_platter_radius_keep_previous_behavior(self):
        for radius, expected in ((0.1, 0.1), (3, 3), (None, 4.5), (False, 4.5), ("", 4.5)):
            with self.subTest(radius=radius):
                params = dict(BASE, platter_corner_radius=radius)
                slot, platter, _, _ = jg.get_polys(params)
                self.assertAlmostEqual(jg.plater_radius(params, slot)[2], expected)
                self.assertGreater(len(platter.exterior.coords), 5)
        params = dict(BASE)
        del params["platter_corner_radius"]
        slot, _, _, _ = jg.get_polys(params)
        self.assertAlmostEqual(jg.plater_radius(params, slot)[2], 4.5)


if __name__ == "__main__":
    unittest.main()
