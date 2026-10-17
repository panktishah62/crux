import { GRID_SIZE, type Asset, type BrandKit, type ImageLayer, type Layer, type LintIssue, type Scene } from './types.ts';
import { bestContrast, colorDistance, contrastRatio, hexToRgb, isOnPalette, nearestColor } from './color.ts';
import { isDisplayRole, wrapLines } from './text.ts';

/** What sits behind a layer: solid colours (`hex` is the dominant one, `areas` every colour with its share), or pixels we cannot judge (photos). */
export type Backdrop = { kind: 'color'; hex: string; areas: { hex: string; share: number }[] } | { kind: 'image'; layerId: string };

const PHOTO_ROLES = new Set(['photo', 'background', 'illustration']);

/** Colour of an image asset's colour map at canvas point (x, y), honouring cover/contain placement; '' if transparent. */
function gridColor(o: ImageLayer, asset: Asset, x: number, y: number): string {
  const aw = asset.width ?? o.width, ah = asset.height ?? o.height;
  const s = (o.fit ?? 'cover') === 'cover' ? Math.max(o.width / aw, o.height / ah) : Math.min(o.width / aw, o.height / ah);
  const sw = aw * s, sh = ah * s;
  const u = (x - o.x - (o.width - sw) / 2) / sw;
  const v = (y - o.y - (o.height - sh) / 2) / sh;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return '';
  return asset.grid![Math.floor(v * GRID_SIZE) * GRID_SIZE + Math.floor(u * GRID_SIZE)] ?? '';
}

/** Walks down the stack under layer `below` and returns what is visible at one point: a hex colour or a photo layer. */
function sampleAt(scene: Scene, below: number, x: number, y: number, assets: Asset[]): string | { photo: string } {
  for (let j = below - 1; j >= 0; j--) {
    const o = scene.layers[j];
    if (o.type === 'text' || x < o.x || x > o.x + o.width || y < o.y || y > o.y + o.height) continue;
    if (o.type === 'shape') {
      if ((o.opacity ?? 1) < 0.85) continue;
      if (o.shape === 'ellipse') {
        const dx = (x - o.x - o.width / 2) / (o.width / 2), dy = (y - o.y - o.height / 2) / (o.height / 2);
        if (dx * dx + dy * dy > 1) continue;
      }
      return o.fill;
    }
    const asset = o.assetId ? assets.find((a) => a.id === o.assetId) : undefined;
    if (asset?.grid) {
      const c = gridColor(o, asset, x, y);
      if (c) return c;
      continue;
    }
    if (asset?.category === 'background_template' && asset.colors?.[0]) return asset.colors[0];
    if (PHOTO_ROLES.has(o.role ?? '') || !asset) return { photo: o.id };
    // Decorative assets without a colour map (icons) are mostly transparent; look further down.
  }
  return scene.background;
}

/** Samples a 5x3 grid across the layer (its glyphs, for text) so a wave under half a block of copy is not missed. */
export function backdropFor(scene: Scene, index: number, assets: Asset[]): Backdrop {
  const box = inkBox(scene.layers[index]);
  const clusters: { hex: string; count: number }[] = [];
  const photos = new Map<string, number>();
  const NX = 5, NY = 3;
  for (let i = 0; i < NX; i++) {
    for (let k = 0; k < NY; k++) {
      const s = sampleAt(scene, index, box.x + (box.w * (i + 0.5)) / NX, box.y + (box.h * (k + 0.5)) / NY, assets);
      if (typeof s !== 'string') {
        photos.set(s.photo, (photos.get(s.photo) ?? 0) + 1);
        continue;
      }
      const near = clusters.find((c) => colorDistance(hexToRgb(c.hex), hexToRgb(s)) < 40);
      if (near) near.count++;
      else clusters.push({ hex: s, count: 1 });
    }
  }
  const total = NX * NY;
  const photo = [...photos.entries()].sort((a, b) => b[1] - a[1])[0];
  const photoCount = [...photos.values()].reduce((a, b) => a + b, 0);
  if (photo && photoCount * 2 > total) return { kind: 'image', layerId: photo[0] };
  clusters.sort((a, b) => b.count - a.count);
  return { kind: 'color', hex: clusters[0]?.hex ?? scene.background, areas: clusters.map((c) => ({ hex: c.hex, share: c.count / total })) };
}

