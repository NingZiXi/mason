export interface PositioningPostDimensions {
  jigSize: number;
  windowHalf: number;
  platterHalf: number;
  postDiameter: number;
  postClearance: number;
  outerCornerRadius: number;
  platterCornerRadius: number;
}

/** Mirrors corner_screw_positions() in the model engine. Keep the same outer
 * clamp even when a manually reduced jig cannot satisfy both constraints;
 * fits exposes that conflict without drawing a different post arrangement.
 */
export function positioningPostLayout(c: PositioningPostDimensions) {
  const postRadius = c.postDiameter / 2;
  const holeRadius = postRadius + c.postClearance;
  const minOffset = Math.max(c.windowHalf + holeRadius,
    c.platterHalf + postRadius / Math.sqrt(2) - c.platterCornerRadius * (1 - 1 / Math.sqrt(2)));
  const outerInset = c.outerCornerRadius + postRadius + 1;
  const maxOffset = c.jigSize / 2 - outerInset;
  const offset = Math.min(Math.max(c.jigSize / 2 - 7, minOffset), maxOffset);
  return {
    positions: [[offset, offset], [offset, -offset], [-offset, offset], [-offset, -offset]] as Array<[number, number]>,
    minimumJigSize: 2 * (minOffset + outerInset),
    fits: minOffset <= maxOffset + 1e-7,
  };
}
