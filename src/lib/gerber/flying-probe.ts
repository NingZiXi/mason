import type { PadPolygon } from './pads';

type Side = 'top' | 'bottom';
interface Table { fields: string[]; rows: unknown[][] }
interface TestPad { x: number; y: number; width: number; height: number }

function table(value: unknown): Table | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Table;
  return Array.isArray(candidate.fields) && candidate.fields.every(field => typeof field === 'string')
    && Array.isArray(candidate.rows) && candidate.rows.every(Array.isArray) ? candidate : null;
}
function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : NaN;
}
function side(value: unknown): Side | null {
  return value === 'T' ? 'top' : value === 'B' ? 'bottom' : null;
}

/** Supplement missing X2 roles with EasyEDA's optional manufacturing netlist.
 * Only a single, solid SMD circle at a single-pin component's origin qualifies,
 * with a test-point reference or a name matching its net label. Coordinates,
 * face and dimensions must all match the actual paste flash. */
export function applyFlyingProbeRoles(
  top: PadPolygon[], bottom: PadPolygon[], value: unknown,
): void {
  if (!value || typeof value !== 'object') return;
  const report = value as Record<string, unknown>;
  const units = typeof report.lengthUnit === 'string' ? report.lengthUnit.toLowerCase() : '';
  const scale = units === 'mil' ? .0254 : units === 'mm' ? 1 : NaN;
  const components = table(report.components), pins = table(report.pins);
  if (!Number.isFinite(scale) || !components || !pins) return;
  const componentFields = ['COMPONENT_NAME', 'LAYER', 'X_COORDINATE', 'Y_COORDINATE'];
  const pinFields = ['PIN_NAME', 'PIN_X', 'PIN_Y', 'LAYER', 'PIN_TYPE', 'NET_NAME', 'PAD_SHAPE', 'PAD_SIZEX', 'PAD_SIZEY', 'HOLE_SIZE', 'HOLE_LEN'];
  if (componentFields.some(key => !components.fields.includes(key)) || pinFields.some(key => !pins.fields.includes(key))) return;
  const c = (row: unknown[], field: string) => row[components.fields.indexOf(field)];
  const p = (row: unknown[], field: string) => row[pins.fields.indexOf(field)];
  const refs = new Map<string, { row: unknown[]; pins: unknown[][] }>();
  const duplicateRefs = new Set<string>();
  for (const row of components.rows) {
    const name = c(row, 'COMPONENT_NAME');
    if (typeof name !== 'string' || !name) continue;
    if (refs.has(name)) duplicateRefs.add(name);
    refs.set(name, { row, pins: [] });
  }
  for (const row of pins.rows) {
    const name = p(row, 'PIN_NAME');
    if (typeof name !== 'string') continue;
    // Component names may contain underscores; prefer the longest known prefix.
    for (let cut = name.lastIndexOf('_'); cut > 0; cut = name.lastIndexOf('_', cut - 1)) {
      const component = refs.get(name.slice(0, cut));
      if (component) { component.pins.push(row); break; }
    }
  }
  const candidates = new Map<string, TestPad[]>();
  const cell = .1;
  const key = (x: number, y: number, face: Side) => `${face}:${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
  for (const [ref, component] of refs) {
    if (duplicateRefs.has(ref) || component.pins.length !== 1) continue;
    const pin = component.pins[0], row = component.row;
    const face = side(p(pin, 'LAYER'));
    if (!face || face !== side(c(row, 'LAYER')) || p(pin, 'PIN_TYPE') !== 'SMD' || p(pin, 'PAD_SHAPE') !== 'C'
      || number(p(pin, 'HOLE_SIZE')) !== 0 || number(p(pin, 'HOLE_LEN')) !== 0) continue;
    const net = p(pin, 'NET_NAME');
    if (typeof net !== 'string' || !net.trim()) continue;
    const name = ref.trim().toUpperCase(), netName = net.trim().toUpperCase();
    const testReference = /^(?:TP(?:\d+|[_-].+)?|TEST(?:POINT|PAD)?(?:\d+|[_-].+)?|测试点.*)$/.test(name);
    const genericReference = /^(?:PAD|VIA|PTH|NPTH)\d+$/.test(name);
    if (!testReference && (genericReference || !(netName === name || netName.startsWith(`${name}_`)))) continue;
    const x = number(p(pin, 'PIN_X')) * scale, y = number(p(pin, 'PIN_Y')) * scale;
    const cx = number(c(row, 'X_COORDINATE')) * scale, cy = number(c(row, 'Y_COORDINATE')) * scale;
    const width = number(p(pin, 'PAD_SIZEX')) * scale, height = number(p(pin, 'PAD_SIZEY')) * scale;
    if (![x, y, cx, cy, width, height].every(Number.isFinite) || Math.hypot(x - cx, y - cy) > .02
      || Math.min(width, height) <= 0 || Math.max(width, height) / Math.min(width, height) > 1.02) continue;
    const bucket = key(x, y, face);
    const entries = candidates.get(bucket) ?? [];
    entries.push({ x, y, width, height });
    candidates.set(bucket, entries);
  }
  for (const [pads, face] of [[top, 'top'], [bottom, 'bottom']] as const) {
    for (const pad of pads) {
      if (pad.padRole || pad.type !== 'circle' || pad.polarity !== 'D' || pad.parts.length !== 1) continue;
      const part = pad.parts[0];
      if (part.polarity !== 'D' || part.holes?.length || part.points.length < 12) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of part.points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const width = x1 - x0, height = y1 - y0;
      if (![cx, cy, width, height].every(Number.isFinite) || Math.min(width, height) <= 0) continue;
      const radii = part.points.map(([x, y]) => Math.hypot(x - cx, y - cy));
      if (Math.min(...radii) <= 0 || Math.max(...radii) / Math.min(...radii) > 1.02) continue;
      let matched = false;
      for (const dx of [-cell, 0, cell]) {
        for (const dy of [-cell, 0, cell]) {
          if (candidates.get(key(cx + dx, cy + dy, face))?.some(candidate =>
            Math.hypot(candidate.x - cx, candidate.y - cy) <= .02
            && Math.abs(candidate.width - width) <= .03 && Math.abs(candidate.height - height) <= .03)) matched = true;
        }
      }
      if (matched) { pad.padRole = 'testpoint'; pad.padRoleSource = 'flying-probe'; }
    }
  }
}
