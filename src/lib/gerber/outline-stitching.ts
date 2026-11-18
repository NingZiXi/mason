type Point = [number, number];
type Stroke = Point[];

// EasyEDA can leave ~0.028 mm between a straight edge and its corner arc (#5).
// Resolve exact connections first; only repair gaps with one possible partner at both ends.
const MAX_GAP_MM = 0.03;
const midpoint = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

export function stitchOutline(strokes: Stroke[]) {
  const closed: Stroke[] = [], open: Stroke[] = [], parts: Stroke[] = [];
  for (const s of strokes) {
    if (s.length < 2) continue;
    const first = s[0], last = s[s.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      if (s.length >= 4) closed.push(s);
    } else parts.push(s);
  }

  // Each stroke owns two endpoints: 2*i is its start, 2*i+1 its end.
  const ends = parts.flatMap(s => [s[0], s[s.length - 1]]);
  const links = new Int32Array(ends.length).fill(-1);
  const buckets = new Map<string, number[]>();
  const cells = ends.map(([x, y], i) => {
    const cell = [Math.floor(x / MAX_GAP_MM), Math.floor(y / MAX_GAP_MM)];
    const key = cell.join(',');
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i); else buckets.set(key, [i]);
    return cell;
  });
  for (const tolerance of [0, MAX_GAP_MM]) {
    const candidates = new Int32Array(ends.length).fill(-1);
    ends.forEach(([x, y], i) => {
      if (links[i] !== -1) return;
      const [cx, cy] = cells[i];
      let match = -1;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const j of buckets.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (i === j || links[j] !== -1) continue;
          // A short straight stroke cannot be a loop by itself.
          if ((i ^ 1) === j && parts[i >> 1].length < 4) continue;
          if (Math.hypot(x - ends[j][0], y - ends[j][1]) > tolerance) continue;
          if (match !== -1) return; // ambiguous junction
          match = j;
        }
      }
      candidates[i] = match;
    });
    candidates.forEach((j, i) => { if (j !== -1 && candidates[j] === i) links[i] = j; });
  }

  const visited = new Set<number>();
  function trace(start: number) {
    if (visited.has(start >> 1)) return;
    const path: Stroke = [];
    let entry = start;
    do {
      visited.add(entry >> 1);
      const part = parts[entry >> 1];
      const reverse = (entry & 1) !== 0;
      if (path.length) path[path.length - 1] = midpoint(path[path.length - 1], ends[entry]);
      for (let i = path.length ? 1 : 0; i < part.length; i++) {
        path.push(part[reverse ? part.length - 1 - i : i]);
      }
      entry = links[entry ^ 1];
    } while (entry !== -1 && entry !== start);
    if (entry === -1) open.push(path);
    else if (path.length >= 4) {
      path[0] = path[path.length - 1] = midpoint(path[0], path[path.length - 1]);
      closed.push(path);
    }
  }
  // Trace chains from a free end, then visit the remaining cycles.
  links.forEach((j, i) => { if (j === -1) trace(i); });
  parts.forEach((_, i) => trace(2 * i));
  return { closed, open };
}
