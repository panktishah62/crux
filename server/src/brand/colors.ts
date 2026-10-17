import sharp from 'sharp';
import { colorDistance, hexToRgb, toHex, type Rgb } from '../../../shared/color.ts';
import { GRID_SIZE } from '../../../shared/types.ts';

export { colorDistance, hexToRgb, toHex };

/** Dominant opaque colours of an image via coarse histogram bucketing. Returns hex with pixel share. */
export async function dominantColors(input: Buffer, max = 5): Promise<{ hex: string; share: number }[]> {
  const { data, info } = await sharp(input)
    .resize(64, 64, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map<number, { sum: Rgb; count: number }>();
  let total = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] < 200) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { sum: [0, 0, 0] as Rgb, count: 0 };
    bucket.sum[0] += r; bucket.sum[1] += g; bucket.sum[2] += b;
    bucket.count++;
    buckets.set(key, bucket);
    total++;
  }
  if (!total) return [];

  const sorted = [...buckets.values()]
    .map((b) => ({ rgb: b.sum.map((v) => v / b.count) as Rgb, count: b.count }))
    .sort((a, b) => b.count - a.count);

  const merged: { rgb: Rgb; count: number }[] = [];
  for (const c of sorted) {
    const near = merged.find((m) => colorDistance(m.rgb, c.rgb) < 28);
    if (near) near.count += c.count;
    else merged.push({ ...c });
  }
  return merged
    .slice(0, max)
    .map((m) => ({ hex: toHex(m.rgb), share: m.count / total }))
    .filter((m) => m.share > 0.03);
}

/** Coarse colour map so the linter can tell what sits behind each region (a blue wave vs the white rest of a template). */
export async function colorGrid(input: Buffer): Promise<string[]> {
  const { data, info } = await sharp(input)
    .resize(GRID_SIZE, GRID_SIZE, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cells: string[] = [];
  for (let i = 0; i < data.length; i += info.channels) cells.push(data[i + 3] < 128 ? '' : toHex([data[i], data[i + 1], data[i + 2]]));
  return cells;
}

export const GRID_CATEGORIES = new Set(['background_template', 'shape']);

/** Aggregates per-asset colours into a ranked list of distinct brand colour candidates. */
export function aggregatePalette(samples: { hex: string; weight: number }[], max = 12): string[] {
  const clusters: { rgb: Rgb; weight: number }[] = [];
  for (const s of samples) {
    const rgb = hexToRgb(s.hex);
    const near = clusters.find((c) => colorDistance(c.rgb, rgb) < 36);
    if (near) {
      const w = near.weight + s.weight;
      near.rgb = near.rgb.map((v, i) => (v * near.weight + rgb[i] * s.weight) / w) as Rgb;
      near.weight = w;
    } else clusters.push({ rgb, weight: s.weight });
  }
  return clusters.sort((a, b) => b.weight - a.weight).slice(0, max).map((c) => toHex(c.rgb));
}
