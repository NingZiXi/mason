import { MathUtils, Spherical, Vector3 } from "three";

export type PreviewView = "front" | "top" | "iso";

export interface PreviewCameraMotion {
  /** Writes the current offset; false means the exact destination was written. */
  sample(now: number, out: Vector3): boolean;
}

const DURATION_MS = 360;
const DIRECTIONS: Record<PreviewView, readonly [number, number, number]> = {
  front: [0, 0, 1],
  // A small forward component keeps the up vector unambiguous at the pole.
  top: [0, 1, 0.0001],
  iso: [120, 80, 150],
};

/** Orbit around the existing target without dollying through the model. */
export function createPreviewCameraMotion(
  fromOffset: Vector3,
  view: PreviewView,
  startedAt: number,
): PreviewCameraMotion {
  const start = fromOffset.clone();
  const radius = start.length();
  const destination = new Vector3(...DIRECTIONS[view]).normalize().multiplyScalar(radius);
  const from = new Spherical().setFromVector3(start).makeSafe();
  const to = new Spherical().setFromVector3(destination).makeSafe();
  const thetaDelta = MathUtils.euclideanModulo(to.theta - from.theta + Math.PI, Math.PI * 2) - Math.PI;
  const phiDelta = to.phi - from.phi;
  const current = new Spherical(radius);
  const stationary = start.distanceToSquared(destination) <= Number.EPSILON * radius * radius;

  return {
    sample(now, out) {
      const progress = MathUtils.clamp((now - startedAt) / DURATION_MS, 0, 1);
      if (stationary || progress >= 1) {
        out.copy(destination);
        return false;
      }
      if (progress === 0) {
        out.copy(start);
        return true;
      }
      // Smootherstep has zero velocity and acceleration at both ends.
      const eased = progress * progress * progress * (progress * (progress * 6 - 15) + 10);
      current.theta = from.theta + thetaDelta * eased;
      current.phi = from.phi + phiDelta * eased;
      out.setFromSpherical(current.makeSafe());
      return true;
    },
  };
}
