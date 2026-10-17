import type { BrandKit, Layer, Scene } from '../../../shared/types.ts';
import type { ParamKey } from '../../../shared/testlab.ts';
import { isLogoLayer } from '../../../shared/lint.ts';

interface LayerChange {
  layer: Layer;
  kind: 'added' | 'removed' | 'changed';
  fields: string[];
}

/**
 * Fields that follow from other edits (text height, image generation state) and are never a change on their own.
 * A new prompt on an image is a regeneration whose pixels land after the guard runs, so it does count.
 */
const DERIVED = new Set(['height', 'pending', 'name']);

function diffScenes(a: Scene, b: Scene): { changes: LayerChange[]; background: boolean; order: boolean } {
  const before = new Map(a.layers.map((l) => [l.id, l]));
  const after = new Map(b.layers.map((l) => [l.id, l]));
  const changes: LayerChange[] = [];
  for (const [id, l] of after) {
    const prev = before.get(id);
    if (!prev) {
      changes.push({ layer: l, kind: 'added', fields: [] });
      continue;
    }
    const keys = new Set([...Object.keys(prev), ...Object.keys(l)]);
    const fields = [...keys].filter((k) => JSON.stringify((prev as any)[k]) !== JSON.stringify((l as any)[k]));
    const textResize = l.type === 'text' ? [] : fields.filter((f) => f === 'height');
    const meaningful = fields.filter((f) => !DERIVED.has(f)).concat(textResize);
    if (meaningful.length) changes.push({ layer: l, kind: 'changed', fields: meaningful });
  }
  for (const [id, l] of before) if (!after.has(id)) changes.push({ layer: l, kind: 'removed', fields: [] });
  const common = a.layers.map((l) => l.id).filter((id) => after.has(id));
  const order = common.join() !== b.layers.map((l) => l.id).filter((id) => before.has(id)).join();
  return { changes, background: a.background.toUpperCase() !== b.background.toUpperCase(), order };
}

const VISUAL_ROLES = new Set(['photo', 'illustration', 'background']);
const COLOR_FIELDS = new Set(['fill', 'stroke', 'labelColor']);
const GEOMETRY = new Set(['x', 'y', 'width', 'height', 'rotation', 'cornerRadius', 'fontSize', 'labelFontSize']);
const TEXT_STYLE = new Set(['fontSize', 'fontWeight', 'fill', 'width', 'x', 'y', 'lineHeight', 'letterSpacing', 'uppercase']);
const subset = (fields: string[], allowed: Set<string>) => fields.every((f) => allowed.has(f));

function textContents(scene: Scene): string {
  return scene.layers
    .flatMap((l) => (l.type === 'text' ? [l.text] : l.type === 'shape' && l.label ? [l.label] : []))
    .map((t) => t.replace(/\s+/g, ' ').trim().toLowerCase())
    .sort()
    .join('|');
}

function describe(c: LayerChange): string {
  const name = c.layer.type === 'text' ? `“${c.layer.text.slice(0, 30)}”` : `${c.layer.role ?? c.layer.type} ${c.layer.id}`;
  return c.kind === 'changed' ? `${name} (${c.fields.join(', ')})` : `${c.kind} ${name}`;
}

/**
 * One change per variant: every edit must fall inside the layers the tested parameter may touch.
 * Returns null when the variant is a clean single-parameter test, else the reason it is not.
 */
export function guardVariant(param: ParamKey, original: Scene, variant: Scene, kit: BrandKit, usedLayout: boolean): string | null {
  const { changes, background, order } = diffScenes(original, variant);
  if (!changes.length && !background && !order) return 'the variant made no visible change';
  const hadHeadline = original.layers.some((l) => l.type === 'text' && l.role === 'headline');
  const hadCta = original.layers.some((l) => l.type === 'shape' && !!l.label);
  const hadLogo = original.layers.some((l) => isLogoLayer(l, kit));

  if (param === 'layout' && usedLayout) {
    return textContents(original) === textContents(variant) ? null : 'a layout test must keep every word of copy identical';
  }

  const allowed = (c: LayerChange): boolean => {
    const l = c.layer;
    const isText = l.type === 'text';
    const isCta = l.type === 'shape' && (!!l.label || l.role === 'cta');
    const isLogo = isLogoLayer(l, kit);
    switch (param) {
      case 'hook':
        if (!isText || l.role !== 'headline') return false;
        return c.kind === 'changed' ? subset(c.fields, new Set(['text', 'fontSize', 'width', 'y', 'uppercase'])) : c.kind === 'added' && !hadHeadline;
      case 'clarity':
        if (!isText || l.role === 'headline') return false;
        return c.kind === 'removed' || (c.kind === 'changed' && subset(c.fields, new Set(['text', 'fontSize'])));
      case 'readability':
        if (c.kind !== 'changed') return false;
        if (isText) return subset(c.fields, TEXT_STYLE);
        if (isCta) return subset(c.fields, new Set(['labelColor', 'labelFontSize', 'labelFontWeight']));
        return l.type === 'shape' && subset(c.fields, new Set(['fill', 'opacity']));
      case 'visual_focus': {
        const asset = l.type === 'image' && l.assetId ? kit.assets.find((a) => a.id === l.assetId) : undefined;
        return l.type === 'image' && !isLogo && (VISUAL_ROLES.has(l.role ?? '') || asset?.category === 'product_photo' || asset?.category === 'illustration');
      }
      case 'cta':
        return isCta && (c.kind !== 'added' || !hadCta);
      case 'brand':
        if (isLogo) return c.kind !== 'added' || !hadLogo;
        return c.kind === 'changed' && subset(c.fields, COLOR_FIELDS);
      case 'layout':
        return c.kind === 'changed' && subset(c.fields, GEOMETRY);
    }
  };

  const bad = changes.filter((c) => !allowed(c));
  if (background && param !== 'brand' && param !== 'visual_focus') bad.push({ layer: { id: 'canvas', type: 'shape', name: 'canvas background', role: 'background' } as Layer, kind: 'changed', fields: ['background'] });
  if (order && param !== 'layout' && param !== 'visual_focus') return `a ${param} test may not reorder layers`;
  if (!bad.length) return null;
  return `a ${param} test may only change ${ALLOWED_TEXT[param]}, but it also changed ${bad.slice(0, 3).map(describe).join('; ')}`;
}

export const ALLOWED_TEXT: Record<ParamKey, string> = {
  hook: 'the headline text',
  clarity: 'subheadline/body text (shorten or remove)',
  readability: 'text size, weight and colour, and the card behind text',
  visual_focus: 'the hero image, illustration or product shot (generate_image allowed)',
  cta: 'the CTA button and its text',
  brand: 'the logo (variant, size) and colours',
  layout: 'positions and sizes of layers, or apply_layout, with no copy changes',
};
