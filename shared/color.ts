export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const toHex = ([r, g, b]: Rgb) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Perceptually weighted RGB distance, roughly 0-440. */
export const colorDistance = (a: Rgb, b: Rgb) =>
  Math.sqrt((a[0] - b[0]) ** 2 * 0.3 + (a[1] - b[1]) ** 2 * 0.59 + (a[2] - b[2]) ** 2 * 0.11) * 1.7;

export function nearestColor(hex: string, palette: string[]): { hex: string; distance: number } {
  const rgb = hexToRgb(hex);
  let best = { hex: palette[0], distance: Infinity };
  for (const p of palette) {
    const d = colorDistance(rgb, hexToRgb(p));
    if (d < best.distance) best = { hex: p, distance: d };
  }
  return best;
}

/** Colours this close to a palette entry count as on-palette (absorbs sampling noise like #FEFEFE vs #FFFFFF). */
export const PALETTE_TOLERANCE = 12;

export function isOnPalette(hex: string, palette: string[]): boolean {
  return !palette.length || nearestColor(hex, palette).distance <= PALETTE_TOLERANCE;
}

function luminance([r, g, b]: Rgb): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG contrast ratio, 1-21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function bestContrast(on: string, candidates: string[]): string {
  return [...candidates].sort((x, y) => contrastRatio(y, on) - contrastRatio(x, on))[0] ?? '#FFFFFF';
}
