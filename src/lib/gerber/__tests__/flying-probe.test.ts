import { describe, expect, it } from 'vitest';
import { applyFlyingProbeRoles } from '../flying-probe';
import { extractPads, type PadPolygon } from '../pads';

const components = ['COMPONENT_NAME', 'LAYER', 'X_COORDINATE', 'Y_COORDINATE'];
const fields = ['PIN_NAME', 'PIN_X', 'PIN_Y', 'LAYER', 'PIN_TYPE', 'NET_NAME', 'PAD_SHAPE', 'PAD_SIZEX', 'PAD_SIZEY', 'HOLE_SIZE', 'HOLE_LEN'];
const report = (rows: unknown[][], pins: unknown[][], lengthUnit = 'mm') => ({ lengthUnit,
  components: { fields: components, rows }, pins: { fields, rows: pins } });
const pin = (name: string, x = 0, y = 0, net = name.split('_')[0], layer = 'T') => [name, x, y, layer, 'SMD', net, 'C', 1.8, 1.8, 0, 0];
const circle = (x = 0, y = 0): PadPolygon => extractPads(`%FSLAX45Y45*%\n%MOMM*%\n%ADD10C,1.8*%\nD10*\nX${Math.round(x * 100000)}Y${Math.round(y * 100000)}D03*\nM02*`).pads[0];
const rectangle = (x = 0, y = 0, width = .8, height = 1.6): PadPolygon => extractPads(`%FSLAX45Y45*%\n%MOMM*%\n%ADD10R,${width}X${height}*%\nD10*\nX${Math.round(x * 100000)}Y${Math.round(y * 100000)}D03*\nM02*`).pads[0];

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

describe('manufacturing netlist component identities', () => {
  it('groups multi-pin SMD parts by exact side, position and pad dimensions without classifying them as test pads', () => {
    const top = [rectangle(-2), rectangle(2), rectangle(8), rectangle(10)];
    const bottom = [rectangle(-2), rectangle(2)];
    const rows = [pin('U_CTRL_1', -2), pin('U_CTRL_2', 2), pin('R1_1', 8), pin('R1_2', 10)];
    for (const row of rows) { row[6] = 'R'; row[7] = .8; row[8] = 1.6; }
    const geometry = JSON.stringify([...top, ...bottom].map(pad => pad.parts));
    applyFlyingProbeRoles(top, bottom, report([['U_CTRL', 'T', 0, 0], ['R1', 'T', 9, 0]], rows));
    expect(top.map(pad => pad.componentRef)).toEqual(['U_CTRL', 'U_CTRL', 'R1', 'R1']);
    expect(bottom.every(pad => pad.componentRef === undefined)).toBe(true);
    expect(top.every(pad => pad.padRole === undefined && pad.padRoleSource === undefined)).toBe(true);
    expect(JSON.stringify([...top, ...bottom].map(pad => pad.parts))).toBe(geometry);
  });

  it('uses mil units and allows swapped dimensions for a quarter-turn pad', () => {
    const pad = rectangle(2.54, 0, 1.6, .8);
    const row = pin('U1_1', 100, 0, 'SIGNAL', 'B');
    row[6] = 'R'; row[7] = .8 / .0254; row[8] = 1.6 / .0254;
    applyFlyingProbeRoles([], [pad], report([['U1', 'B', 100, 0]], [row], 'mil'));
    expect(pad.componentRef).toBe('U1');
    expect(pad.padRole).toBeUndefined();
  });

  it('keeps an existing X2 identity even when the manufacturing report disagrees', () => {
    const pad = circle(); pad.componentRef = 'U_X2'; pad.padRole = 'component';
    applyFlyingProbeRoles([pad], [], report([['U_REPORT', 'T', 0, 0]], [pin('U_REPORT_1')]));
    expect(pad.componentRef).toBe('U_X2');
    expect(pad.padRole).toBe('component');
  });

  it('leaves overlapping component references ambiguous instead of taking the first match', () => {
    const pad = circle();
    applyFlyingProbeRoles([pad], [], report([['U1', 'T', 0, 0], ['U2', 'T', 0, 0]], [pin('U1_1'), pin('U2_1')]));
    expect(pad.componentRef).toBeUndefined();
    // Existing single-pin/net-name evidence is deliberately unchanged.
    expect(pad.padRole).toBe('testpoint');
  });

  it('accepts repeated pin records of the same component without creating a reference conflict', () => {
    const pad = circle();
    applyFlyingProbeRoles([pad], [], report([['U1', 'T', 0, 0]], [pin('U1_1'), pin('U1_1')]));
    expect(pad.componentRef).toBe('U1');
    expect(pad.padRole).toBeUndefined();
  });

  it.each(['size', 'position', 'side', 'drill', 'slot', 'throughHole', 'duplicate', 'clear', 'hole'])(
    'does not attach component metadata without a clear match: %s', kind => {
      const pad = circle();
      const row = pin('U1_1');
      const data = report([['U1', 'T', 0, 0]], [row]);
      if (kind === 'size') row[7] = row[8] = 1.5;
      if (kind === 'position') row[1] = .1;
      if (kind === 'side') row[3] = 'B';
      if (kind === 'drill') row[9] = .5;
      if (kind === 'slot') row[10] = .5;
      if (kind === 'throughHole') row[4] = 'DIP';
      if (kind === 'duplicate') data.components.rows.push(['U1', 'T', 0, 0]);
      if (kind === 'clear') pad.polarity = 'C';
      if (kind === 'hole') pad.parts[0].holes = [[[0, 0], [.1, 0], [0, .1]]];
      applyFlyingProbeRoles([pad], [], data);
      expect(pad.componentRef).toBeUndefined();
      expect(pad.padRole).toBeUndefined();
    });
});
