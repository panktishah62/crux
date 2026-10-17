import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { FRAME_KEYS, type Asset, type BrandKit, type FrameKey, type LayerRole, type LayoutTemplate, type SlotKind, type TemplateSlot } from '../../../shared/types.ts';
import { visionJson } from '../llm.ts';
import { parseReference, type LayoutSpec } from '../reference.ts';
import { sessionDir, urlToPath } from '../store.ts';
import { pMap } from '../util.ts';

const SLOT_KINDS: SlotKind[] = ['card', 'shape', 'decoration', 'photo', 'product_photo', 'illustration', 'icon', 'text', 'cta', 'logo'];
const ROLES: LayerRole[] = ['background', 'photo', 'illustration', 'decoration', 'card', 'headline', 'subheadline', 'body', 'offer', 'cta', 'logo', 'disclaimer', 'other'];

const clamp01 = (v: unknown) => Math.min(1, Math.max(0, Number(v) || 0));

function sanitizeFrame(f: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(f) || f.length !== 4) return undefined;
  const [x, y, w, h] = f.map(clamp01);
  if (w < 0.02 || h < 0.01) return undefined;
  return [x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)];
}

function sanitize(raw: any, sourceIds: string[]): LayoutTemplate | null {
  const slots: TemplateSlot[] = [];
  for (const [i, s] of (raw?.slots ?? []).entries()) {
    const kind = SLOT_KINDS.includes(s?.kind) ? (s.kind as SlotKind) : null;
    if (!kind) continue;
    const frames = {} as Record<FrameKey, [number, number, number, number]>;
    for (const k of FRAME_KEYS) {
      const f = sanitizeFrame(s.frames?.[k]);
      if (f) frames[k] = f;
    }
    const fallback = frames['4:5'] ?? frames['1:1'] ?? frames['9:16'];
    if (!fallback) continue;
    for (const k of FRAME_KEYS) frames[k] ??= fallback;
    slots.push({
      id: typeof s.id === 'string' && /^[\w-]{1,24}$/.test(s.id) ? s.id : `s${i}`,
      kind,
      role: ROLES.includes(s.role) ? s.role : kind === 'cta' ? 'cta' : kind === 'logo' ? 'logo' : kind === 'card' ? 'card' : 'other',
      frames,
      color: /^#[0-9a-f]{6}$/i.test(s.color ?? '') ? s.color.toUpperCase() : undefined,
      fontSizeRatio: s.fontSizeRatio ? Math.min(0.2, Math.max(0.012, Number(s.fontSizeRatio))) : undefined,
      fontWeight: s.fontWeight ? Number(s.fontWeight) : undefined,
      align: ['left', 'center', 'right'].includes(s.align) ? s.align : undefined,
      cornerRadiusRatio: s.cornerRadiusRatio ? Math.min(0.2, Math.max(0, Number(s.cornerRadiusRatio))) : undefined,
      example: typeof s.example === 'string' ? s.example.slice(0, 120) : undefined,
      maxWords: s.maxWords ? Number(s.maxWords) : undefined,
      notes: typeof s.notes === 'string' ? s.notes.slice(0, 160) : undefined,
    });
  }
  if (!slots.some((s) => s.kind === 'text')) return null;
  return {
    id: `tpl_${nanoid(5)}`,
    name: String(raw?.name ?? 'Layout').slice(0, 40),
    description: String(raw?.description ?? '').slice(0, 240),
    background: {
      color: /^#[0-9a-f]{6}$/i.test(raw?.background?.color ?? '') ? raw.background.color.toUpperCase() : undefined,
      useTemplateAsset: !!raw?.background?.useTemplateAsset,
    },
    slots,
    sourceAssetIds: sourceIds,
  };
}

