import { describe, expect, it } from 'vitest';
import { canAppendReliefVertex, createReliefPolygon, drawReliefRegion, fitReliefView, isValidReliefPolygon, moveReliefRegion, reliefHandleSize,
  reliefScreenPoint, reliefRegionIntersectsBoard, reliefRegionsInMarquee, resizeReliefRegion, updateReliefDimensions, updateReliefVertex,
  zoomReliefView } from '../component-relief-editor';
import { MAX_RELIEF_VERTICES } from '../component-relief';
import type { ComponentReliefRegion } from '../component-relief';

const bounds = { minX: -25, minY: -15, maxX: 25, maxY: 15 };
const region = { id: 'r1', shape: 'rect' as const, x: 5, y: 3, width: 8, height: 6 };

describe('component relief marquee selection', () => {
  it('selects a subset in input order in either drag direction without modifying region data', () => {
    const polygon = { ...createReliefPolygon([[1, 1], [3, 1], [2, 3]], 'polygon', 7)!, through: true };
    const regions: ComponentReliefRegion[] = [
      { id: 'outside', shape: 'rect', x: 20, y: 20, width: 2, height: 2, depth: 4 },
      polygon,
      { id: 'circle', shape: 'circle', x: -2, y: -2, width: 2, height: 2, depth: 2 },
      { id: 'rect', shape: 'rect', x: 0, y: 0, width: 2, height: 2, depth: 3 },
    ];
    const before = JSON.stringify(regions);
    const a = { x: -4, y: -4 }, b = { x: 4, y: 4 };
    expect(reliefRegionsInMarquee(regions, a, b)).toEqual(['polygon', 'circle', 'rect']);
    expect(reliefRegionsInMarquee(regions, b, a)).toEqual(['polygon', 'circle', 'rect']);
    expect(reliefRegionsInMarquee(regions, { x: -30, y: -30 }, { x: 30, y: 30 }))
      .toEqual(regions.map(item => item.id));
    expect(JSON.stringify(regions)).toBe(before);
    expect(regions[1]).toBe(polygon);
  });

  it('finds containment in either direction and crossing edges without containing a polygon vertex', () => {
    const strip = createReliefPolygon([[-5, -0.5], [5, -0.5], [5, 0.5], [-5, 0.5]], 'strip')!;
    const enclosing = createReliefPolygon([[-8, -8], [8, -8], [8, 8], [-8, 8]], 'enclosing')!;
    const inside = createReliefPolygon([[-0.5, -0.5], [0.5, -0.5], [0, 0.5]], 'inside')!;
    const circle: ComponentReliefRegion = { id: 'circle', shape: 'circle', x: 0, y: 0, width: 10, height: 10 };
    expect(reliefRegionsInMarquee([strip, enclosing, inside, circle], { x: -1, y: -2 }, { x: 1, y: 2 }))
      .toEqual(['strip', 'enclosing', 'inside', 'circle']);
  });

  it('does not select empty corners of a circle or a concave polygon bounding box', () => {
    const circle: ComponentReliefRegion = { id: 'circle', shape: 'circle', x: 0, y: 0, width: 10, height: 10 };
    const concave = createReliefPolygon([[-5, -5], [5, -5], [5, -3], [-3, -3], [-3, 5], [-5, 5]], 'concave')!;
    expect(reliefRegionsInMarquee([circle], { x: 4, y: 4 }, { x: 5, y: 5 })).toEqual([]);
    expect(reliefRegionsInMarquee([concave], { x: -2, y: -2 }, { x: 2, y: 2 })).toEqual([]);
    expect(reliefRegionsInMarquee([circle], { x: 3, y: 3 }, { x: 4, y: 4 })).toEqual(['circle']);
    expect(reliefRegionsInMarquee([concave], { x: -4, y: 0 }, { x: -2, y: 1 })).toEqual(['concave']);
  });

  it('includes edge and vertex touches regardless of polygon winding', () => {
    const polygon = createReliefPolygon([[0, 0], [4, 0], [0, 4]], 'polygon')!;
    const reverse = createReliefPolygon([...polygon.points!].reverse(), 'reverse')!;
    const circle: ComponentReliefRegion = { id: 'circle', shape: 'circle', x: 0, y: 0, width: 8, height: 8 };
    const rect: ComponentReliefRegion = { id: 'rect', shape: 'rect', x: 0, y: 0, width: 8, height: 8 };
    expect(reliefRegionsInMarquee([polygon, reverse, circle, rect], { x: 4, y: 0 }, { x: 6, y: 2 }))
      .toEqual(['polygon', 'reverse', 'circle', 'rect']);
  });

  it('uses canonical board coordinates after the pointer is converted from either viewing side', () => {
    const regions: ComponentReliefRegion[] = [{ id: 'upper', shape: 'rect', x: 2, y: 7, width: 2, height: 2 },
      { id: 'lower', shape: 'rect', x: 2, y: -7, width: 2, height: 2 }];
    for (const side of ['top', 'bottom'] as const) {
      const screenStart = reliefScreenPoint({ x: 0, y: 5 }, side);
      const screenEnd = reliefScreenPoint({ x: 4, y: 9 }, side);
      expect(reliefRegionsInMarquee(regions, reliefScreenPoint(screenStart, side), reliefScreenPoint(screenEnd, side)))
        .toEqual(['upper']);
    }
  });

  it('ignores non-finite drags and malformed geometry', () => {
    expect(reliefRegionsInMarquee([region], { x: NaN, y: 0 }, { x: 8, y: 8 })).toEqual([]);
    const invalid: ComponentReliefRegion[] = [{ ...region, width: -1 },
      { ...region, shape: 'circle', width: 0 }, { ...region, shape: 'polygon', points: [] }];
    expect(reliefRegionsInMarquee(invalid, { x: -20, y: -20 }, { x: 20, y: 20 })).toEqual([]);
  });
});

