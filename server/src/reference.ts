import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { visionJson } from './llm.ts';
import { sessionDir } from './store.ts';

export interface LayoutSpec {
  summary: string;
  mood: string;
  aspectRatio: string;
  background: { kind: 'solid' | 'photo' | 'shapes' | 'gradient'; color?: string; description?: string };
  elements: {
    role: string;
    kind: 'text' | 'photo' | 'illustration' | 'shape' | 'logo' | 'icon' | 'card' | 'product_photo' | 'cta';
    /** Fractions of canvas: [x, y, width, height]. */
    bbox: [number, number, number, number];
    text?: string;
    color?: string;
    notes?: string;
  }[];
  copy: { headline?: string; subheadline?: string; cta?: string; other?: string[] };
  palette: string[];
  typography: string;
}

/** Vision parses a reference once into a layout spec; cached by content hash. */
export async function parseReference(sessionId: string, image: Buffer): Promise<LayoutSpec> {
  const hash = crypto.createHash('sha1').update(image).digest('hex').slice(0, 16);
  const cacheFile = path.join(sessionDir(sessionId, 'references'), `${hash}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

  const png = await sharp(image).resize(1024, 1024, { fit: 'inside' }).png().toBuffer();
  const meta = await sharp(png).metadata();

  const prompt = `Analyse this reference design (an ad / social post, ${meta.width}x${meta.height}) and describe its layout so a designer can recreate the structure with different content.
List every visible element from back to front. bbox values are fractions (0-1) of the canvas: [x, y, width, height].
Element kinds: text, photo, illustration, shape (decorative blobs/geometry), logo, icon, card (rounded panels behind text), product_photo (device/UI), cta (button/pill).
For text elements include the exact text, colour, and notes on weight/size/case.
Respond as JSON:
{"summary":"one sentence","mood":"...","aspectRatio":"4:5","background":{"kind":"solid|photo|shapes|gradient","color":"#hex","description":"..."},"elements":[{"role":"headline","kind":"text","bbox":[0.08,0.1,0.84,0.2],"text":"...","color":"#hex","notes":"heavy condensed sans, 2 lines"}],"copy":{"headline":"...","subheadline":"...","cta":"...","other":["..."]},"palette":["#hex"],"typography":"..."}`;

  const spec = await visionJson<LayoutSpec>(
    prompt,
    [{ dataUrl: `data:image/png;base64,${png.toString('base64')}` }],
    { strong: true, detail: 'high', maxTokens: 3000 },
  );
  fs.writeFileSync(cacheFile, JSON.stringify(spec, null, 2));
  return spec;
}