/** Parses every reference and clusters them into 3-5 reusable slot templates with frames per aspect ratio. */
export async function extractTemplates(sessionId: string, kit: BrandKit, onProgress?: (msg: string) => void): Promise<LayoutTemplate[]> {
  const refs = kit.assets.filter((a) => a.category === 'reference').slice(0, 16);
  if (!refs.length) return [];

  let parsed = 0;
  const specs = (
    await pMap(refs, 4, async (a): Promise<{ asset: Asset; spec: LayoutSpec } | null> => {
      const p = urlToPath(a.url);
      if (!p || !fs.existsSync(p)) return null;
      try {
        const spec = await parseReference(sessionId, fs.readFileSync(p));
        onProgress?.(`Reading reference layouts ${++parsed}/${refs.length}...`);
        return { asset: a, spec };
      } catch (err) {
        console.warn('[archetypes] could not parse', a.filename, err);
        return null;
      }
    })
  ).filter((x): x is { asset: Asset; spec: LayoutSpec } => !!x);
  if (!specs.length) return [];

  onProgress?.('Clustering layout archetypes...');
  const profile = kit.profile;
  const prompt = `You are a senior designer turning a brand's reference ads into a small set of reusable layout templates.

Parsed reference layouts (bbox = fractions [x, y, w, h] of the canvas):
${specs.map(({ asset, spec }) => `## ${asset.id} (${asset.width}x${asset.height}) ${JSON.stringify({ summary: spec.summary, background: spec.background, elements: spec.elements })}`).join('\n')}

Brand palette: ${profile?.palette.map((c) => `${c.name} ${c.hex}`).join(', ') ?? 'unknown'}.
Has background template assets: ${kit.assets.some((a) => a.category === 'background_template')}.

Group the references into ${specs.length < 3 ? specs.length : '3-5'} distinct archetypes (e.g. "headline over photo card", "split product shot", "big stat"). For each, define slots with frames for all three aspect ratios: "1:1" (1080x1080), "4:5" (1080x1350) and "9:16" (1080x1920).
- Frames are fractions [x, y, w, h]. Adapt each ratio deliberately (taller formats stack vertically and use more height); keep text inside 6% side margins, and for 9:16 keep text and CTA between y=0.14 and y=0.65.
- Slot kinds: card (solid rounded panel behind text), shape (solid rect), decoration (brand blob/shape asset), photo (generated photograph), product_photo (device/UI asset), illustration, icon, text, cta (pill button), logo.
- Text slots need role (headline, subheadline, body, offer, disclaimer), fontSizeRatio (font size / canvas width, e.g. 0.09 headline, 0.035 body), fontWeight, align, maxWords and a short example copy from the reference.
- Colours: palette hex only. Give text slots a colour that contrasts with what is behind them. Cards that sit behind text need a colour.
- Order slots back to front. Every template needs exactly one headline, at most one cta and usually a logo. Give slots short ids (bg_card, photo, headline, sub, cta, logo...).

Respond as JSON:
{"templates":[{"name":"Photo card","description":"when to use it, one sentence","background":{"color":"#hex","useTemplateAsset":false},"sourceAssetIds":["..."],"slots":[{"id":"photo","kind":"photo","role":"photo","frames":{"1:1":[0,0,1,0.55],"4:5":[0,0,1,0.55],"9:16":[0,0,1,0.5]},"cornerRadiusRatio":0},{"id":"headline","kind":"text","role":"headline","frames":{"1:1":[0.07,0.6,0.86,0.2],"4:5":[0.07,0.6,0.86,0.18],"9:16":[0.07,0.52,0.86,0.12]},"color":"#hex","fontSizeRatio":0.09,"fontWeight":800,"align":"left","maxWords":6,"example":"..."}]}]}`;

  const thumbs = specs.slice(0, 10).flatMap(({ asset }) => {
    const p = asset.thumbUrl ? urlToPath(asset.thumbUrl) : null;
    return p && fs.existsSync(p) ? [{ label: `Reference ${asset.id}`, dataUrl: `data:image/png;base64,${fs.readFileSync(p).toString('base64')}` }] : [];
  });
  const res = await visionJson<{ templates: any[] }>(prompt, thumbs, { strong: true, maxTokens: 8000 });
  const refIds = new Set(refs.map((r) => r.id));
  const templates = (res.templates ?? [])
    .map((t) => sanitize(t, (t?.sourceAssetIds ?? []).filter((id: string) => refIds.has(id))))
    .filter((t): t is LayoutTemplate => !!t)
    .slice(0, 5);
  fs.writeFileSync(path.join(sessionDir(sessionId), 'archetypes.json'), JSON.stringify(templates, null, 2));
  return templates;
}
