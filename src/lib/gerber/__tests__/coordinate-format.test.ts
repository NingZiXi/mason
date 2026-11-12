import { describe, expect, it } from 'vitest';
import { computeBbox } from '../bbox';
import { extractOutline, parseGerber } from '../parser';
import { extractPads } from '../pads';

const header = (zero = 'L', units = 'MM') => `%FS${zero}AX24Y24*%\n%MO${units}*%\n%ADD10C,0.5*%\nD10*\n`;
const rectangle = (negativeX: string, positiveX: string, negativeY: string, positiveY: string) => [
  `X${negativeX}Y${negativeY}D02*`, `X${positiveX}Y${negativeY}D01*`,
  `X${positiveX}Y${positiveY}D01*`, `X${negativeX}Y${positiveY}D01*`,
  `X${negativeX}Y${negativeY}D01*`, 'M02*',
].join('\n');

// Ucamco Gerber 2026.05 §8.2.1.1: legacy FST coordinates omit zeros on
// the right; their sign is outside the FS digit count. The decoder also
// supports signed explicit decimals without fixed-point padding.
describe('Gerber coordinate notation', () => {
  it('gives trailing-zero and full-width contours the same dimensions and bbox', () => {
    const trailing = header('T') + rectangle('-1', '+1', '-2', '+2');
    const full = header('L') + rectangle('-100000', '100000', '-200000', '200000');
    expect(extractOutline(trailing)).toEqual(extractOutline(full));
    expect(computeBbox(parseGerber(trailing))).toEqual(computeBbox(parseGerber(full)));
    expect(extractOutline(trailing).bbox).toMatchObject({ minX: -10, minY: -20, maxX: 10, maxY: 20 });
  });

  it.each(['L', 'T'])('accepts full-width fixed-point numbers with %s suppression', zero => {
    const result = extractPads(header(zero) + 'X-100000Y200000D03*\nM02*');
    expect(result.pads.map(pad => [pad.cx, pad.cy])).toEqual([[-10, 20]]);
  });

  it.each(['L', 'T'])('decodes signed explicit decimal values independently of %s suppression', zero => {
    const result = extractPads(header(zero) + 'X+1.25Y-.5D03*\nM02*');
    expect(result.pads.map(pad => [pad.cx, pad.cy])).toEqual([[1.25, -.5]]);
    const outline = extractOutline(header(zero) + rectangle('-1.25', '+1.25', '-.5', '+.5'));
    expect(outline.bbox).toMatchObject({ minX: -1.25, maxX: 1.25, minY: -.5, maxY: .5 });
  });

  it('decodes trailing-zero inches before converting both axes to millimetres', () => {
    const result = extractPads(header('T', 'IN') + 'X-001Y+0025D03*\nM02*');
    expect(result.pads[0].cx).toBeCloseTo(-2.54);
    expect(result.pads[0].cy).toBeCloseTo(6.35);
    const outline = extractOutline(header('T', 'IN') + rectangle('-001', '001', '-0025', '0025'));
    expect(outline.bbox.minX).toBeCloseTo(-2.54);
    expect(outline.bbox.maxY).toBeCloseTo(6.35);
  });

  it('keeps omitted axes at their already-decoded modal position', () => {
    const result = extractPads(header('T') + 'X1Y-2D03*\nX+2D03*\nY3D03*\nM02*');
    expect(result.pads.map(pad => [pad.cx, pad.cy])).toEqual([[10, -20], [20, -20], [20, 30]]);
    const resultOutline = parseGerber(header('T') + 'X1Y-2D02*\nX+2D01*\nY3D01*\nM02*');
    expect(resultOutline.commands.map(cmd => [cmd.x, cmd.y])).toEqual([[100000, -200000], [200000, -200000], [200000, 300000]]);
  });

  it.each([
    ['X1Y0D02*\nG03X1Y2I-1J1D01*', 'X100000Y0D02*\nG03X100000Y200000I-100000J100000D01*'],
    ['X1Y1D02*\nG02X2Y0I0J-1D01*', 'X100000Y100000D02*\nG02X200000Y0I0J-100000D01*'],
  ])('decodes signed I/J offsets consistently for contours and paste arcs', (short, full) => {
    const trailing = header('T') + short + '\nM02*', ordinary = header('L') + full + '\nM02*';
    expect(extractOutline(trailing)).toEqual(extractOutline(ordinary));
    expect(extractPads(trailing)).toEqual(extractPads(ordinary));
  });

  it('uses the same explicit-decimal arc offsets for contours and paste', () => {
    const decimals = header('T') + 'X1.0Y0D02*\nG03X1.0Y2.0I-1.0J1.0D01*\nM02*';
    const fixed = header('L') + 'X10000Y0D02*\nG03X10000Y20000I-10000J10000D01*\nM02*';
    expect(extractOutline(decimals)).toEqual(extractOutline(fixed));
    expect(extractPads(decimals)).toEqual(extractPads(fixed));
  });

  it('retains leading-zero and undeclared-format behaviour', () => {
    expect(extractPads(header('L') + 'X1Y2D03*\nM02*').pads.map(pad => [pad.cx, pad.cy])).toEqual([[.0001, .0002]]);
    const withoutFS = '%MOMM*%\n%ADD10C,0.5*%\nD10*\nX1000000Y-2000000D03*\nM02*';
    expect(extractPads(withoutFS).pads.map(pad => [pad.cx, pad.cy])).toEqual([[1, -2]]);
    expect(parseGerber(withoutFS.replace('D03*', 'D02*')).commands[0]).toMatchObject({ x: 1000000, y: -2000000 });
  });
});
