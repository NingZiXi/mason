/** Decode a file coordinate to the fixed-point integer used by both parsers.
 * Keeping the digit string until here is essential for trailing-zero omission:
 * in FS 2.4, T's "001" is 0.1000, while L's "001" is 0.0001.
 */
export function decodeGerberCoordinate(raw: string, places: [number, number], zero: 'L' | 'T' = 'L'): number {
  if (raw.includes('.')) return Number(raw) * Math.pow(10, places[1]);
  if (zero !== 'T') return Number(raw);
  const negative = raw.startsWith('-');
  const digits = raw.replace(/^[+-]/, '');
  return Number(digits.padEnd(places[0] + places[1], '0')) * (negative ? -1 : 1);
}
