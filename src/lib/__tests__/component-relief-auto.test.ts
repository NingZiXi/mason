import { describe, expect, it } from 'vitest';
import { generateAutomaticRelief } from '../component-relief-auto';
import { MAX_RELIEF_REGIONS, type ComponentReliefRegion } from '../component-relief';
import { extractPads, type PadPolygon } from '../gerber/pads';

const outline: Array<[number, number]> = [[-50, -40], [50, -40], [50, 40], [-50, 40]];
function pad(x: number, y: number, w = .8, h = 1.2, ref?: string): PadPolygon {
  return { cx: x, cy: y, type: 'rect', polarity: 'D', componentRef: ref,
    parts: [{ polarity: 'D', points: [[x - w / 2, y - h / 2], [x + w / 2, y - h / 2],
      [x + w / 2, y + h / 2], [x - w / 2, y + h / 2]] }] };
}
const auto = (pads: PadPolygon[], existing: ComponentReliefRegion[] = [], allowance = .6) =>
  generateAutomaticRelief(pads, outline, [], 100, 80, existing, allowance);

describe('automatic underside component relief', () => {
  it('groups pins with a known component reference, including the empty body between pin rows', () => {
    const result = auto([pad(-6, 4, .8, 1.2, 'U1'), pad(6, 4, .8, 1.2, 'U1'),
      pad(-6, 10, .8, 1.2, 'U1'), pad(6, 10, .8, 1.2, 'U1'), pad(0, -10, .8, 1.2, 'R1')]);
    expect(result.added).toBe(2);
    expect(result.regions[0]).toMatchObject({ x: 0, y: 7, width: 14, height: 8.4 });
  });

  it('keeps distinct known components separate even when their pads are close', () => {
    expect(auto([pad(0, 0, .5, .5, 'R1'), pad(.8, 0, .5, .5, 'R2')]).added).toBe(2);
  });

  it('infers nearby unlabelled pin pairs without joining distant components', () => {
    const result = auto([pad(-11, 3), pad(-9, 3), pad(9, -3), pad(11, -3)]);
    expect(result.added).toBe(2);
    expect(result.regions[0]).toMatchObject({ x: -10, y: 3, width: 4, height: 2.4 });
    expect(result.regions[1]).toMatchObject({ x: 10, y: -3 });
  });

  it('joins matching opposing IC pin rows, giving the body a continuous pocket', () => {
    const pads = [-3, -2, -1, 0, 1, 2, 3].flatMap(x => [pad(x, -3, .5, 1), pad(x, 3, .5, 1)]);
    const result = auto(pads);
    expect(result.added).toBe(1);
    expect(result.regions[0]).toMatchObject({ x: 0, y: 0, width: 7.7, height: 8.2 });
  });

  it('never mirrors or recentres canonical coordinates', () => {
    expect(auto([pad(12, -8)]).regions[0]).toMatchObject({ x: 12, y: -8 });
  });

  it('is deterministic across Gerber drawing order and adds no duplicates on another click', () => {
    const pads = [pad(-11, 3), pad(11, -3), pad(-9, 3), pad(9, -3)];
    const result = auto(pads);
    expect(auto([...pads].reverse())).toEqual(result);
    expect(auto(pads, result.regions)).toEqual({ ...result, added: 0 });
    const moved = result.regions.map(region => ({ ...region, x: region.x + 3 }));
    expect(auto(pads, moved).added).toBe(0);
  });

  it('preserves manual regions and does not add a candidate already contained in one', () => {
    const manual: ComponentReliefRegion = { id: 'hand-drawn', shape: 'rect', x: -10, y: 3, width: 8, height: 8 };
    const original = JSON.stringify(manual);
    const result = auto([pad(-11, 3), pad(-9, 3), pad(10, -3)], [manual]);
    expect(result.added).toBe(1);
    expect(result.regions[0]).toBe(manual);
    expect(JSON.stringify(manual)).toBe(original);
    expect(result.regions[1].x).toBe(10);
  });

  it('does not confuse the empty corner of a concave manual polygon with covered material', () => {
    const polygon: ComponentReliefRegion = { id: 'L', shape: 'polygon', x: 0, y: 0, width: 12, height: 12,
      points: [[-6, -6], [6, -6], [6, -2], [-2, -2], [-2, 6], [-6, 6]] };
    expect(auto([pad(3, 3)], [polygon]).added).toBe(1);
  });

  it('does not recreate automatic boxes contained in a merged polygon', () => {
    const pads = [pad(-4, 0, .8, 1.2, 'R1'), pad(4, 0, .8, 1.2, 'R2')];
    const polygon: ComponentReliefRegion = { id: 'merged', shape: 'polygon', x: 0, y: 0, width: 10, height: 2.4,
      depth: 3, points: [[-5, -1.2], [5, -1.2], [5, 1.2], [-5, 1.2]] };
    const result = auto(pads, [polygon]);
    expect(result.added).toBe(0);
    expect(result.regions).toEqual([polygon]);
  });

  it('does not skip a proposal spanning a narrow support notch even when all corners are contained', () => {
    const polygon: ComponentReliefRegion = { id: 'notched', shape: 'polygon', x: 0, y: 0, width: 10, height: 10,
      points: [[-5, -5], [5, -5], [5, 5], [.2, 5], [.2, 0], [-.2, 0], [-.2, 5], [-5, 5]] };
    expect(auto([pad(0, 0, 2, 2)], [polygon]).added).toBe(1);
  });

  it('uses the chosen outward allowance for new regions without changing hand-drawn regions', () => {
    const manual: ComponentReliefRegion = { id: 'manual', shape: 'rect', x: -20, y: -20, width: 3, height: 3, depth: 6 };
    const small = auto([pad(0, 0, 2, 1)], [manual], .6);
    const large = auto([pad(0, 0, 2, 1)], [manual], 2);
    expect(small.regions[1]).toMatchObject({ width: 3.2, height: 2.2 });
    expect(large.regions[1]).toMatchObject({ width: 6, height: 5 });
    expect(large.regions[0]).toBe(manual);
  });

  it('ignores clear exposures, explicitly known test points, invalid geometry and non-board pads', () => {
    const clear = { ...pad(0, 0), polarity: 'C' as const };
    const test = { ...pad(4, 0), padRole: 'testpoint' as const };
    const invalid = pad(8, 0); invalid.parts[0].points[0][0] = NaN;
    expect(auto([clear, test, invalid, pad(80, 80), pad(12, 0)]).regions).toHaveLength(1);
    // A deliberately closed paste aperture does not mean the physical component is absent.
    expect(auto([{ ...pad(0, 0), apertureOverride: 'closed' }]).added).toBe(1);
  });

  it('uses the actual board outline and internal cutouts', () => {
    const lBoard: Array<[number, number]> = [[-20, -20], [20, -20], [20, -5], [-5, -5], [-5, 20], [-20, 20]];
    const hole: Array<[number, number]> = [[-17, -3], [-11, -3], [-11, 3], [-17, 3]];
    const result = generateAutomaticRelief([pad(10, 10), pad(-14, 0), pad(-14, 10)], lBoard, [hole], 40, 40, [], .6);
    expect(result.added).toBe(1);
    expect(result.regions[0]).toMatchObject({ x: -14, y: 10 });
  });

  it('includes an offset macro on the PCB even when its flash origin is outside', () => {
    const pads = extractPads([
      '%FSLAX34Y34*%', '%MOMM*%', '%AMOFFSET*21,1,2,1,4,0,0*%', '%ADD10OFFSET*%',
      'D10*', 'X-20000Y50000D03*', 'M02*',
    ].join('\n')).pads;
    const original = JSON.stringify(pads);
    expect(pads[0].cx).toBe(-2);
    const result = generateAutomaticRelief(pads, [[0, 0], [10, 0], [10, 10], [0, 10]], [], 10, 10, []);
    expect(result.added).toBe(1);
    expect(result.regions[0]).toMatchObject({ x: 2, y: 5, width: 3.2, height: 2.2 });
    expect(JSON.stringify(pads)).toBe(original);
  });

  it('includes a concave region whose diagnostic centre is in the PCB notch', () => {
    const lBoard: Array<[number, number]> = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10]];
    const points: Array<[number, number]> = [[.1, .1], [9.9, .1], [9.9, 1.9], [1.9, 1.9], [1.9, 9.9], [.1, 9.9]];
    const region: PadPolygon = { cx: 3.97, cy: 3.97, type: 'region', polarity: 'D',
      parts: [{ polarity: 'D', points }] };
    expect(generateAutomaticRelief([region], lBoard, [], 10, 10, [], 0).added).toBe(1);
  });

  it('does not create a cavity when the PCB lies wholly inside an aperture hole', () => {
    const ring = pad(0, 0, 12, 12);
    ring.parts[0].holes = [[[-4, -4], [4, -4], [4, 4], [-4, 4]]];
    const smallBoard: Array<[number, number]> = [[-3, -3], [3, -3], [3, 3], [-3, 3]];
    expect(generateAutomaticRelief([ring], smallBoard, [], 6, 6, []).added).toBe(0);
  });

  it('clamps allowances to the board bounds and handles outline-free rectangular boards', () => {
    const result = generateAutomaticRelief([pad(9.5, 0)], [], [], 20, 10, [], 1);
    expect(result.regions[0].x + result.regions[0].width / 2).toBeCloseTo(10);
    expect(result.regions[0].y).toBe(0);
    expect(auto([pad(0, 0)], [], NaN)).toEqual(auto([pad(0, 0)]));
  });

  it('respects the region limit without deleting or altering existing user work', () => {
    const existing = Array.from({ length: MAX_RELIEF_REGIONS - 1 }, (_, i): ComponentReliefRegion =>
      ({ id: `manual-${i}`, shape: 'rect', x: -45, y: -35, width: 1, height: 1 }));
    const result = auto([pad(0, 0, .5, .5, 'R1'), pad(10, 0, .5, .5, 'R2')], existing);
    expect(result.added).toBe(1);
    expect(result.limited).toBe(true);
    expect(result.regions).toHaveLength(MAX_RELIEF_REGIONS);
    expect(result.regions.slice(0, -1)).toEqual(existing);
    expect(auto([], existing).limited).toBe(false);
  });

  it('bounds spatial inference on a dense layer instead of creating one giant board pocket', () => {
    const pads = Array.from({ length: 5000 }, (_, i) => pad(-48 + i % 100 * .96, -35 + Math.floor(i / 100) * 1.4, .4, .6));
    const result = auto(pads);
    expect(result.added).toBeGreaterThan(1);
    expect(result.regions.every(region => region.width <= 21.2 && region.height <= 21.2)).toBe(true);
    expect(result.regions.length).toBeLessThanOrEqual(MAX_RELIEF_REGIONS);
  });
});