/** The backdrop colour covering at least a fifth of the layer that contrasts worst with `fg`. */
function worstArea(backdrop: Extract<Backdrop, { kind: 'color' }>, fg: string): string {
  return backdrop.areas.filter((a) => a.share >= 0.2).reduce((w, a) => (contrastRatio(fg, a.hex) < contrastRatio(fg, w) ? a.hex : w), backdrop.hex);
}

function logoAssetIds(kit: BrandKit): Set<string> {
  const ids = new Set(kit.profile?.logos.map((l) => l.assetId) ?? []);
  for (const a of kit.assets) if (a.category === 'logo') ids.add(a.id);
  return ids;
}

export function isLogoLayer(l: Layer, kit: BrandKit): boolean {
  return l.type === 'image' && (l.role === 'logo' || (!!l.assetId && logoAssetIds(kit).has(l.assetId)));
}

/** Best logo variant for a backdrop colour, by contrast against each logo's dominant colour. */
export function bestLogoFor(backdrop: string, kit: BrandKit): Asset | undefined {
  const ids = logoAssetIds(kit);
  const logos = kit.assets.filter((a) => ids.has(a.id) && a.colors?.length);
  return logos.sort((a, b) => contrastRatio(b.colors![0], backdrop) - contrastRatio(a.colors![0], backdrop))[0];
}

const DEFAULT_STORY_SAFE = { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 };

/**
 * Brand linter: palette, fonts, logo size/variant, contrast, safe zones and legibility.
 * Pure function of the scene and kit so the client can show it live and the agent loop can enforce it.
 */
