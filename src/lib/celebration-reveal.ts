type Point = { x: number; y: number };
type Rect = { left: number; top: number; width: number; height: number };

export type RevealJob = {
  kind: 'paint' | 'edge' | 'accent';
  rect: Rect;
  points: Point[];
  width: number;
  start: number;
  duration: number;
};

const EMPTY_PATH = "path('M0 0Z')";
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Sutherland–Hodgman clipping keeps every brush polygon inside its panel. */
function clipPolygon(points: Point[], rect: Rect): Point[] {
  type Boundary = { axis: 'x' | 'y'; value: number; minimum: boolean };
  const boundaries: Boundary[] = [
    { axis: 'x', value: rect.left, minimum: true },
    { axis: 'x', value: rect.left + rect.width, minimum: false },
    { axis: 'y', value: rect.top, minimum: true },
    { axis: 'y', value: rect.top + rect.height, minimum: false },
  ];
  let polygon = points;
  for (const { axis, value, minimum } of boundaries) {
    const input = polygon;
    polygon = [];
    if (!input.length) break;
    const inside = (point: Point) => minimum ? point[axis] >= value : point[axis] <= value;
    let previous = input[input.length - 1];
    for (const current of input) {
      if (inside(current) !== inside(previous)) {
        const fraction = (value - previous[axis]) / (current[axis] - previous[axis]);
        polygon.push({
          x: previous.x + (current.x - previous.x) * fraction,
          y: previous.y + (current.y - previous.y) * fraction,
        });
      }
      if (inside(current)) polygon.push(current);
      previous = current;
    }
  }
  return polygon;
}

function rectangle(rect: Rect): Point[] {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.left + rect.width, y: rect.top },
    { x: rect.left + rect.width, y: rect.top + rect.height },
    { x: rect.left, y: rect.top + rect.height },
  ];
}

function cap(point: Point, radius: number): Point[] {
  return Array.from({ length: 8 }, (_, index) => {
    const angle = index * Math.PI / 4;
    return { x: point.x + Math.cos(angle) * radius, y: point.y + Math.sin(angle) * radius };
  });
}

/**
 * Reveal only the area already crossed by the crew. Filled, consistently wound
 * polygons form a union under CSS path()'s nonzero rule, including overlapping
 * passes and their round caps. SVG clipPath strokes would not reveal any area.
 */
export function celebrationClipPath(
  jobs: readonly RevealJob[],
  elapsed: number,
  viewport: { width: number; height: number },
): string {
  if (!Number.isFinite(elapsed) || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
    || viewport.width <= 0 || viewport.height <= 0) return EMPTY_PATH;
  const viewportRect = { left: 0, top: 0, width: viewport.width, height: viewport.height };
  const polygons: Point[][] = [];
  const add = (points: Point[], bounds: Rect) => {
    const clipped = clipPolygon(clipPolygon(points, bounds), viewportRect);
    if (clipped.length >= 3) polygons.push(clipped);
  };

  for (const job of jobs) {
    if (![job.start, job.duration, job.width, job.rect.left, job.rect.top, job.rect.width, job.rect.height].every(Number.isFinite)
      || job.points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))
      || elapsed <= job.start || job.duration <= 0 || job.rect.width <= 0 || job.rect.height <= 0) continue;
    const progress = clamp((elapsed - job.start) / job.duration);
    if (job.kind === 'accent') {
      const width = job.rect.width * progress, height = job.rect.height * progress;
      add(rectangle({
        left: job.rect.left + (job.rect.width - width) / 2,
        top: job.rect.top + (job.rect.height - height) / 2,
        width, height,
      }), job.rect);
      continue;
    }

    const points = job.points.map(point => ({ x: point.x + job.rect.left, y: point.y + job.rect.top }));
    const lengths = points.map((point, index) => index
      ? Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) : 0);
    let remaining = lengths.reduce((total, length) => total + length, 0) * progress;
    const radius = Math.max(0, job.width / 2);
    if (points.length && radius > 0) add(cap(points[0], radius), job.rect);
    for (let index = 1; index < points.length && remaining > 0; index++) {
      const length = lengths[index];
      if (length === 0) continue;
      const first = points[index - 1], destination = points[index];
      const travelled = Math.min(remaining, length), fraction = travelled / length;
      const last = { x: first.x + (destination.x - first.x) * fraction, y: first.y + (destination.y - first.y) * fraction };
      const normal = { x: -(destination.y - first.y) / length * radius, y: (destination.x - first.x) / length * radius };
      if (radius > 0) {
        add([
          { x: first.x + normal.x, y: first.y + normal.y },
          { x: first.x - normal.x, y: first.y - normal.y },
          { x: last.x - normal.x, y: last.y - normal.y },
          { x: last.x + normal.x, y: last.y + normal.y },
        ], job.rect);
        add(cap(last, radius), job.rect);
      }
      remaining -= travelled;
    }

    // The frame is drawn first. Its workspace is unveiled only after the
    // outline has closed, never while a cursor is still tracing its edges.
    if (job.kind === 'edge') {
      const fill = clamp((elapsed - job.start - job.duration) / 500);
      if (fill > 0) add(rectangle({
        ...job.rect, top: job.rect.top + job.rect.height * (1 - fill), height: job.rect.height * fill,
      }), job.rect);
    }
  }

  // A final tidy-up covers small gaps between surfaces after all workers
  // have finished, rather than exposing the untouched viewport at the start.
  const cleanup = clamp((elapsed - 4100) / 700);
  if (cleanup > 0) add(rectangle({
    ...viewportRect, top: viewport.height * (1 - cleanup), height: viewport.height * cleanup,
  }), viewportRect);

  if (!polygons.length) return EMPTY_PATH;
  const number = (value: number) => String(Math.round(value * 1000) / 1000);
  return `path('${polygons.map(polygon => polygon.map((point, index) =>
    `${index ? 'L' : 'M'}${number(point.x)} ${number(point.y)}`).join(' ') + 'Z').join(' ')}')`;
}
