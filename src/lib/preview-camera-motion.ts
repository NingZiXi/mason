import { MathUtils, Spherical, Vector3 } from "three";

export type PreviewView = "front" | "top" | "iso";

export interface PreviewCameraMotion {
  /** Writes the current offset; false means the exact destination was written. */
  sample(now: number, out: Vector3, target?: Vector3): boolean;
}

const DURATION_MS = 360;
const FRAMING_DURATION_MS = 280;
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
  const destination = new Vector3(...DIRECTIONS[view]).normalize().multiplyScalar(fromOffset.length());
  return createCameraMotion(fromOffset, destination, startedAt, DURATION_MS);
}

/** Reframe a different part along the orbit while moving its center and zoom. */
export function createPreviewFramingMotion(
  fromOffset: Vector3,
  toOffset: Vector3,
  fromTarget: Vector3,
  toTarget: Vector3,
  startedAt: number,
): PreviewCameraMotion {
  return createCameraMotion(fromOffset, toOffset, startedAt, FRAMING_DURATION_MS,
    { from: fromTarget.clone(), to: toTarget.clone() });
}

function createCameraMotion(
  fromOffset: Vector3,
  toOffset: Vector3,
  startedAt: number,
  duration: number,
  target?: { from: Vector3; to: Vector3 },
): PreviewCameraMotion {
  const start = fromOffset.clone();
  const destination = toOffset.clone();
  const radius = start.length();
  const destinationRadius = destination.length();
  const from = new Spherical().setFromVector3(start).makeSafe();
  const to = new Spherical().setFromVector3(destination).makeSafe();
  const thetaDelta = MathUtils.euclideanModulo(to.theta - from.theta + Math.PI, Math.PI * 2) - Math.PI;
  const phiDelta = to.phi - from.phi;
  const current = new Spherical(radius);
  const stationary = start.distanceToSquared(destination) <= Number.EPSILON * radius * radius
    && (!target || target.from.distanceToSquared(target.to) <= Number.EPSILON);

  return {
    sample(now, out, outTarget) {
      const progress = MathUtils.clamp((now - startedAt) / duration, 0, 1);
      if (stationary || progress >= 1) {
        out.copy(destination);
        if (target && outTarget) outTarget.copy(target.to);
        return false;
      }
      if (progress === 0) {
        out.copy(start);
        if (target && outTarget) outTarget.copy(target.from);
        return true;
      }
      // Smootherstep has zero velocity and acceleration at both ends.
      const eased = progress * progress * progress * (progress * (progress * 6 - 15) + 10);
      current.theta = from.theta + thetaDelta * eased;
      current.phi = from.phi + phiDelta * eased;
      current.radius = MathUtils.lerp(radius, destinationRadius, eased);
      out.setFromSpherical(current.makeSafe());
      if (target && outTarget) outTarget.lerpVectors(target.from, target.to, eased);
      return true;
    },
  };
}