export function lintScene(scene: Scene, kit: BrandKit): LintIssue[] {
  const profile = kit.profile;
  if (!profile) return [];
  const issues: LintIssue[] = [];
  const palette = profile.palette.map((c) => c.hex.toUpperCase());
  const nameOf = (hex: string) => profile.palette.find((c) => c.hex.toUpperCase() === hex)?.name ?? hex;
  const W = scene.width, H = scene.height;
  const fonts = new Set([profile.fonts.headline.family, profile.fonts.body.family]);
  const label = (l: Layer) => (l.type === 'text' ? `“${l.text.replace(/\n/g, ' ').slice(0, 28)}”` : l.name);
  let n = 0;
  const push = (i: Omit<LintIssue, 'id'>) => issues.push({ ...i, id: `${i.rule}-${i.layerId ?? 'scene'}-${n++}` });

  const checkColor = (hex: string | undefined, layer: Layer, field: string, what: string) => {
    if (!hex || isOnPalette(hex, palette)) return;
    const near = nearestColor(hex, palette).hex;
    push({
      rule: 'palette', severity: 'error', layerId: layer.id,
      message: `${label(layer)} ${what} ${hex.toUpperCase()} is off-palette (nearest: ${nameOf(near)} ${near}).`,
      fix: { layerId: layer.id, patch: { [field]: near } },
    });
  };

  if (!isOnPalette(scene.background, palette)) {
    const near = nearestColor(scene.background, palette).hex;
    push({ rule: 'palette', severity: 'error', message: `Canvas background ${scene.background} is off-palette (nearest: ${nameOf(near)}).`, fix: { background: near } });
  }

  scene.layers.forEach((l, index) => {
    const backdrop = backdropFor(scene, index, kit.assets);

    if (l.type === 'text') {
      checkColor(l.fill, l, 'fill', 'text colour');
      if (!fonts.has(l.fontFamily)) {
        const family = isDisplayRole(l.role) ? profile.fonts.headline.family : profile.fonts.body.family;
        push({ rule: 'font', severity: 'error', layerId: l.id, message: `${label(l)} uses "${l.fontFamily}", not a brand font (use ${family}).`, fix: { layerId: l.id, patch: { fontFamily: family } } });
      }
      const large = l.fontSize >= W * 0.035 || ((l.fontWeight ?? 400) >= 700 && l.fontSize >= W * 0.026);
      const min = large ? 3 : 4.5;
      if (backdrop.kind === 'color') {
        const behind = worstArea(backdrop, l.fill);
        const ratio = contrastRatio(l.fill, behind);
        if (ratio < min) {
          const better = bestContrast(behind, palette);
          const mixed = backdrop.areas.filter((a) => a.share >= 0.2).length > 1;
          push({
            rule: 'contrast', severity: 'error', layerId: l.id,
            message: `${label(l)} contrast is ${ratio.toFixed(1)}:1 on ${behind}${mixed ? ' (it straddles two background colours; move it onto one)' : ''} (needs ${min}:1).`,
            fix: !mixed && contrastRatio(better, behind) >= min ? { layerId: l.id, patch: { fill: better } } : undefined,
          });
        }
      } else {
        push({ rule: 'contrast', severity: 'warning', layerId: l.id, message: `${label(l)} sits directly on a photo; put it on a card or solid colour for guaranteed legibility.` });
      }
      if (l.fontSize < W * 0.018) {
        push({ rule: 'legibility', severity: 'warning', layerId: l.id, message: `${label(l)} is ${l.fontSize}px, too small to read at feed size (min ${Math.round(W * 0.018)}px).` });
      }
    }

    if (l.type === 'shape') {
      checkColor(l.fill, l, 'fill', 'fill');
      checkColor(l.stroke, l, 'stroke', 'stroke');
      if (l.label) {
        checkColor(l.labelColor, l, 'labelColor', 'label colour');
        if (l.labelFontFamily && !fonts.has(l.labelFontFamily)) {
          push({ rule: 'font', severity: 'error', layerId: l.id, message: `${l.name} label uses "${l.labelFontFamily}", not a brand font.`, fix: { layerId: l.id, patch: { labelFontFamily: profile.fonts.body.family } } });
        }
        const edge = backdrop.kind === 'color' ? contrastRatio(l.fill, backdrop.hex) : 21;
        const ratio = contrastRatio(l.labelColor ?? '#FFFFFF', l.fill);
        if (backdrop.kind === 'color' && edge < 1.6) {
          const fill = bestContrast(backdrop.hex, palette);
          push({
            rule: 'contrast', severity: 'error', layerId: l.id,
            message: `${l.name} button blends into the ${nameOf(backdrop.hex.toUpperCase())} area behind it (${edge.toFixed(1)}:1); give it a contrasting fill.`,
            fix: { layerId: l.id, patch: { fill, labelColor: bestContrast(fill, palette) } },
          });
        } else if (ratio < 3) {
          const better = bestContrast(l.fill, palette);
          push({ rule: 'contrast', severity: 'error', layerId: l.id, message: `${l.name} label contrast is ${ratio.toFixed(1)}:1 on its fill (needs 3:1).`, fix: { layerId: l.id, patch: { labelColor: better } } });
        }
      }
    }

    if (isLogoLayer(l, kit)) {
      const ratio = l.width / W;
      if (ratio < 0.1) push({ rule: 'logo', severity: 'error', layerId: l.id, message: `Logo is ${Math.round(ratio * 100)}% of canvas width; minimum is 10%.`, fix: { layerId: l.id, patch: { width: Math.round(W * 0.16), height: Math.round(l.height * ((W * 0.16) / l.width)) } } });
      else if (ratio > 0.4) push({ rule: 'logo', severity: 'warning', layerId: l.id, message: `Logo is ${Math.round(ratio * 100)}% of canvas width; it competes with the headline (keep under 40%).` });

      const asset = kit.assets.find((a) => a.id === (l.type === 'image' ? l.assetId : undefined));
      if (backdrop.kind === 'color' && asset?.colors?.[0]) {
        const behind = worstArea(backdrop, asset.colors[0]);
        const c = contrastRatio(asset.colors[0], behind);
        const best = bestLogoFor(behind, kit);
        const bc = best?.colors?.[0] ? contrastRatio(best.colors[0], behind) : 0;
        if (best && best.id !== asset.id && ((c < 2 && bc > c) || (c < 4.5 && bc >= c + 1.5))) {
          push({ rule: 'logo', severity: 'error', layerId: l.id, message: `Logo variant has low contrast (${c.toFixed(1)}:1) on ${behind}; use the ${kit.profile?.logos.find((x) => x.assetId === best.id)?.variant ?? best.filename} version.`, fix: { layerId: l.id, patch: { assetId: best.id, src: best.url } } });
        } else if (c < 2) {
          push({ rule: 'logo', severity: 'error', layerId: l.id, message: `Logo blends into the background (${c.toFixed(1)}:1 on ${behind}); move it onto a contrasting area.` });
        }
      } else if (backdrop.kind === 'image') {
        push({ rule: 'logo', severity: 'warning', layerId: l.id, message: 'Logo sits on a photo; use the pill/badge version or move it onto solid colour.' });
      }
    }

    const isContent = l.type === 'text' || (l.type === 'shape' && !!l.label) || isLogoLayer(l, kit);
    if (isContent) {
      if (l.x < -1 || l.y < -1 || l.x + l.width > W + 1 || l.y + l.height > H + 1) {
        push({ rule: 'bounds', severity: 'error', layerId: l.id, message: `${label(l)} is cut off by the canvas edge; move it fully inside the ${W}x${H} canvas.` });
      }
      if (H / W > 1.6) {
        const z = profile.safeZones?.find((s) => /story|9:16/i.test(s.format)) ?? DEFAULT_STORY_SAFE;
        if (l.y < H * z.top || l.y + l.height > H * (1 - z.bottom) || l.x < W * z.left || l.x + l.width > W * (1 - z.right)) {
          push({ rule: 'safe_zone', severity: 'warning', layerId: l.id, message: `${label(l)} is outside the story safe zone (top ${z.top * 100}%, bottom ${z.bottom * 100}%).` });
        }
      }
    }
  });

  for (const i of layoutLint(scene, kit, label)) push(i);
  return issues;
}

