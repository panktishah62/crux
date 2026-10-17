import sharp from 'sharp';
import type { BrandKit, Layer, Scene } from '../../../shared/types.ts';
import type { Measurements, ParamKey, ParamScores } from '../../../shared/testlab.ts';
import { colorDistance, contrastRatio, hexToRgb, isOnPalette, toHex } from '../../../shared/color.ts';
import { backdropFor, isLogoLayer, lintScene } from '../../../shared/lint.ts';

const DEFAULT_STORY_SAFE = { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 };
const EDGE_MARGIN = 0.03;

/** Decoded render of a scene, used to read the colour behind text that sits on a photo. */
export interface RenderPixels {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
  scale: number;
}

export async function decodeRender(pngDataUrl: string, scene: Scene): Promise<RenderPixels | null> {
  try {
    const buf = Buffer.from(pngDataUrl.split(',', 2)[1] ?? '', 'base64');
    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels, scale: info.width / scene.width };
  } catch {
    return null;
  }
}

/** Average colour of the region under a layer, ignoring pixels close to the text colour itself. */
function sampleBehind(px: RenderPixels, l: Layer, textHex: string): string | null {
  const text = hexToRgb(textHex);
  const x0 = Math.max(0, Math.floor(l.x * px.scale)), y0 = Math.max(0, Math.floor(l.y * px.scale));
  const x1 = Math.min(px.width, Math.ceil((l.x + l.width) * px.scale)), y1 = Math.min(px.height, Math.ceil((l.y + l.height) * px.scale));
  let r = 0, g = 0, b = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * px.width + x) * px.channels;
      const rgb: [number, number, number] = [px.data[i], px.data[i + 1], px.data[i + 2]];
      if (colorDistance(rgb, text) < 60) continue;
      r += rgb[0]; g += rgb[1]; b += rgb[2]; n++;
    }
  }
  return n ? toHex([r / n, g / n, b / n]) : null;
}

/** Exact facts about a design, computed from the scene graph (never by a model). */
export function measureScene(scene: Scene, kit: BrandKit, px: RenderPixels | null): Measurements {
  const W = scene.width, H = scene.height;
  const profile = kit.profile;
  const palette = profile?.palette.map((c) => c.hex.toUpperCase()) ?? [];
  const fonts = new Set(profile ? [profile.fonts.headline.family, profile.fonts.body.family] : []);
  const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

  const contrastOf = (index: number, fill: string): number | null => {
    const l = scene.layers[index];
    const backdrop = backdropFor(scene, index, kit.assets);
    if (backdrop.kind === 'color') return contrastRatio(fill, backdrop.hex);
    const behind = px ? sampleBehind(px, l, fill) : null;
    return behind ? contrastRatio(fill, behind) : null;
  };

  let minTextHeightRatio = 1;
  let minTextContrast = 21;
  let textArea = 0;
  let headline: Measurements['headline'] = null;
  const texts = scene.layers.map((l, i) => ({ l, i })).filter((x) => x.l.type === 'text');
  const head = texts.find((x) => x.l.role === 'headline') ?? [...texts].sort((a, b) => (b.l.type === 'text' ? b.l.fontSize : 0) - (a.l.type === 'text' ? a.l.fontSize : 0))[0];

  for (const { l, i } of texts) {
    if (l.type !== 'text') continue;
    const heightRatio = (l.fontSize * (l.lineHeight ?? 1.15)) / H;
    minTextHeightRatio = Math.min(minTextHeightRatio, heightRatio);
    const c = contrastOf(i, l.fill);
    if (c !== null) minTextContrast = Math.min(minTextContrast, c);
    textArea += Math.max(0, l.width) * Math.max(0, l.height);
    if (head && head.l === l) {
      const text = l.text.replace(/\s+/g, ' ').trim();
      headline = { text, words: text ? text.split(' ').length : 0, heightRatio: round(heightRatio), contrast: round(c ?? 21, 2) };
    }
  }
  if (!texts.length) minTextHeightRatio = 0;

  const ctaLayer = scene.layers.find((l) => l.type === 'shape' && !!l.label && l.role === 'cta') ?? scene.layers.find((l) => l.type === 'shape' && !!l.label);
  const cta: Measurements['cta'] =
    ctaLayer?.type === 'shape'
      ? { present: true, text: ctaLayer.label ?? null, contrast: round(contrastRatio(ctaLayer.labelColor ?? '#FFFFFF', ctaLayer.fill), 2) }
      : { present: false, text: null, contrast: null };

  const logoIndex = scene.layers.findIndex((l) => isLogoLayer(l, kit));
  const logoLayer = scene.layers[logoIndex];
  const logo: Measurements['logo'] = logoLayer
    ? {
        present: true,
        areaRatio: round((logoLayer.width * logoLayer.height) / (W * H), 4),
        onBusyBackground: backdropFor(scene, logoIndex, kit.assets).kind === 'image',
      }
    : { present: false, areaRatio: 0, onBusyBackground: false };

  const off = new Set<string>();
  const check = (hex?: string) => {
    if (hex && palette.length && !isOnPalette(hex, palette)) off.add(hex.toUpperCase());
  };
  check(scene.background);
  const offFonts = new Set<string>();
  for (const l of scene.layers) {
    if (l.type === 'text') {
      check(l.fill);
      if (fonts.size && !fonts.has(l.fontFamily)) offFonts.add(l.fontFamily);
    }
    if (l.type === 'shape') {
      check(l.fill);
      check(l.stroke);
      if (l.label) {
        check(l.labelColor);
        if (fonts.size && l.labelFontFamily && !fonts.has(l.labelFontFamily)) offFonts.add(l.labelFontFamily);
      }
    }
  }

  const zone = H / W > 1.6
    ? profile?.safeZones?.find((s) => /story|9:16/i.test(s.format)) ?? DEFAULT_STORY_SAFE
    : { top: EDGE_MARGIN, bottom: EDGE_MARGIN, left: EDGE_MARGIN, right: EDGE_MARGIN };
  const outsideSafeZone = scene.layers
    .filter((l) => l.type === 'text' || (l.type === 'shape' && !!l.label) || isLogoLayer(l, kit))
    .filter((l) => l.x < W * zone.left - 1 || l.y < H * zone.top - 1 || l.x + l.width > W * (1 - zone.right) + 1 || l.y + l.height > H * (1 - zone.bottom) + 1)
    .map((l) => l.id);

  return {
    headline,
    minTextHeightRatio: round(minTextHeightRatio),
    minTextContrast: round(texts.length ? minTextContrast : 21, 2),
    cta,
    logo,
    offPaletteColors: [...off],
    offBrandFonts: [...offFonts],
    outsideSafeZone,
    textCoverage: round(textArea / (W * H)),
    elementCount: scene.layers.filter((l) => (l.opacity ?? 1) > 0).length,
    overlaps: lintScene(scene, kit).filter((i) => i.rule === 'layout' && i.severity === 'error').map((i) => i.message),
  };
}

