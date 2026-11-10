import { describe, expect, it } from "vitest";
import { Spherical, Vector3 } from "three";
import { createPreviewCameraMotion, type PreviewView } from "../preview-camera-motion";

describe("preview camera motion", () => {
  it.each<PreviewView>(["front", "top", "iso"])("keeps the orbit distance when moving to %s", view => {
    const from = new Vector3(-83, 51, -120);
    const original = from.clone();
    const motion = createPreviewCameraMotion(from, view, 100);
    const out = new Vector3();
    for (let now = 100; now <= 460; now += 12) {
      motion.sample(now, out);
      expect(out.length()).toBeCloseTo(from.length(), 10);
    }
    expect(from).toEqual(original);
  });

  it("takes the short azimuth path across the -pi/pi boundary", () => {
    // Front sits at theta=0. From just above -pi, the shorter route passes
    // through -pi/2 rather than continuing backward through +pi/2.
    const from = new Vector3().setFromSpherical(new Spherical(100, Math.PI / 2, -Math.PI + 0.1));
    const motion = createPreviewCameraMotion(from, "front", 0);
    const out = new Vector3();
    motion.sample(180, out);
    expect(new Spherical().setFromVector3(out).theta).toBeCloseTo((-Math.PI + 0.1) / 2, 10);
    expect(out.x).toBeLessThan(0);

    // The isometric destination is positive; the shortest route from a large
    // negative angle wraps below -pi, never swinging across the front.
    const wrapped = new Vector3().setFromSpherical(new Spherical(100, Math.PI / 2, -3));
    createPreviewCameraMotion(wrapped, "iso", 0).sample(180, out);
    expect(out.z).toBeLessThan(0);
    const midpoint = (-3 + Math.atan2(120, 150) - Math.PI * 2) / 2 + Math.PI * 2;
    expect(new Spherical().setFromVector3(out).theta).toBeCloseTo(midpoint, 10);
  });

  it.each([new Vector3(0, 100, 0), new Vector3(0, -100, 0)])("keeps pole transitions finite and gives top a safe offset", from => {
    const motion = createPreviewCameraMotion(from, "top", 0);
    const out = new Vector3();
    for (const now of [0, 1, 90, 180, 359, 360]) {
      motion.sample(now, out);
      expect([out.x, out.y, out.z].every(Number.isFinite)).toBe(true);
      expect(out.length()).toBeCloseTo(100, 10);
    }
    expect(out.y).toBeGreaterThan(99.999);
    expect(out.z).toBeGreaterThan(0);
    expect(new Spherical().setFromVector3(out).phi).toBeGreaterThan(0);
  });

  it.each<{ view: PreviewView; direction: Vector3 }>([
    { view: "front", direction: new Vector3(0, 0, 1) },
    { view: "top", direction: new Vector3(0, 1, 0.0001) },
    { view: "iso", direction: new Vector3(120, 80, 150) },
  ])("writes the exact $view destination on completion and later samples", ({ view, direction }) => {
    const from = new Vector3(-20, 70, 90);
    const motion = createPreviewCameraMotion(from, view, 100);
    const out = new Vector3();
    expect(motion.sample(459, out)).toBe(true);
    expect(motion.sample(460, out)).toBe(false);
    expect(out).toEqual(direction.normalize().multiplyScalar(from.length()));
    out.set(1, 2, 3);
    expect(motion.sample(900, out)).toBe(false);
    expect(out).toEqual(direction);
  });

  it("starts a replacement transition at the current sampled offset without a jump", () => {
    const first = createPreviewCameraMotion(new Vector3(120, 80, 150), "top", 100);
    const current = new Vector3();
    first.sample(237, current);
    const snapshot = current.clone();
    const replacement = createPreviewCameraMotion(current, "front", 237);
    expect(replacement.sample(237, current)).toBe(true);
    expect(current).toEqual(snapshot);
    expect(replacement.sample(238, current)).toBe(true);
    expect(current.distanceTo(snapshot)).toBeLessThan(0.001);
    expect(current.length()).toBeCloseTo(snapshot.length(), 10);
  });

  it("clamps early samples and finishes stationary offsets without running an idle transition", () => {
    const from = new Vector3(120, 80, 150);
    const out = new Vector3();
    const motion = createPreviewCameraMotion(from, "front", 100);
    expect(motion.sample(50, out)).toBe(true);
    expect(out).toEqual(from);
    expect(createPreviewCameraMotion(new Vector3(0, 0, 100), "front", 100).sample(100, out)).toBe(false);
    expect(out).toEqual(new Vector3(0, 0, 100));
    expect(createPreviewCameraMotion(new Vector3(), "top", 100).sample(100, out)).toBe(false);
    expect(out).toEqual(new Vector3());
  });
});
