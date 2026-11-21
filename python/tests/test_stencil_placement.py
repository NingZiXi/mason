"""Board placement on an off-centre stencil (jig mode); no pytest dependency required.

The stencil, A/B windows and platter stay centred on the jig. Only the PCB
pocket (and everything that follows the board) moves to where the board's
openings were cut on the stencil.

Run: python python/tests/test_stencil_placement.py
"""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import jig_generator as jg
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.TopAbs import TopAbs_IN, TopAbs_ON
from OCP.gp import gp_Pnt

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
# An L-shaped board: asymmetric about both axes, so flips and turns are visible.
L_BOARD = [[-20, -15], [20, -15], [20, 0], [0, 0], [0, 15], [-20, 15]]


def params(**changes):
    p = copy.deepcopy(BASE)
    p.update(changes)
    return p


def polys(p):
    return jg.get_polys(jg._jig_placed_params(copy.deepcopy(p)))


def inside(part, x, y, z):
    for solid in part.solids():
        classifier = BRepClass3d_SolidClassifier(solid.wrapped)
        classifier.Perform(gp_Pnt(x, y, z), 1e-6)
        if classifier.State() in (TopAbs_IN, TopAbs_ON):
            return True
    return False


def close(a, b, tol=0.02):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


class PlacementGeometry(unittest.TestCase):
    def test_centred_placement_matches_the_legacy_jig(self):
        legacy = polys(params())
        placed = polys(params(pcb_placement={"x": 0, "y": 0, "quarter": 0}))
        for a, b in zip(legacy[:3], placed[:3]):
            self.assertTrue(close(a.bounds, b.bounds), (a.bounds, b.bounds))

    def test_offset_moves_only_the_pocket(self):
        slot, platter, window, _ = polys(params(pcb_placement={"x": 5, "y": -3, "quarter": 0}))
        self.assertTrue(close(slot.bounds, (-15.2, -18.2, 25.2, 12.2)), slot.bounds)
        # Platter and window stay centred on the stencil and contain the pocket.
        self.assertTrue(close(platter.bounds, (-27, -22, 27, 22)), platter.bounds)
        self.assertTrue(close(window.bounds, (-27.5, -22.5, 27.5, 22.5)), window.bounds)
        self.assertTrue(platter.contains(slot))

    def test_platter_grows_to_hold_a_pocket_near_the_sheet_edge(self):
        slot, platter, window, _ = polys(params(pcb_placement={"x": 10, "y": 0, "quarter": 0}))
        self.assertAlmostEqual(slot.bounds[2], 30.2, places=2)
        # The platter widens symmetrically to keep the stencil and jig centred.
        self.assertAlmostEqual(platter.bounds[2], 30.2, places=2)
        self.assertAlmostEqual(platter.bounds[0], -30.2, places=2)
        self.assertTrue(platter.buffer(1e-6).contains(slot))

    def test_quarter_turn_rotates_the_pocket(self):
        slot, _platter, _window, _ = polys(params(pcb_placement={"x": 0, "y": 0, "quarter": 1}))
        self.assertTrue(close(slot.bounds, (-15.2, -20.2, 15.2, 20.2)), slot.bounds)
        turned, _, _, _ = polys(params(pcb_outline_points=L_BOARD, pcb_placement={"x": 0, "y": 0, "quarter": 1}))
        # (20, -15) -> (15, 20): the notch of the L now opens towards -x, +y.
        self.assertTrue(turned.contains(jg.ShapelyPoint(10, 15)))
        self.assertFalse(turned.contains(jg.ShapelyPoint(-10, 10)))

    def test_bottom_side_is_flipped_before_placement_without_relief(self):
        top, _, _, _ = polys(params(pcb_outline_points=L_BOARD, pcb_placement={"x": 0, "y": 0, "quarter": 0}))
        bottom, _, _, _ = polys(params(pcb_outline_points=L_BOARD, jig_print_side="bottom",
                                       pcb_placement={"x": 0, "y": 0, "quarter": 0}))
        self.assertFalse(top.contains(jg.ShapelyPoint(10, 10)))
        self.assertTrue(top.contains(jg.ShapelyPoint(10, -10)))
        self.assertTrue(bottom.contains(jg.ShapelyPoint(10, 10)))
        self.assertFalse(bottom.contains(jg.ShapelyPoint(10, -10)))

    def test_bottom_side_is_flipped_once_with_relief(self):
        relief = dict(component_relief_enabled=True, component_relief_depth=3, jig_print_side="bottom",
                      component_relief_regions=[{"id": "u1", "shape": "rect", "x": -10, "y": 7, "width": 6, "height": 4}])
        p = jg._jig_placed_params(params(pcb_outline_points=L_BOARD, pcb_placement={"x": 2, "y": 1, "quarter": 1}, **relief))
        # Flip (x, -y), then turn (x, y) -> (-y, x), then move by (2, 1).
        self.assertIn([2 - 15, 1 + 20], p["pcb_outline_points"])  # (20, -15) -> (20, 15) -> (-15, 20)
        region = p["component_relief_regions"][0]
        self.assertAlmostEqual(region["x"], 2 + 7)
        self.assertAlmostEqual(region["y"], 1 - 10)
        self.assertEqual((region["width"], region["height"]), (4, 6))
        self.assertEqual(jg.validate_component_relief(params(pcb_outline_points=L_BOARD,
                         pcb_placement={"x": 2, "y": 1, "quarter": 1}, **relief)), {"valid": True})

    def test_relief_editing_stays_in_board_coordinates(self):
        relief = dict(component_relief_enabled=True, component_relief_depth=3, jig_print_side="top",
                      component_relief_regions=[
                          {"id": "a", "shape": "rect", "x": -5, "y": 0, "width": 4, "height": 4, "depth": 3},
                          {"id": "b", "shape": "rect", "x": 0, "y": 0, "width": 4, "height": 4, "depth": 3}])
        merged = jg.merge_component_relief(params(pcb_placement={"x": 9, "y": 4, "quarter": 2}, **relief), gap=2)
        self.assertTrue(merged["valid"], merged)
        self.assertEqual(len(merged["regions"]), 1)
        xs = [x for x, _ in merged["regions"][0].get("points", [])] or [merged["regions"][0]["x"]]
        self.assertLess(max(xs), 3)  # not moved to the placed position

    def test_invalid_placement_is_rejected(self):
        for bad in ({"x": float("nan"), "y": 0, "quarter": 0}, {"x": 0, "y": 0, "quarter": 5},
                    {"x": 0, "y": 400, "quarter": 0}, {"x": True, "y": 0, "quarter": 0}, [1, 2]):
            with self.assertRaises(ValueError):
                jg._jig_placed_params(params(pcb_placement=bad))


class PlacedTray(unittest.TestCase):
    def test_tray_pocket_moves_with_the_board(self):
        insert = jg.build_insert(params(pcb_placement={"x": 5, "y": -3, "quarter": 0}))
        top = BASE["insert_height"] - 0.5
        self.assertFalse(inside(insert, 5, -3, top))       # placed pocket is open
        self.assertFalse(inside(insert, 24, -3, top))      # its moved right edge
        self.assertTrue(inside(insert, -18, -3, top))      # old centred pocket edge is now platter
        self.assertTrue(inside(insert, 5, -3, BASE["insert_height"] - 2.5))  # pocket floor remains

    def test_frames_stay_centred(self):
        p = params(pcb_placement={"x": 5, "y": -3, "quarter": 0})
        for build in (jg.build_base, jg.build_cover):
            part = build(p)
            bb = part.bounding_box()
            self.assertAlmostEqual(bb.min.X, -bb.max.X, places=3)
            self.assertAlmostEqual(bb.min.Y, -bb.max.Y, places=3)
            # The A/B window is centred, not moved with the board.
            self.assertFalse(inside(part, -26, 0, 0.1 if build is jg.build_base else 3.9))


if __name__ == "__main__":
    unittest.main()
