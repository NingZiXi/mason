import { describe, expect, it } from 'vitest';
import { applyFlyingProbeRoles } from '../flying-probe';
import { extractPads, type PadPolygon } from '../pads';

const components = ['COMPONENT_NAME', 'LAYER', 'X_COORDINATE', 'Y_COORDINATE'];
const fields = ['PIN_NAME', 'PIN_X', 'PIN_Y', 'LAYER', 'PIN_TYPE', 'NET_NAME', 'PAD_SHAPE', 'PAD_SIZEX', 'PAD_SIZEY', 'HOLE_SIZE', 'HOLE_LEN'];
const report = (rows: unknown[][], pins: unknown[][], lengthUnit = 'mm') => ({ lengthUnit,
  components: { fields: components, rows }, pins: { fields, rows: pins } });
const pin = (name: string, x = 0, y = 0, net = name.split('_')[0], layer = 'T') => [name, x, y, layer, 'SMD', net, 'C', 1.8, 1.8, 0, 0];
const circle = (x = 0, y = 0): PadPolygon => extractPads(`%FSLAX45Y45*%\n%MOMM*%\n%ADD10C,1.8*%\nD10*\nX${Math.round(x * 100000)}Y${Math.round(y * 100000)}D03*\nM02*`).pads[0];

describe('manufacturing netlist test-pad evidence', () => {
  it('identifies nearby single-pin test pads named after a net without changing their geometry', () => {
    const pads = [circle(-4), circle(0), circle(4)];
    const geometry = JSON.stringify(pads.map(p => p.parts));
    const metadata = report([['3V3', 'T', -4, 0], ['5V', 'T', 0, 0], ['TEMP', 'T', 4, 0]],
      [pin('3V3_1', -4), pin('5V_1', 0, 0, '5V_SYS'), pin('TEMP_1', 4)]);
    applyFlyingProbeRoles(pads, [], metadata);
    expect(pads.map(p => [p.padRole, p.padRoleSource])).toEqual(Array(3).fill(['testpoint', 'flying-probe']));
    expect(JSON.stringify(pads.map(p => p.parts))).toBe(geometry);
  });
  it('matches mil coordinates, component references with underscores and the correct side', () => {
    const top = [circle(2.54)], bottom = [circle(2.54)];
    const row = pin('TP_SIGNAL_1', 100, 0, 'SIGNAL', 'B'); row[7] = row[8] = 1.8 / .0254;
    applyFlyingProbeRoles(top, bottom, report([['TP_SIGNAL', 'B', 100, 0]], [row], 'mil'));
    expect(top[0].padRole).toBeUndefined();
    expect(bottom[0].padRole).toBe('testpoint');
  });
  it('does not treat multi-pin connectors or ordinary single-pin contacts as test pads', () => {
    const pads = [circle(0), circle(2.54), circle(5.08), circle(10), circle(14)];
    applyFlyingProbeRoles(pads, [], report([['J1', 'T', 0, 0], ['J2', 'T', 10, 0], ['PAD9', 'T', 14, 0]],
      [pin('J1_1', 0), pin('J1_2', 2.54), pin('J1_3', 5.08), pin('J2_1', 10, 0, 'POWER'), pin('PAD9_1', 14, 0, 'PAD9_1')]));
    expect(pads.every(p => p.padRole === undefined)).toBe(true);
  });
  it.each(['drill', 'slot', 'throughHole', 'size', 'position', 'shape', 'unit', 'duplicate', 'emptyNet'])(
    'rejects insufficient or conflicting evidence: %s', kind => {
      const pads = [circle()];
      const row = pin('TP1_1');
      const data = report([['TP1', 'T', 0, 0]], [row]);
      if (kind === 'drill') row[9] = .5;
      if (kind === 'slot') row[10] = .5;
      if (kind === 'throughHole') row[4] = 'DIP';
      if (kind === 'size') row[7] = row[8] = 1.5;
      if (kind === 'position') row[1] = .1;
      if (kind === 'shape') row[6] = 'R';
      if (kind === 'unit') data.lengthUnit = 'unknown';
      if (kind === 'duplicate') data.components.rows.push(['TP1', 'T', 0, 0]);
      if (kind === 'emptyNet') row[5] = '';
      applyFlyingProbeRoles(pads, [], data);
      expect(pads[0].padRole).toBeUndefined();
    });
  it('preserves X2 component roles, clear polarity, holes and unknown shapes', () => {
    const pads = [circle(), circle(), circle(), circle(), circle()];
    pads[0].padRole = 'component'; pads[1].polarity = 'C'; pads[2].parts[0].holes = [[[0, 0], [.1, 0], [0, .1]]];
    pads[3].type = 'macro'; pads[4].parts[0].points = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    applyFlyingProbeRoles(pads, [], report([['TP1', 'T', 0, 0]], [pin('TP1_1')]));
    expect(pads.map(p => p.padRole)).toEqual(['component', undefined, undefined, undefined, undefined]);
  });
  it.each([undefined, null, {}, { lengthUnit: 'mm', components: {}, pins: {} }])('ignores absent or invalid reports', value => {
    const pads = [circle()];
    expect(() => applyFlyingProbeRoles(pads, [], value)).not.toThrow();
    expect(pads[0].padRole).toBeUndefined();
  });
});
