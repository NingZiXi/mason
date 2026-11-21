export type Vec2 = [number, number];
/** Row-major 3×3 projective transform. */
export type Homography = number[];

/** Solve the projective transform mapping four src points onto four dst points. */
export function solveHomography(src: readonly Vec2[], dst: readonly Vec2[]): Homography {
  if (src.length !== 4 || dst.length !== 4) throw new Error('homography needs four point pairs');
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('degenerate homography');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      if (f === 0) continue;
      for (let k = col; k < 9; k++) a[r][k] -= f * a[col][k];
    }
  }
  const h = a.map((row, i) => row[8] / row[i]);
  return [...h, 1];
}

export function applyHomography(h: Homography, [x, y]: Vec2): Vec2 {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}