describe('component relief editing coordinates', () => {
  it('keeps eight-pixel grips for either meet-fit axis and resized viewports', () => {
    const tall = { x: 0, y: 0, width: 20, height: 200 };
    expect(reliefHandleSize(tall, 600, 400)).toBe(4);
    expect(reliefHandleSize(tall, 300, 200)).toBe(8);
    const wide = { x: 0, y: 0, width: 200, height: 20 };
    expect(reliefHandleSize(wide, 400, 600)).toBe(4);
    expect(reliefHandleSize(wide, 200, 300)).toBe(8);
  });

  it('mirrors only the displayed side and round-trips pointer coordinates', () => {
    const point = { x: 8, y: 3 };
    expect(reliefScreenPoint(point, 'top')).toEqual({ x: 8, y: -3 });
    expect(reliefScreenPoint(point, 'bottom')).toEqual(point);
    expect(reliefScreenPoint(reliefScreenPoint(point, 'top'), 'top')).toEqual(point);
    const fit = fitReliefView({ minX: -8, maxX: 25, minY: -4, maxY: 15 }, 'bottom');
    expect(fit.y).toBeLessThan(-4);
    expect(fit.y + fit.height).toBeGreaterThan(15);
  });

  it('draws backwards, clamps to the board bounds, and rejects tiny accidental drags', () => {
    expect(drawReliefRegion('rect', { x: 20, y: 10 }, { x: -40, y: -20 }, bounds, 'r2'))
      .toEqual({ id: 'r2', shape: 'rect', x: -2.5, y: -2.5, width: 45, height: 25 });
    expect(drawReliefRegion('rect', { x: 0, y: 0 }, { x: 0.2, y: 8 }, bounds, 'r2')).toBeNull();
    const circle = drawReliefRegion('circle', { x: 10, y: 10 }, { x: -5, y: 4 }, bounds, 'r3');
    expect(circle).toEqual({ id: 'r3', shape: 'circle', x: 7, y: 7, width: 6, height: 6 });
  });

  it('moves the full region inside the board without changing size', () => {
    expect(moveReliefRegion(region, { x: 50, y: -50 }, bounds))
      .toEqual({ ...region, x: 21, y: -12 });
    expect(region.x).toBe(5);
  });

  it('resizes around the opposite corner and maintains circular geometry', () => {
    const resized = resizeReliefRegion(region, 'ne', { x: 20, y: 12 }, bounds);
    expect(resized).toEqual({ ...region, x: 10.5, y: 6, width: 19, height: 12 });
    const circle = resizeReliefRegion({ ...region, shape: 'circle', width: 6 }, 'sw', { x: -50, y: -50 }, bounds);
    expect(circle.width).toBe(circle.height);
    expect(circle.x + circle.width / 2).toBe(8);
    expect(circle.y + circle.height / 2).toBe(6);
  });

  it('clamps numerical edits and invalid values without allowing an ellipse', () => {
    expect(updateReliefDimensions(region, { width: 100, y: Infinity }, bounds))
      .toEqual({ ...region, x: 0, width: 50 });
    expect(updateReliefDimensions({ ...region, shape: 'circle', width: 6 }, { width: 50 }, bounds))
      .toEqual({ ...region, shape: 'circle', x: 5, y: 0, width: 30, height: 30 });
  });

  it('keeps the pointer anchor stationary when zooming and limits excessive zoom', () => {
    const fit = fitReliefView(bounds, 'top');
    const anchor = { x: 7, y: -3 };
    const zoomed = zoomReliefView(fit, anchor, 2, fit);
    expect((anchor.x - fit.x) / fit.width).toBeCloseTo((anchor.x - zoomed.x) / zoomed.width);
    expect((anchor.y - fit.y) / fit.height).toBeCloseTo((anchor.y - zoomed.y) / zoomed.height);
    expect(zoomReliefView(fit, anchor, 1000, fit).width).toBe(fit.width / 20);
  });

  it('rejects concave empty corners, internal holes and boundary-only touches', () => {
    const outline: Array<[number, number]> = [[-20, -20], [20, -20], [20, -5], [-5, -5], [-5, 20], [-20, 20]];
    const holes: Array<Array<[number, number]>> = [[[-18, -18], [-10, -18], [-10, -10], [-18, -10]]];
    const check = (x: number, y: number, size = 4, shape: 'rect' | 'circle' = 'rect') =>
      reliefRegionIntersectsBoard({ id: 'r', shape, x, y, width: size, height: size }, outline, holes, 40, 40);
    expect(check(8, 8)).toBe(false);
    expect(check(-14, -14)).toBe(false);
    expect(check(-8, -14)).toBe(true);
    expect(check(-8, -14, 4, 'circle')).toBe(true);
    expect(check(-8, 5, 6)).toBe(true); // within the vertical L leg
    expect(check(-2, 5, 6)).toBe(false); // only touches the leg at x=-5
    expect(check(-2, 5, 6, 'circle')).toBe(false);
    expect(check(-2.2, 5, 6, 'circle')).toBe(true); // tiny circular overlap is real
    expect(check(-20, 0)).toBe(true); // crossing the outside outline is clipped
  });

  it('closes a simple concave polygon and derives its bounds from a copied point list', () => {
    const points: Array<[number, number]> = [[-5, -3], [5, -3], [5, 0], [0, 0], [0, 5], [-5, 5], [-5, -3]];
    const polygon = createReliefPolygon(points, 'poly')!;
    expect(polygon).toMatchObject({ shape: 'polygon', x: 0, y: 1, width: 10, height: 8 });
    expect(polygon.points).toHaveLength(6);
    expect(createReliefPolygon([...polygon.points!].reverse(), 'reverse')).not.toBeNull();
    points[0][0] = -100;
    expect(polygon.points![0]).toEqual([-5, -3]);
  });

  it('rejects crossed, touching, folded, degenerate and oversized polygon outlines', () => {
    expect(createReliefPolygon([[0, 0], [5, 5], [0, 5], [5, 0]], 'crossed')).toBeNull();
    expect(createReliefPolygon([[0, 0], [5, 0], [5, 5], [2, 0], [0, 5]], 'touch')).toBeNull();
    expect(createReliefPolygon([[0, 0], [5, 0], [2, 0], [5, 5], [0, 5]], 'fold')).toBeNull();
    expect(createReliefPolygon([[0, 0], [5, 0], [10, 0]], 'line')).toBeNull();
    expect(createReliefPolygon([[0, 0], [Infinity, 0], [0, 5]], 'infinite')).toBeNull();
    const circle = (count: number): Array<[number, number]> => Array.from({ length: count }, (_, i) =>
      [10 * Math.cos(i / count * 2 * Math.PI), 10 * Math.sin(i / count * 2 * Math.PI)]);
    expect(createReliefPolygon(circle(MAX_RELIEF_VERTICES), 'limit')).not.toBeNull();
    expect(createReliefPolygon(circle(MAX_RELIEF_VERTICES + 1), 'too-many')).toBeNull();
  });

  it('checks open polygon additions without accepting an intersecting or repeated edge', () => {
    const points: Array<[number, number]> = [[-5, -5], [5, -5], [5, 5]];
    expect(canAppendReliefVertex(points, [-5, 5])).toBe(true);
    expect(canAppendReliefVertex(points, [5, 5])).toBe(false);
    expect(canAppendReliefVertex(points, [0, -10])).toBe(false);
    expect(canAppendReliefVertex(points, [5, -3])).toBe(false);
    expect(canAppendReliefVertex([], [NaN, 0])).toBe(false);
  });

  it('moves and scales polygon vertices with the box while keeping the source immutable', () => {
    const polygon = createReliefPolygon([[1, 0], [9, 0], [9, 6], [5, 3], [1, 6]], 'poly')!;
    const original = JSON.stringify(polygon);
    const moved = moveReliefRegion(polygon, { x: 100, y: -100 }, bounds);
    expect(moved).toMatchObject({ x: 21, y: -12, width: 8, height: 6 });
    expect(moved.points![0]).toEqual([17, -15]);
    const resized = resizeReliefRegion(polygon, 'ne', { x: 17, y: 12 }, bounds);
    expect(resized).toMatchObject({ x: 9, y: 6, width: 16, height: 12 });
    expect(resized.points![3]).toEqual([9, 6]);
    const numeric = updateReliefDimensions(polygon, { width: 16, y: 6 }, bounds);
    expect(numeric.points![0]).toEqual([-3, 3]);
    expect(numeric.points![2]).toEqual([13, 9]);
    expect(isValidReliefPolygon(numeric.points!)).toBe(true);
    expect(JSON.stringify(polygon)).toBe(original);
  });

  it('retains full-precision merged geometry when a number field repeats its current value', () => {
    const polygon: ComponentReliefRegion = { id: 'merged', shape: 'polygon', x: .123456, y: .345678,
      width: 10.246912, height: 8.691356, depth: 3, through: true,
      points: [[-5, -4], [5.246912, -4], [5.246912, 4.691356], [-5, 4.691356]] };
    const original = JSON.stringify(polygon);
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(updateReliefDimensions(polygon, { [key]: polygon[key] }, bounds)).toBe(polygon);
    }
    expect(JSON.stringify(polygon)).toBe(original);
    // Display precision is not equality: a user can intentionally type 0.12.
    const edited = updateReliefDimensions(polygon, { x: .12 }, bounds);
    expect(edited).not.toBe(polygon);
    expect(edited.x).toBe(.12);
    expect(edited).toMatchObject({ depth: 3, through: true });
  });

  it('derives fresh bounds after a vertex edit and exposes invalid edits for rejection', () => {
    const polygon = createReliefPolygon([[0, 0], [8, 0], [8, 6], [0, 6]], 'poly')!;
    const changed = updateReliefVertex(polygon, 2, { x: 12, y: 10 }, bounds);
    expect(changed).toMatchObject({ x: 6, y: 5, width: 12, height: 10 });
    expect(isValidReliefPolygon(changed.points!)).toBe(true);
    const crossed = updateReliefVertex(polygon, 1, { x: -3, y: 3 }, bounds);
    expect(isValidReliefPolygon(crossed.points!)).toBe(false);
    expect(polygon.points![1]).toEqual([8, 0]);
  });

  it('materializes a requested creation depth and preserves it through every shape edit', () => {
    const polygon = createReliefPolygon([[0, 0], [8, 0], [8, 6], [0, 6]], 'poly-depth', 7.5)!;
    expect(polygon.depth).toBe(7.5);
    const edits = [moveReliefRegion(polygon, { x: 2, y: 1 }, bounds),
      resizeReliefRegion(polygon, 'ne', { x: 12, y: 10 }, bounds),
      updateReliefDimensions(polygon, { width: 12, y: 4 }, bounds),
      updateReliefVertex(polygon, 2, { x: 9, y: 7 }, bounds)];
    expect(edits.every(edited => edited.depth === 7.5)).toBe(true);
    edits[0].points![0][0] = -100;
    expect(polygon.points![0]).toEqual([0, 0]);
    for (const shape of ['rect', 'circle'] as const) {
      const created = drawReliefRegion(shape, { x: 0, y: 0 }, { x: 4, y: 4 }, bounds, shape, 5)!;
      expect(created.depth).toBe(5);
      expect(moveReliefRegion(created, { x: 1, y: 1 }, bounds).depth).toBe(5);
      expect(resizeReliefRegion(created, 'ne', { x: 6, y: 6 }, bounds).depth).toBe(5);
      expect(updateReliefDimensions(created, { width: 6 }, bounds).depth).toBe(5);
    }
  });

  it('preserves through cuts and their remembered depth through all shape edits', () => {
    const polygon = { ...createReliefPolygon([[0, 0], [8, 0], [8, 6], [0, 6]], 'through-poly', 7.5)!, through: true };
    const edits = [moveReliefRegion(polygon, { x: 2, y: 1 }, bounds),
      resizeReliefRegion(polygon, 'ne', { x: 12, y: 10 }, bounds),
      updateReliefDimensions(polygon, { width: 12, y: 4 }, bounds),
      updateReliefVertex(polygon, 2, { x: 9, y: 7 }, bounds)];
    for (const shape of ['rect', 'circle'] as const) {
      const created = { ...drawReliefRegion(shape, { x: 0, y: 0 }, { x: 4, y: 4 }, bounds, shape, 5)!, through: true };
      edits.push(moveReliefRegion(created, { x: 1, y: 1 }, bounds),
        resizeReliefRegion(created, 'ne', { x: 6, y: 6 }, bounds),
        updateReliefDimensions(created, { width: 6 }, bounds));
    }
    expect(edits.every(edited => edited.through === true && edited.depth !== undefined)).toBe(true);
    expect(edits.slice(0, 4).every(edited => edited.depth === 7.5)).toBe(true);
    expect(polygon.points![0]).toEqual([0, 0]);
  });

  it('uses actual polygon material rather than its bounding box or centre for PCB intersection', () => {
    const board: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const emptyCorner = createReliefPolygon([[-5, -5], [5, -5], [5, -3], [-3, -3], [-3, 5], [-5, 5]], 'L')!;
    expect(emptyCorner.x).toBe(0);
    expect(emptyCorner.y).toBe(0);
    expect(reliefRegionIntersectsBoard(emptyCorner, board, [], 2, 2)).toBe(false);
    const identical = createReliefPolygon(board, 'same')!;
    expect(reliefRegionIntersectsBoard(identical, board, [], 2, 2)).toBe(true);
    const touching = createReliefPolygon([[1, -1], [3, -1], [3, 1], [1, 1]], 'touch')!;
    expect(reliefRegionIntersectsBoard(touching, board, [], 2, 2)).toBe(false);
    // Use a broad slanted strip: every vertex lies outside the small board.
    const strip = createReliefPolygon([[-4, -3], [-3, -4], [4, 3], [3, 4]], 'strip')!;
    expect(reliefRegionIntersectsBoard(strip, board, [], 2, 2)).toBe(true);
  });

  it('rejects a polygon inside an internal hole and accepts a real overlap beyond it', () => {
    const outline: Array<[number, number]> = [[-20, -20], [20, -20], [20, 20], [-20, 20]];
    const hole: Array<[number, number]> = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
    const inHole = createReliefPolygon([[-4, -4], [4, -4], [0, 4]], 'hole')!;
    expect(reliefRegionIntersectsBoard(inHole, outline, [hole], 40, 40)).toBe(false);
    expect(reliefRegionIntersectsBoard(createReliefPolygon(hole, 'same-hole')!, outline, [hole], 40, 40)).toBe(false);
    const crossing = createReliefPolygon([[-4, -4], [6, -4], [0, 4]], 'crossing')!;
    expect(reliefRegionIntersectsBoard(crossing, outline, [hole], 40, 40)).toBe(true);
  });
});