/** Code overrides the model: final = min(modelScore, cap), plus a flag for each hard failure. */
export function applyCaps(params: ParamScores, m: Measurements, kit: BrandKit): { params: ParamScores; flags: string[]; fixes: Partial<Record<ParamKey, string>> } {
  const out = structuredClone(params);
  const flags: string[] = [];
  const fixes: Partial<Record<ParamKey, string>> = {};
  /** The measured fact replaces the model's reason, which often contradicts it ("all text is legible"). */
  const cap = (key: ParamKey, max: number, why: string, fix: string, flag?: string) => {
    if (out[key].score > max) {
      out[key] = { score: max as 1 | 2 | 3 | 4 | 5, reason: `${why} (measured; capped at ${max}/5).` };
      fixes[key] = fix;
    }
    if (flag && !flags.includes(flag)) flags.push(flag);
  };

  if (!m.headline) cap('hook', 1, 'There is no headline', 'Add a short, specific headline of 6 words or fewer.', 'Missing headline');
  else if (m.headline.words > 8) cap('hook', 3, `The headline is ${m.headline.words} words`, 'Cut the headline to 6 words or fewer.');

  const smallText = `The smallest text is ${(m.minTextHeightRatio * 100).toFixed(1)}% of the canvas height (min 2.5%)`;
  if (m.minTextContrast < 3) cap('readability', 2, `Text contrast is only ${m.minTextContrast}:1`, 'Raise text contrast to at least 4.5:1 with a darker or lighter brand colour.', 'Low-contrast text');
  else if (m.minTextContrast < 4.5) cap('readability', 3, `Text contrast is ${m.minTextContrast}:1 (needs 4.5:1)`, 'Raise text contrast to at least 4.5:1 with a darker or lighter brand colour.');
  else if (m.minTextHeightRatio < 0.025) cap('readability', 3, smallText, 'Enlarge the smallest text (body or disclaimer) so it reads on a phone.');

  if (!m.cta.present) cap('cta', 1, 'There is no CTA button', 'Add a high-contrast CTA button with a specific action.', 'Missing CTA');
  else if ((m.cta.contrast ?? 21) < 3) cap('cta', 3, `The CTA label contrast is ${m.cta.contrast}:1`, 'Increase the CTA label contrast against its button.');

  if (kit.profile) {
    const kitHasLogo = kit.assets.some((a) => a.category === 'logo');
    if (kitHasLogo && !m.logo.present) cap('brand', 1, 'The logo is missing', 'Add the brand logo in a corner.', 'Missing logo');
    else if (m.offPaletteColors.length || m.offBrandFonts.length) cap('brand', 2, 'It uses an off-palette colour or off-brand font', 'Swap to brand palette colours and fonts.', 'Off-brand colour or font');
    else if (m.logo.present && (m.logo.areaRatio < 0.005 || m.logo.onBusyBackground)) cap('brand', 3, m.logo.onBusyBackground ? 'The logo sits on a photo' : 'The logo is tiny', m.logo.onBusyBackground ? 'Move the logo onto solid colour or use the badge version.' : 'Enlarge the logo to about 15% of the canvas width.');
  }

  if (m.overlaps.length) {
    cap('layout', 2, `Layout collision: ${m.overlaps[0]}`, 'Give every text block, the logo and the image their own space, inside the card and canvas.', 'Layout collision');
    cap('readability', 3, 'Colliding or clipped text is hard to read', 'Give every text block, the logo and the image their own space, inside the card and canvas.');
  }
  if (m.outsideSafeZone.length) cap('layout', 2, 'Text or the logo is outside the safe zone', 'Move all text and the logo inside the safe margins.', 'Outside safe zone');
  else if (m.textCoverage > 0.35) cap('layout', 3, `Text covers ${Math.round(m.textCoverage * 100)}% of the canvas (max 35%)`, 'Give the design more breathing room: shrink or remove secondary text.');
  else if (m.elementCount > 12) cap('layout', 3, `${m.elementCount} layers feels cluttered`, 'Remove decorative layers that do not support the message.');

  return { params: out, flags, fixes };
}
