import { OUTLINE_EPS_MM, type OutlinePoint } from './outline-repair';

type Path = OutlinePoint[];
// Changed edge index -> original endpoints, or null for an inserted bridge.
export type OutlineSeams = Map<number, [OutlinePoint, OutlinePoint] | null>;

interface Segment {
  a: OutlinePoint;
  b: OutlinePoint;
  dx: number;
  dy: number;
  length: number;
}
interface Edge extends Segment {
  path: Path;
  index: number;
  repair: boolean;
  open: boolean;
  before?: Segment | null;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const EPS = OUTLINE_EPS_MM;
function segment(a: OutlinePoint, b: OutlinePoint): Segment {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return { a, b, dx, dy, length: Math.hypot(dx, dy) };
}

const side = (edge: Segment, point: OutlinePoint) => {
  const d = edge.dx * (point[1] - edge.a[1]) - edge.dy * (point[0] - edge.a[0]);
  return d > EPS * edge.length ? 1 : d < -EPS * edge.length ? -1 : 0;
};

function overlap(a: Edge, b: Edge) {
  if (a.maxY + EPS < b.minY || b.maxY + EPS < a.minY) return false;
  const adjacent = a.path === b.path && (
    Math.abs(a.index - b.index) === 1 || Math.abs(a.index - b.index) === a.path.length - 2
  );
  if (adjacent) {
    // Consecutive edges have one common vertex, but cannot double back on it.
    return a.dx * b.dx + a.dy * b.dy < 0 && side(a, b.a) === 0 && side(a, b.b) === 0;
  }
  return side(a, b.a) * side(a, b.b) <= 0 && side(b, a.a) * side(b, a.b) <= 0;
}

function properlyCross(a: Segment, b: Segment) {
  return side(a, b.a) * side(a, b.b) < 0 && side(b, a.a) * side(b, a.b) < 0;
}

/** Only inferred rings are rejected. Exact contours keep their existing semantics. */
export function conflictingOutlineRepairs(known: Path[], repairs: Map<Path, OutlineSeams>, unfinished: Path[]): Set<Path> {
  const invalid = new Set<Path>();
  if (!repairs.size) return invalid;
  const edges: Edge[] = [];
  function addPath(path: Path, open: boolean, seams?: OutlineSeams) {
    let twiceArea = 0;
    const [ox, oy] = path[0];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const edge = segment(a, b);
      if (seams) twiceArea += (a[0] - ox) * (b[1] - oy) - (a[1] - oy) * (b[0] - ox);
      if (edge.length <= EPS) continue;
      const before = seams?.get(i - 1);
      edges.push({ ...edge, path, repair: !!seams, open, index: i - 1,
        before: before ? segment(...before) : before,
        minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]),
        minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
    }
    if (seams && Math.abs(twiceArea) <= 2e-6) invalid.add(path);
  }
  known.forEach(path => addPath(path, false));
  repairs.forEach((seams, path) => addPath(path, false, seams));
  unfinished.forEach(path => addPath(path, true));

  // Sweep by X so distant edges (e.g. boards repeated across a panel) are not
  // compared. Two inferred rings that touch are both uncertain, irrespective of order.
  edges.sort((a, b) => a.minX - b.minX);
  const activeRings: Edge[] = [], activeSeams: Edge[] = [], activeOpen: Edge[] = [];
  function compare(edge: Edge, active: Edge[], check: (edge: Edge, other: Edge) => void) {
    for (let i = active.length - 1; i >= 0; i--) {
      const other = active[i];
      if (other.maxX + EPS < edge.minX) {
        active[i] = active[active.length - 1];
        active.pop();
      } else check(edge, other);
    }
  }
  function checkRings(edge: Edge, other: Edge) {
    if ((edge.repair || other.repair) && overlap(edge, other)) {
      if (edge.repair) invalid.add(edge.path);
      if (other.repair) invalid.add(other.path);
    }
  }
  function checkSeam(seam: Edge, stroke: Edge) {
    // Reject only a new proper crossing caused by stitching. The same crossing
    // on the original segment, or contact at an endpoint, is not a new crossing.
    if (seam.maxY < stroke.minY || stroke.maxY < seam.minY) return;
    if (properlyCross(seam, stroke) && (!seam.before || !properlyCross(seam.before, stroke))) {
      invalid.add(seam.path);
    }
  }
  const checkStroke = (stroke: Edge, seam: Edge) => checkSeam(seam, stroke);
  for (const edge of edges) {
    if (edge.open) {
      compare(edge, activeSeams, checkStroke);
      activeOpen.push(edge);
    } else {
      compare(edge, activeRings, checkRings);
      activeRings.push(edge);
      if (edge.before !== undefined) {
        compare(edge, activeOpen, checkSeam);
        activeSeams.push(edge);
      }
    }
  }
  return invalid;
}
