import type { BrandKit, Layer, Scene, TextLayer } from './types.ts';

export type ParamKey = 'hook' | 'clarity' | 'readability' | 'visual_focus' | 'cta' | 'brand' | 'layout';
export type VariantId = 'v1' | 'v2' | 'v3' | 'v4';
export type CreativeId = 'original' | VariantId;

export const PARAM_KEYS: ParamKey[] = ['hook', 'clarity', 'readability', 'visual_focus', 'cta', 'brand', 'layout'];
export const VARIANT_IDS: VariantId[] = ['v1', 'v2', 'v3', 'v4'];

export const PARAM_LABEL: Record<ParamKey, string> = {
  hook: 'Hook', clarity: 'Clarity', readability: 'Readability', visual_focus: 'Visual focus', cta: 'CTA', brand: 'Brand', layout: 'Layout',
};

/** Feed performance is decided by the hook first, then CTA, focus, clarity and legibility. */
export const WEIGHTS: Record<ParamKey, number> = {
  hook: 0.2, cta: 0.15, visual_focus: 0.15, clarity: 0.15, readability: 0.15, brand: 0.1, layout: 0.1,
};

type Box = Pick<Layer, 'x' | 'y' | 'width' | 'height'>;

/** Layers that carry the message: text, labelled buttons and the logo. These must never collide. */
export const isContentLayer = (l: Layer): boolean => l.type === 'text' || (l.type === 'shape' && !!l.label) || l.role === 'logo';

/** True when two boxes share more than `ratio` of the smaller one's area. */
export function boxesOverlap(a: Box, b: Box, ratio = 0.08): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return false;
  return (w * h) / Math.max(1, Math.min(a.width * a.height, b.width * b.height)) > ratio;
}

/** Pairs of content layers that collide, as "idA|idB". */
export function contentOverlaps(scene: Scene): string[] {
  const content = scene.layers.filter(isContentLayer);
  const pairs: string[] = [];
  for (let i = 0; i < content.length; i++) {
    for (let j = i + 1; j < content.length; j++) if (boxesOverlap(content[i], content[j])) pairs.push(`${content[i].id}|${content[j].id}`);
  }
  return pairs;
}

const TEXT_GEOMETRY = ['text', 'fontSize', 'width', 'x', 'y', 'fontFamily', 'fontWeight', 'uppercase', 'lineHeight', 'letterSpacing'] as const;

/**
 * Shrinks rewritten or moved text until it stops at the next content layer below it (one it did not already touch in the
 * original) and stays inside the canvas. `measure` returns the rendered height: an estimate on the server, exact in the browser.
 * Returns the ids of layers whose font size changed.
 */
export function fitTextLayers(original: Scene, variant: Scene, measure: (l: TextLayer) => number): string[] {
  const W = variant.width, H = variant.height;
  const gap = Math.round(H * 0.015);
  const before = new Map(original.layers.map((l) => [l.id, l]));
  const touchedBefore = new Set(contentOverlaps(original));
  const fitted: string[] = [];
  for (const l of variant.layers) {
    if (l.type !== 'text') continue;
    const prev = before.get(l.id);
    const edited = !prev || prev.type !== 'text' || TEXT_GEOMETRY.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(l[k]));
    if (!edited) continue;
    const below = variant.layers.filter(
      (o) => o !== l && isContentLayer(o) && o.y >= l.y + 1 && o.x < l.x + l.width && o.x + o.width > l.x
        && !touchedBefore.has(`${l.id}|${o.id}`) && !touchedBefore.has(`${o.id}|${l.id}`),
    );
    const floor = Math.min(H * 0.97, ...below.map((o) => o.y - gap));
    const prevHeight = prev?.type === 'text' ? measure(prev) : Infinity;
    const budget = Math.min(floor - l.y, prevHeight * 1.6);
    const min = Math.round(W * (l.role === 'headline' ? 0.045 : 0.022));
    const start = l.fontSize;
    l.height = measure(l);
    while (l.height > budget && l.fontSize > min) {
      l.fontSize = Math.max(min, Math.floor(l.fontSize * 0.94));
      l.height = measure(l);
    }
    if (l.fontSize !== start) fitted.push(l.id);
  }
  return fitted;
}

/** Computed in code from the scene graph (and rendered pixels for text over photos), never by a model. */
export interface Measurements {
  headline: { text: string; words: number; heightRatio: number; contrast: number } | null;
  minTextHeightRatio: number;
  minTextContrast: number;
  cta: { present: boolean; text: string | null; contrast: number | null };
  logo: { present: boolean; areaRatio: number; onBusyBackground: boolean };
  offPaletteColors: string[];
  offBrandFonts: string[];
  outsideSafeZone: string[];
  textCoverage: number;
  elementCount: number;
  /** Colliding content layer pairs ("idA|idB"). */
  overlaps: string[];
}

export interface ParamScore {
  score: 1 | 2 | 3 | 4 | 5;
  reason: string;
}

export type ParamScores = Record<ParamKey, ParamScore>;