type Box = { x: number; y: number; w: number; h: number };
const boxOf = (l: Layer): Box => ({ x: l.x, y: l.y, w: l.width, h: l.height });
const areaOf = (b: Box) => Math.max(0, b.w) * Math.max(0, b.h);
const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Where the glyphs actually are: short lines only fill part of a wide text box, aligned left, centre or right. */
export function inkBox(l: Layer): Box {
  if (l.type !== 'text') return boxOf(l);
  const w = Math.min(l.width, Math.max(...wrapLines(l)));
  const x = l.align === 'center' ? l.x + (l.width - w) / 2 : l.align === 'right' ? l.x + l.width - w : l.x;
  return { x, y: l.y, w, h: l.height };
}

const DECOR_CATEGORIES = new Set(['logo', 'shape', 'icon', 'background_template']);

/** Photos, product shots, illustrations and generated images that text must not run into. */
function isVisual(l: Layer, kit: BrandKit, canvas: number): boolean {
  if (l.type !== 'image' || l.role === 'logo' || l.role === 'background' || l.role === 'decoration') return false;
  if (l.width * l.height > canvas * 0.55) return false;
  const category = l.assetId ? kit.assets.find((a) => a.id === l.assetId)?.category : undefined;
  return !category || !DECOR_CATEGORIES.has(category);
}

/** Solid panels that hold copy (the white card in a card layout). */
function isCard(l: Layer, canvas: number): boolean {
  if (l.type !== 'shape' || l.label || (l.opacity ?? 1) < 0.85) return false;
  const a = l.width * l.height;
  return l.role === 'card' || (a > canvas * 0.12 && a < canvas * 0.9);
}

