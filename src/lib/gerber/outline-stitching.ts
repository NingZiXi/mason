import { MAX_JOIN_MM, outlineEnd, proposeOutlineJoin, type OutlinePoint } from './outline-repair';
import { conflictingOutlineRepairs, type OutlineSeams } from './outline-topology';

export interface OutlineStroke {
  points: OutlinePoint[];
  /** Keep separate Gerber step-and-repeat instances out of each other's candidate set. */
  group?: object;
  /** Outward tangent at an arc endpoint. Straight endpoints use their terminal segment. */
  startTangent?: OutlinePoint;
  endTangent?: OutlinePoint;
}

type Path = OutlinePoint[];
interface Link { target: number; point: OutlinePoint | null; repaired: boolean }
const samePoint = (a: OutlinePoint, b: OutlinePoint) => a[0] === b[0] && a[1] === b[1];

export function stitchOutline(strokes: OutlineStroke[]) {
  const closed: Path[] = [], open: Path[] = [], parts: OutlineStroke[] = [];
  const groups = new Map<Path, object>();
  function grouped(path: Path, group?: object) {
    if (group) groups.set(path, group);
    return path;
  }
  for (const stroke of strokes) {
    const { points } = stroke;
    if (points.length < 2 || points.some(p => !p.every(Number.isFinite))) continue;
    if (samePoint(points[0], points[points.length - 1])) {
      if (points.length >= 4) closed.push(grouped(points, stroke.group));
    } else {
      // A zero-length D01 may repeat the endpoint we are about to move.
      const distinct = points.filter((p, i) => i === 0 || !samePoint(p, points[i - 1]));
      parts.push(distinct.length === points.length ? stroke : { ...stroke, points: distinct });
    }
  }

  // A stroke owns two endpoints: 2*i is its start, 2*i+1 its end.
  const ends = parts.flatMap(({ points, startTangent, endTangent }) => [
    outlineEnd(points, false, startTangent), outlineEnd(points, true, endTangent),
  ]);
  const links: (Link | undefined)[] = new Array(ends.length);
  const buckets = new Map<string, number[]>();
  const cells = ends.map((end, i) => {
    if (!end) return;
    const [x, y] = end.point;
    const cell = [Math.floor(x / MAX_JOIN_MM), Math.floor(y / MAX_JOIN_MM)];
    const key = cell.join(',');
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i); else buckets.set(key, [i]);
    return cell;
  });

  // Exact authored connectivity wins. Check every eligible inferred partner
  // in one pass so a nearer match cannot hide an ambiguous alternative.
  for (const tolerance of [0, MAX_JOIN_MM]) {
    const reach = tolerance === 0 ? 0 : 1;
    const candidates = ends.map((end, i): Link | undefined => {
      if (!end || links[i]) return;
      const [x, y] = end.point;
      const [cx, cy] = cells[i]!;
      let match: Link | undefined;
      for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
        for (const j of buckets.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (i === j || links[j] || parts[i >> 1].group !== parts[j >> 1].group) continue;
          // A single straight segment cannot close itself.
          if ((i ^ 1) === j && parts[i >> 1].points.length < 3) continue;
          const other = ends[j]!;
          const gap = Math.hypot(x - other.point[0], y - other.point[1]);
          if (gap > tolerance) continue;
          const join = gap === 0 ? { point: end.point } : proposeOutlineJoin(end, other, gap);
          if (!join) continue;
          if (match) return; // ambiguous junction
          match = { target: j, point: join.point, repaired: gap !== 0 };
        }
      }
      return match;
    });
    candidates.forEach((candidate, i) => {
      if (candidate && candidate.target > i && candidates[candidate.target]?.target === i) {
        links[i] = candidate;
        links[candidate.target] = { ...candidate, target: i };
      }
    });
  }

  const repaired = new Map<Path, OutlineSeams>();
  const unfinishedStrokes: Path[] = [];
  const visited = new Set<number>();
  function trace(start: number) {
    if (visited.has(start >> 1)) return;
    const path = grouped([], parts[start >> 1].group);
    const unfinished = !links[start];
    const seams: OutlineSeams | undefined = unfinished ? undefined : new Map();
    const append = (p: OutlinePoint, oldFrom?: OutlinePoint, oldTo?: OutlinePoint) => {
      const last = path[path.length - 1];
      if (last && samePoint(last, p)) return;
      if (seams && last && (!oldFrom || !oldTo || !samePoint(last, oldFrom) || !samePoint(p, oldTo))) {
        seams.set(path.length - 1, oldFrom && oldTo ? [oldFrom, oldTo] : null);
      }
      path.push(p);
    };
    let entry = start, inferred = false;
    do {
      visited.add(entry >> 1);
      const { points } = parts[entry >> 1];
      if (unfinished) unfinishedStrokes.push(points);
      const reverse = (entry & 1) !== 0;
      const exit = links[entry ^ 1];
      let previous: OutlinePoint | undefined;
      for (let i = 0; i < points.length; i++) {
        const original = points[reverse ? points.length - 1 - i : i];
        const join = i === 0 ? links[entry] : i === points.length - 1 ? exit : undefined;
        append(join?.point ?? original, previous, original);
        previous = original;
      }
      if (exit?.repaired) inferred = true;
      entry = exit?.target ?? -1;
    } while (entry !== -1 && entry !== start);
    if (entry === -1) open.push(path);
    else {
      append(path[0]);
      if (path.length < 4) return;
      if (inferred && seams) repaired.set(path, seams);
      else closed.push(path);
    }
  }

  // Trace chains from their free ends before visiting the remaining cycles.
  for (let i = 0; i < links.length; i++) if (!links[i]) trace(i);
  parts.forEach((_, i) => trace(2 * i));
  const invalid = conflictingOutlineRepairs(closed, repaired, unfinishedStrokes);
  for (const path of repaired.keys()) {
    if (invalid.has(path)) open.push(path);
    else closed.push(path);
  }
  return { closed, open, groups };
}