export interface Analysis {
  params: ParamScores;
  hookType: 'pain' | 'benefit' | 'curiosity' | 'offer' | 'social_proof' | 'other';
  visualType: 'person' | 'product_ui' | 'product_photo' | 'illustration' | 'none';
  opportunities: { param: ParamKey; idea: string }[];
  total: number;
  flags: string[];
  measurements: Measurements;
}

export interface SceneOp {
  tool: 'update_layer' | 'add_layer' | 'delete_layer' | 'generate_image' | 'set_background' | 'apply_layout';
  args: Record<string, unknown>;
}

export interface VariantPlan {
  id: VariantId;
  param: ParamKey;
  changed: string;
  why: string;
  hypothesis: string;
  ops: SceneOp[];
}

export interface BuiltVariant {
  id: VariantId;
  plan: VariantPlan;
  scene: Scene | null;
  error?: string;
  notes: string[];
}

export interface ScoredCreative {
  id: CreativeId;
  params: ParamScores;
  total: number;
  delta: number;
  rank: number | null;
  flags: string[];
  hookType?: Analysis['hookType'];
  visualType?: Analysis['visualType'];
}

export type TestLabEvent =
  | { type: 'step'; text: string }
  | { type: 'measured'; measurements: Measurements }
  | { type: 'analysed'; analysis: Analysis }
  | { type: 'planned'; plans: VariantPlan[] }
  | { type: 'variant_built'; variant: BuiltVariant }
  | { type: 'scored'; scores: ScoredCreative[] }
  | { type: 'ranked'; original: ScoredCreative; variants: ScoredCreative[]; noClearWinner: boolean }
  | { type: 'error'; text: string }
  | { type: 'done' };

/** 1-5 scores -> 0-100 total. */
export function totalScore(p: ParamScores): number {
  return Math.round(100 * PARAM_KEYS.reduce((s, k) => s + WEIGHTS[k] * (p[k].score - 1) / 4, 0));
}

/** Flagged variants rank last, then by total, then by delta. */
export function rankCreatives(original: ScoredCreative, variants: ScoredCreative[]): ScoredCreative[] {
  for (const v of variants) v.delta = v.total - original.total;
  return [...variants]
    .sort((a, b) => (a.flags.length > 0 ? 1 : 0) - (b.flags.length > 0 ? 1 : 0) || b.total - a.total || b.delta - a.delta)
    .map((v, i) => ({ ...v, rank: i + 1 }));
}

const HEADLINE_ROLES = new Set(['headline']);

/** The "born tagged" export: creative attributes built in code from the plan, scene and scores. */
export function buildTags(
  id: CreativeId,
  scene: Scene,
  kit: BrandKit,
  opts: { plan?: VariantPlan; analysis?: Analysis | null; scored?: ScoredCreative | null },
) {
  const headline = scene.layers
    .filter((l) => l.type === 'text')
    .sort((a, b) => Number(HEADLINE_ROLES.has(b.role ?? '')) - Number(HEADLINE_ROLES.has(a.role ?? '')) || (b.type === 'text' && a.type === 'text' ? b.fontSize - a.fontSize : 0))[0];
  const cta = scene.layers.find((l) => l.type === 'shape' && !!l.label);
  const colors = new Set<string>([scene.background.toUpperCase()]);
  for (const l of scene.layers) {
    if (l.type === 'text') colors.add(l.fill.toUpperCase());
    if (l.type === 'shape') colors.add(l.fill.toUpperCase());
  }
  const assets = scene.layers.flatMap((l) => {
    if (l.type !== 'image' || !l.assetId) return [];
    const a = kit.assets.find((x) => x.id === l.assetId);
    return a ? [`${a.category}_${a.filename.replace(/\.[a-z0-9]+$/i, '')}`] : [];
  });
  const templateId = opts.plan?.ops.find((o) => o.tool === 'apply_layout')?.args.templateId;
  const archetype = kit.templates?.find((t) => t.id === templateId)?.name ?? 'custom';
  const hookType = opts.scored?.hookType ?? opts.analysis?.hookType ?? 'other';
  const visualType = opts.scored?.visualType ?? opts.analysis?.visualType ?? 'none';
  const headlineText = headline?.type === 'text' ? headline.text.replace(/\s+/g, ' ').trim() : null;
  return {
    creative_id: id,
    parent_id: id === 'original' ? null : 'original',
    test: opts.plan ? { parameter: opts.plan.param, changed: opts.plan.changed, hypothesis: opts.plan.hypothesis } : null,
    attributes: {
      hook_type: hookType,
      headline: headlineText,
      headline_words: headlineText ? headlineText.split(' ').length : 0,
      visual_type: visualType,
      cta_text: cta?.type === 'shape' ? cta.label ?? null : null,
      archetype,
      format: `${scene.width}x${scene.height}`,
      colors: [...colors],
      assets: [...new Set(assets)],
    },
    predicted: opts.scored ? { total: opts.scored.total, delta: opts.scored.delta, rank: opts.scored.rank } : null,
  };
}