/** Collisions, cropped visuals, copy spilling off its card, hidden copy and duplicates. */
function layoutLint(scene: Scene, kit: BrandKit, label: (l: Layer) => string): Omit<LintIssue, 'id'>[] {
  const out: Omit<LintIssue, 'id'>[] = [];
  const W = scene.width, H = scene.height, canvas = W * H;
  const content = scene.layers.filter((l) => l.type === 'text' || (l.type === 'shape' && !!l.label) || isLogoLayer(l, kit));
  const visuals = scene.layers.filter((l) => isVisual(l, kit, canvas));
  const cards = scene.layers.filter((l) => isCard(l, canvas));
  const err = (layerId: string, message: string) => out.push({ rule: 'layout', severity: 'error', layerId, message });

  for (let i = 0; i < content.length; i++) {
    for (let j = i + 1; j < content.length; j++) {
      const a = inkBox(content[i]), b = inkBox(content[j]);
      if (overlapArea(a, b) > 0.08 * Math.min(areaOf(a), areaOf(b))) {
        err(content[i].id, `${label(content[i])} overlaps ${label(content[j])}; move one so they have a clear gap.`);
      }
    }
  }

  for (const v of visuals) {
    for (const l of content) {
      const ink = inkBox(l);
      if (overlapArea(ink, boxOf(v)) > 0.04 * areaOf(ink)) {
        err(l.id, `${label(l)} runs into the image ${label(v)}; move or shrink the image or the text so they do not touch.`);
      }
    }
    const hidden = 1 - overlapArea(boxOf(v), { x: 0, y: 0, w: W, h: H }) / areaOf(boxOf(v));
    if (hidden > 0.12) err(v.id, `${label(v)} is cut off by the canvas edge (${Math.round(hidden * 100)}% hidden); move or shrink it so the subject is fully visible.`);
  }

  for (const l of content) {
    const ink = inkBox(l);
    const cx = ink.x + ink.w / 2, cy = ink.y + ink.h / 2;
    const z = scene.layers.indexOf(l);
    const card = cards.find((c) => scene.layers.indexOf(c) < z && cx > c.x && cx < c.x + c.width && cy > c.y && cy < c.y + c.height);
    if (card && overlapArea(ink, boxOf(card)) < areaOf(ink) - 2 * Math.max(ink.w, ink.h)) {
      err(l.id, `${label(l)} spills over the edge of ${label(card)}; keep it inside the card with padding or enlarge the card.`);
    }
    const cover = scene.layers.slice(z + 1).find((o) => {
      const opaque = o.type === 'image' ? o.role === 'background' || isVisual(o, kit, Infinity) : o.type === 'shape' && !o.label && (o.opacity ?? 1) > 0.85;
      return opaque && overlapArea(ink, boxOf(o)) > 0.3 * areaOf(ink);
    });
    if (cover) err(l.id, `${label(l)} is hidden behind ${label(cover)}; send ${cover.id} backward or move the text.`);
  }

  for (const v of visuals) {
    for (const c of cards) {
      const inside = overlapArea(boxOf(v), boxOf(c)) / areaOf(boxOf(v));
      if (inside > 0.15 && inside < 0.9 && scene.layers.indexOf(v) > scene.layers.indexOf(c)) {
        out.push({ rule: 'layout', severity: 'warning', layerId: v.id, message: `${label(v)} breaks out of ${label(c)}; fine if intentional, otherwise fit it inside the card.` });
      }
    }
  }

  const headlines = scene.layers.filter((l) => l.role === 'headline');
  const ctas = content.filter((l) => l.role === 'cta');
  if (headlines.length > 2) err(headlines[2].id, `There are ${headlines.length} headline layers (${headlines.map((h) => h.id).join(', ')}); keep one headline and delete duplicates.`);
  if (ctas.length > 1) err(ctas[1].id, `There are ${ctas.length} CTA layers (${ctas.map((c) => c.id).join(', ')}); keep exactly one.`);
  return out;
}

/** Applies every deterministic fix; returns the number applied. Mutates the scene. */
export function applyLintFixes(scene: Scene, issues: LintIssue[], onlyLayerId?: string): number {
  let applied = 0;
  for (const issue of issues) {
    if (!issue.fix || issue.severity !== 'error') continue;
    if ('background' in issue.fix) {
      if (onlyLayerId) continue;
      scene.background = issue.fix.background;
      applied++;
      continue;
    }
    const { layerId, patch } = issue.fix;
    if (onlyLayerId && layerId !== onlyLayerId) continue;
    const layer = scene.layers.find((l) => l.id === layerId);
    if (!layer) continue;
    Object.assign(layer, patch);
    applied++;
  }
  return applied;
}
