import sharp from 'sharp';
import { z } from 'zod';
import type { BrandKit, ImageLayer, Layer, LayoutTemplate, Scene } from '../../../shared/types.ts';
import { applyLintFixes, lintScene } from '../../../shared/lint.ts';
import {
  PARAM_KEYS, VARIANT_IDS, fitTextLayers, rankCreatives, totalScore,
  type Analysis, type BuiltVariant, type ParamKey, type ParamScores, type ScoredCreative, type TestLabEvent, type VariantId, type VariantPlan,
} from '../../../shared/testlab.ts';
import { config } from '../config.ts';
import { askValidated, parseJsonLoose, pro, visionJson, withRetry } from '../llm.ts';
import { describeScene, estimateTextHeight } from '../scene/ops.ts';
import { runTool, type ToolContext } from '../agent/tools.ts';
import { applyCaps, decodeRender, measureScene } from './measure.ts';
import { ALLOWED_TEXT, guardVariant } from './guard.ts';

type Emit = (e: TestLabEvent) => void;

const RUBRIC = `RUBRIC (score each parameter 1-5; 2 and 4 fall between the anchors)
hook
1 = no hook; names the product or category ("Accounting software")
3 = clear but generic benefit ("Save time on admin")
5 = specific, emotional, scroll-stopping in 6 words or fewer ("Stop chasing invoices")
clarity
1 = three or more competing messages
3 = one main message, distracted by secondary text
5 = one idea, understood in one second
readability
1 = key text unreadable on a phone or low contrast
3 = headline fine, secondary text too small or faint
5 = every word legible in a phone feed, strong contrast
visual_focus
1 = no focal point, or cluttered
3 = a focal point exists but competes or is unrelated to the message
5 = one strong focal point that supports the message
cta
1 = no CTA
3 = CTA present but vague ("Learn more") or easy to miss
5 = specific action CTA ("Start free trial"), high contrast, clearly a button
brand
1 = logo missing, or off-brand colours or fonts
3 = brand present but weak or small
5 = instantly recognisable, fully on-brand
layout
1 = cluttered, overlapping or cut-off elements, outside safe zones
3 = acceptable but unbalanced
5 = clean hierarchy, generous spacing, inside safe zones`;

const ROLES_LIST = ['background', 'photo', 'illustration', 'decoration', 'card', 'headline', 'subheadline', 'body', 'offer', 'cta', 'logo', 'disclaimer', 'other'] as const;
const ROLES = new Set<string>(ROLES_LIST);

/** Tie-break order when several parameters share the lowest score. */
const IMPACT: ParamKey[] = ['hook', 'cta', 'visual_focus', 'clarity', 'readability', 'layout', 'brand'];

const paramScore = z.object({
  score: z.coerce.number().int().min(1).max(5),
  reason: z.string().min(3),
});
const paramsSchema = z.object(Object.fromEntries(PARAM_KEYS.map((k) => [k, paramScore])) as Record<ParamKey, typeof paramScore>);
const HOOK_TYPES = ['pain', 'benefit', 'curiosity', 'offer', 'social_proof', 'other'] as const;
const VISUAL_TYPES = ['person', 'product_ui', 'product_photo', 'illustration', 'none'] as const;

const analysisSchema = z.object({
  params: paramsSchema,
  hookType: z.enum(HOOK_TYPES).catch('other'),
  visualType: z.enum(VISUAL_TYPES).catch('none'),
  opportunities: z.array(z.object({ param: z.enum(PARAM_KEYS as [ParamKey, ...ParamKey[]]), idea: z.string().min(3) })).min(3),
});

const opSchema = z.object({
  tool: z.enum(['update_layer', 'add_layer', 'delete_layer', 'generate_image', 'set_background', 'apply_layout']),
  args: z.record(z.string(), z.unknown()),
});
const planSchema = z.object({
  id: z.enum(VARIANT_IDS as [VariantId, ...VariantId[]]),
  param: z.enum(PARAM_KEYS as [ParamKey, ...ParamKey[]]),
  changed: z.string().min(3),
  why: z.string().min(3),
  hypothesis: z.string().min(3),
  ops: z.array(opSchema).min(1),
});
const plansSchema = z.object({ variants: z.array(planSchema).min(3).max(4) });

function brandSummary(kit: BrandKit): string {
  const p = kit.profile;
  if (!p) return 'No brand kit uploaded.';
  return `${p.name}. Palette: ${p.palette.map((c) => `${c.name} ${c.hex}`).join(', ')}. Fonts: ${p.fonts.headline.family} (headlines), ${p.fonts.body.family} (body). Tone: ${p.tone ?? 'n/a'}.`;
}

/** The 3 weakest parameters by final score, ties broken by likely impact; a measured cap's fix wins over the model's idea. */
function weakest(params: ParamScores, ideas: { param: ParamKey; idea: string }[], fixes: Partial<Record<ParamKey, string>>): Analysis['opportunities'] {
  return [...PARAM_KEYS]
    .sort((a, b) => params[a].score - params[b].score || IMPACT.indexOf(a) - IMPACT.indexOf(b))
    .slice(0, 3)
    .map((param) => ({ param, idea: fixes[param] ?? ideas.find((o) => o.param === param)?.idea ?? params[param].reason }));
}

// Steps 1-2

export async function analyse(input: { scene: Scene; png: string; kit: BrandKit }, emit: Emit): Promise<Analysis> {
  const { scene, png, kit } = input;
  const measurements = measureScene(scene, kit, await decodeRender(png, scene));
  emit({ type: 'measured', measurements });

  const system = `You are a senior performance creative strategist reviewing a static social ad.
Judge it as a viewer scrolling a phone feed who gives it about one second.
${RUBRIC}
Rules:
- The MEASUREMENTS are exact facts computed from the design file. Trust them over your eyes (e.g. if minTextContrast is 2.1, small text IS low contrast).
- Each reason is one sentence, specific to THIS ad. Quote its text where useful. Never write generic advice like "consider improving the headline".
- opportunities = one idea for EVERY parameter scoring below 5 (at least 3), weakest first. Break ties by likely impact: hook > cta > visual_focus > clarity > readability > layout > brand. Each idea is one concrete change, not a direction.
- Reply with JSON only, matching the schema.`;
  const user = `BRAND: ${brandSummary(kit)}
MEASUREMENTS: ${JSON.stringify(measurements)}
Schema:
{"params":{"<param>":{"score":1-5,"reason":"..."}} /* all 7: ${PARAM_KEYS.join(', ')} */,"hookType":"pain|benefit|curiosity|offer|social_proof|other","visualType":"person|product_ui|product_photo|illustration|none","opportunities":[{"param":"...","idea":"..."}] /* every parameter below 5, at least 3 */}`;

  const raw = await askValidated(
    (feedback) => visionJson(feedback ? `${user}\n\n${feedback}` : user, [{ dataUrl: png, label: 'original.png' }], { strong: true, detail: 'high', system, temperature: 0.1, seed: 7, maxTokens: 1500 }),
    analysisSchema,
    'analyse',
  );
  const { params, flags, fixes } = applyCaps(raw.params as ParamScores, measurements, kit);
  return {
    params,
    hookType: raw.hookType,
    visualType: raw.visualType,
    opportunities: weakest(params, raw.opportunities, fixes),
    total: totalScore(params),
    flags,
    measurements,
  };
}

// Steps 3-4

const OP_DOCS = `ops use the copilot's tool schemas:
- update_layer {"layerId","changes":{x,y,width,height,text,fontSize,fontWeight,fill,align,lineHeight,uppercase,cornerRadius,label,labelColor,labelFontSize,opacity,assetId}}
- add_layer {"kind":"text"|"shape"|"asset"|"image", ...}: text {text,role,x,y,width,fontSize,fill}; shape {shape:"rect",role:"cta",x,y,width,height,fill,cornerRadius,label,labelColor}; asset {assetId,role,x,y,width}; image {prompt (required),role,x,y,width,height}
  role is one of: ${[...ROLES_LIST].join(', ')}
- delete_layer {"layerId"}
- generate_image {"layerId","prompt"} (replace the pixels of an existing photo or illustration layer in place; photos/scenes only)
To swap the hero visual, prefer generate_image on the existing hero layer, or update_layer {"assetId"} to a product_photo/illustration asset. Do not delete and re-add it.
Never let text overlap other text, the CTA or the logo.
- set_background {"color"}
- apply_layout {"templateId","texts":{slotId: copy},"imagePrompts":{slotId: prompt}} (switch archetype; texts must reuse the original copy word for word)`;

function planContext(scene: Scene, analysis: Analysis, kit: BrandKit): string {
  const assets = kit.assets
    .filter((a) => !['guideline_page', 'font', 'reference', 'other'].includes(a.category))
    .map((a) => `${a.id} [${a.category}] ${a.description ?? a.filename}`.slice(0, 120));
  const copyCount = scene.layers.filter((l) => copyOf(l)).length;
  const archetypes = (kit.templates ?? [])
    .filter((t) => Object.keys(originalCopyBySlot(t, scene)).length === copyCount)
    .map((t) => `${t.id} "${t.name}": slots ${t.slots.map((s) => `${s.id}(${s.kind === 'text' ? s.role : s.kind})`).join(', ')}`);
  const { measurements, ...rest } = analysis;
  return `SCENE: ${describeScene(scene)}
ANALYSIS: ${JSON.stringify(rest)}
BRAND: ${JSON.stringify(kit.profile ?? {})}
ASSETS: ${assets.join('\n') || '(none)'}
ARCHETYPES (only those that can hold every line of the original copy): ${archetypes.join('\n') || '(none fit; a layout test must move/resize the existing layers with update_layer)'}
ALLOWED EDITS PER PARAMETER: ${PARAM_KEYS.map((k) => `${k}: ${ALLOWED_TEXT[k]}`).join('; ')}
${OP_DOCS}`;
}

const PLAN_SYSTEM = `You design A/B tests for static ads. Given an ad's analysis, plan exactly 4 variants. Each variant changes ONE parameter of the original and nothing else, so a test can isolate what caused a difference.
Which parameters to test:
- v1, v2, v3 target the 3 opportunities, in order.
- v4 is a bolder test of visual_focus or layout (e.g. swap the person photo for product UI, or switch to another archetype from ARCHETYPES), unless one of the opportunities already covers that parameter; then pick the next-weakest parameter.
Hard rules:
- Never invent facts. No new numbers, prices, discounts, stats or claims that are not in the original. Rewrite wording only.
- Headlines: 6 words or fewer, in the brand's tone.
- Use only palette colours, brand fonts and asset ids from ASSETS.
- ops may only touch the layers related to the tested parameter (see ALLOWED EDITS). Reference existing layer ids from SCENE. Use generate_image only for photos or scenes, never for text or logos.
- When text gets longer or shorter, keep its box (x, width) and let the system fit the font size.
- "changed" says exactly what changed, before -> after, in under 15 words.
- "why" cites the original's score and reason for that parameter in one sentence. "hypothesis" is one line: "<variant choice> beats <original choice>".
- Reply with JSON only.`;

async function deepseekJson(system: string, user: string, signal?: AbortSignal): Promise<unknown> {
  const res = await withRetry(
    () => pro.chat.completions.create({ model: config.pro.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.7 }, { signal }),
    'testlab-plan',
  );
  return parseJsonLoose(res.choices[0]?.message?.content ?? '');
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Planner add_layer args drift from the tool schema (made-up roles, image without a prompt); map them onto valid input. */
function normalizeAddLayer(raw: Record<string, unknown>, plan: VariantPlan, kit: BrandKit): Record<string, unknown> {
  const args = { ...raw };
  const asset = typeof args.assetId === 'string' ? kit.assets.find((a) => a.id === args.assetId) : undefined;
  if (asset) args.kind = 'asset';
  args.kind ??= args.text ? 'text' : args.label ? 'shape' : 'image';
  if (typeof args.role === 'string' && !ROLES.has(args.role)) {
    const r = args.role.toLowerCase();
    args.role = /photo|hero|product|image|visual/.test(r) ? (asset?.category === 'illustration' ? 'illustration' : 'photo')
      : /illustr/.test(r) ? 'illustration' : /button/.test(r) ? 'cta' : /title|head/.test(r) ? 'headline' : 'other';
  }
  if (args.kind === 'image' && (typeof args.prompt !== 'string' || args.prompt.length < 5)) {
    const hint = [args.description, args.subject, args.alt, args.name].find((v) => typeof v === 'string' && v.length >= 5);
    args.prompt = hint ?? plan.changed.split(/->|→| to /).pop()!.trim();
  }
  for (const k of ['description', 'subject', 'alt']) delete args[k];
  return args;
}

/** Brand guidelines on every layer the variant touched: fix off-palette colours, off-brand fonts, low contrast and wrong logo variants. */
function enforceBrand(original: Scene, scene: Scene, kit: BrandKit): number {
  if (!kit.profile) return 0;
  const before = new Map(original.layers.map((l) => [l.id, JSON.stringify(l)]));
  const touched = new Set(scene.layers.filter((l) => before.get(l.id) !== JSON.stringify(l)).map((l) => l.id));
  const issues = lintScene(scene, kit).filter((i) => i.fix && i.severity === 'error' && (i.layerId ? touched.has(i.layerId) : scene.background !== original.background));
  return applyLintFixes(scene, issues);
}

const OP_TOOL: Record<string, string> = {
  update_layer: 'update_layer', delete_layer: 'delete_layer', generate_image: 'generate_image', set_background: 'set_background', apply_layout: 'apply_layout',
};

const copyOf = (l: Layer) => (l.type === 'text' ? l.text : l.type === 'shape' ? l.label : undefined);

/** A layout test moves the original copy into the new archetype: each text/CTA slot takes the original copy with the same role. */
function originalCopyBySlot(template: LayoutTemplate, original: Scene): Record<string, string> {
  const pool = original.layers.filter((l) => copyOf(l));
  const texts: Record<string, string> = {};
  for (const slot of template.slots) {
    if (slot.kind !== 'text' && slot.kind !== 'cta') continue;
    const i = pool.findIndex((l) => (slot.kind === 'cta' ? l.type === 'shape' : l.type === 'text' && l.role === slot.role));
    if (i >= 0) texts[slot.id] = copyOf(pool.splice(i, 1)[0])!;
  }
  return texts;
}

/** Drops template example copy the original never had and puts the original photo back, so only geometry changes. */
function keepOriginalContent(original: Scene, scene: Scene): void {
  const photo = original.layers.find((l): l is ImageLayer => l.type === 'image' && l.role === 'photo');
  const copy = new Set(original.layers.map(copyOf).filter(Boolean));
  scene.layers = scene.layers.filter((l) => {
    const text = copyOf(l);
    if (text) return copy.has(text);
    if (l.type === 'image' && l.role === 'photo') {
      if (!photo) return false;
      Object.assign(l, { src: photo.src, assetId: photo.assetId, prompt: photo.prompt, pending: false });
    }
    return true;
  });
}

/** Applies a plan's ops to a copy of the original, generating images where needed, then enforces the one-change rule. */
async function buildVariant(sessionId: string, kit: BrandKit, original: Scene, plan: VariantPlan): Promise<{ scene?: Scene; notes: string[]; error?: string }> {
  const scene = structuredClone(original);
  const notes: string[] = [];
  const ctx: ToolContext = {
    sessionId, scene, kit, pending: [],
    emitScene: () => {},
    emitStep: (t) => {
      if (t.startsWith('Image generation failed')) notes.push('Image generation failed, so the original image was kept');
    },
  };
  for (const op of plan.ops) {
    let out: string;
    if (op.tool === 'add_layer') {
      const args = normalizeAddLayer(op.args, plan, kit);
      out = await runTool(ctx, 'add_layers', JSON.stringify({ layers: [args] }));
      const item = JSON.parse(out.startsWith('[') ? out : '[]')[0];
      if (item?.error || item?.skipped) return { notes, error: `add_layer failed: ${item.error ?? item.skipped}` };
    } else if (op.tool === 'apply_layout') {
      const template = kit.templates?.find((t) => t.id === op.args.templateId);
      const texts = template ? originalCopyBySlot(template, original) : op.args.texts;
      out = await runTool(ctx, 'apply_layout', JSON.stringify({ ...op.args, replace: true, texts, imagePrompts: undefined }));
      if (template && !out.startsWith('Error')) keepOriginalContent(original, scene);
    } else {
      out = await runTool(ctx, OP_TOOL[op.tool], JSON.stringify(op.args));
    }
    if (out.startsWith('Error')) return { notes, error: `${op.tool}: ${out.replace(/^Error:\s*/, '').slice(0, 240)}` };
  }
  if (fitTextLayers(original, scene, estimateTextHeight).length) notes.push('Text size auto-fitted');
  const violation = guardVariant(plan.param, original, scene, kit, plan.ops.some((o) => o.tool === 'apply_layout'));
  if (violation) return { notes, error: violation };
  const brandFixes = enforceBrand(original, scene, kit);
  if (brandFixes) notes.push(`${brandFixes} brand fix${brandFixes > 1 ? 'es' : ''} applied`);
  await Promise.all(ctx.pending);
  for (const l of scene.layers) if (l.type === 'image') l.pending = false;
  return { scene, notes };
}

/**
 * Every variant must test a different parameter. A repeat is moved to the first unused one (visual focus, then layout,
 * then the weakest remaining) and gets a re-plan reason. Mutates `plans`; returns the reason per index.
 */
function distinctParams(plans: VariantPlan[], analysis: Analysis): (string | undefined)[] {
  const used = new Set<ParamKey>();
  const byWeakness = [...PARAM_KEYS].sort((a, b) => analysis.params[a].score - analysis.params[b].score || IMPACT.indexOf(a) - IMPACT.indexOf(b));
  const candidates: ParamKey[] = ['visual_focus', 'layout', ...byWeakness];
  return plans.map((p, i) => {
    let reason: string | undefined;
    if (used.has(p.param)) {
      const dupOf = plans.slice(0, i).find((x) => x.param === p.param)!;
      const next = candidates.find((k) => !used.has(k) && !plans.slice(i + 1).some((x) => x.param === k))!;
      reason = `it tests "${p.param}" again, which ${dupOf.id} already tests; this variant must test "${next}" instead`;
      plans[i] = { ...p, param: next };
    }
    used.add(plans[i].param);
    return reason;
  });
}

export async function planAndBuild(input: { sessionId: string; scene: Scene; analysis: Analysis; kit: BrandKit; only?: VariantPlan; signal?: AbortSignal }, emit: Emit): Promise<void> {
  const { sessionId, scene, analysis, kit } = input;
  const context = planContext(scene, analysis, kit);
  const schemaHint = `Schema:\n{"variants":[{"id":"v1|v2|v3|v4","param":"${PARAM_KEYS.join('|')}","changed":"...","why":"...","hypothesis":"...","ops":[{"tool":"...","args":{}}]}]}`;

  const replan = async (failed: VariantPlan, reason: string, others: VariantPlan[]): Promise<VariantPlan> => {
    const user = `${context}\n\nRe-plan ONLY variant ${failed.id}, still testing "${failed.param}". The previous attempt was rejected: ${reason}.\nPrevious attempt: ${JSON.stringify(failed)}\nOther variants (do not duplicate them): ${others.map((o) => `${o.id} ${o.param}: ${o.changed}`).join(' | ')}\n${schemaHint.replace('"variants":[', '"variants":[ /* exactly one */ ')}`;
    const res = await askValidated((fb) => deepseekJson(PLAN_SYSTEM, fb ? `${user}\n\n${fb}` : user, input.signal), plansSchema.extend({ variants: z.array(planSchema).min(1) }), 'testlab-replan');
    return { ...res.variants[0], id: failed.id, param: failed.param } as VariantPlan;
  };

  let plans: VariantPlan[];
  if (input.only) {
    plans = [input.only];
  } else {
    emit({ type: 'step', text: 'Planning 4 experiments...' });
    const user = `${context}\n\n${schemaHint}`;
    const res = await askValidated((fb) => deepseekJson(PLAN_SYSTEM, fb ? `${user}\n\n${fb}` : user, input.signal), plansSchema, 'testlab-plan');
    plans = res.variants.map((v, i) => ({ ...v, id: VARIANT_IDS[i] }) as VariantPlan);
  }
  const forced = input.only ? [] : distinctParams(plans, analysis);
  emit({ type: 'planned', plans });

  await Promise.all(
    plans.map(async (first, index) => {
      let plan = first;
      let lastError = '';
      if (forced[index]) {
        try {
          plan = await replan(plan, forced[index]!, plans.filter((p) => p.id !== plan.id));
        } catch (err: any) {
          emit({ type: 'variant_built', variant: { id: plan.id, plan, scene: null, error: err?.message ?? String(err), notes: [] } });
          return;
        }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        if (input.signal?.aborted) return;
        const dup = plans.slice(0, index).find((p) => norm(p.changed) === norm(plan.changed));
        const result = dup ? { notes: [], error: `its change duplicates ${dup.id}` } : await buildVariant(sessionId, kit, scene, plan);
        if (result.scene) {
          emit({ type: 'variant_built', variant: { id: plan.id, plan, scene: result.scene, notes: result.notes } });
          console.log(`[testlab] ${plan.id} (${plan.param}) built${attempt ? ' after re-plan' : ''}`);
          return;
        }
        lastError = result.error ?? 'unknown error';
        console.log(`[testlab] ${plan.id} (${plan.param}) rejected: ${lastError}`);
        if (attempt === 0) {
          emit({ type: 'step', text: `${plan.id.toUpperCase()} rejected (${lastError}); re-planning...` });
          try {
            plan = await replan(plan, lastError, plans.filter((p) => p.id !== plan.id));
          } catch (err: any) {
            lastError = err?.message ?? String(err);
            break;
          }
        }
      }
      emit({ type: 'variant_built', variant: { id: plan.id, plan, scene: null, error: lastError, notes: [] } satisfies BuiltVariant });
    }),
  );
}

// Steps 5-6

export interface ScoreInput {
  kit: BrandKit;
  analysis: Analysis;
  original: { scene: Scene; png: string };
  variants: { id: VariantId; scene: Scene; png: string; plan: VariantPlan }[];
}

async function shrink(png: string): Promise<string> {
  const buf = Buffer.from(png.split(',', 2)[1] ?? '', 'base64');
  const out = await sharp(buf).resize({ width: 768, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}

export async function scoreAndRank(input: ScoreInput, emit: Emit): Promise<void> {
  const { kit, analysis, original, variants } = input;
  const measurements = Object.fromEntries(
    await Promise.all(variants.map(async (v) => [v.id, measureScene(v.scene, kit, await decodeRender(v.png, v.scene))] as const)),
  );
  const ids = variants.map((v) => v.id);
  const scoreEntry = paramsSchema.extend({ hookType: z.enum(HOOK_TYPES).catch('other'), visualType: z.enum(VISUAL_TYPES).catch('none') });
  const schema = z.object({ scores: z.object(Object.fromEntries(ids.map((id) => [id, scoreEntry])) as Record<VariantId, typeof scoreEntry>) });

  const system = `You are a senior performance creative strategist. You will see ${ids.length + 1} versions of one static ad: ORIGINAL and ${ids.map((i) => i.toUpperCase()).join(', ')}. Each variant changed one thing, described in CHANGES. Score every variant on all 7 parameters.
${RUBRIC}
Rules:
- ORIGINAL's scores are already fixed (ORIGINAL SCORES). Use them as the reference point.
- Score each version on its own merits against the rubric, but use the others as reference: if V2's hook is clearly stronger than ORIGINAL's, their hook scores must differ.
- A parameter a variant did NOT change should normally keep the ORIGINAL's score. Change it only if the edit visibly affected it (say why).
- MEASUREMENTS are exact facts. Trust them.
- Also give each variant's hookType and visualType.
- Reasons: one specific sentence each. Reply with JSON only.`;
  const user = `CHANGES: ${JSON.stringify(Object.fromEntries(variants.map((v) => [v.id, { param: v.plan.param, changed: v.plan.changed }])))}
ORIGINAL SCORES: ${JSON.stringify(analysis.params)}
MEASUREMENTS: ${JSON.stringify({ original: analysis.measurements, ...measurements })}
Schema:
{"scores":{${ids.map((id) => `"${id}":{"<param>":{"score":1-5,"reason":"..."} /* all 7 */,"hookType":"...","visualType":"..."}`).join(',')}}}`;

  const images = [
    { label: 'ORIGINAL', dataUrl: await shrink(original.png) },
    ...(await Promise.all(variants.map(async (v) => ({ label: v.id.toUpperCase(), dataUrl: await shrink(v.png) })))),
  ];
  const res = await askValidated(
    (fb) => visionJson(fb ? `${user}\n\n${fb}` : user, images, { strong: true, detail: 'high', system, temperature: 0.1, seed: 7, maxTokens: 4000 }),
    schema,
    'testlab-score',
  );

  const originalScored: ScoredCreative = {
    id: 'original', params: analysis.params, total: analysis.total, delta: 0, rank: null, flags: analysis.flags,
    hookType: analysis.hookType, visualType: analysis.visualType,
  };
  const scored: ScoredCreative[] = variants.map((v) => {
    const { hookType, visualType, ...params } = res.scores[v.id];
    const capped = applyCaps(params as ParamScores, measurements[v.id], kit);
    return { id: v.id, params: capped.params, total: totalScore(capped.params), delta: 0, rank: null, flags: capped.flags, hookType, visualType };
  });
  emit({ type: 'scored', scores: [originalScored, ...scored] });
  const ranked = rankCreatives(originalScored, scored);
  emit({ type: 'ranked', original: originalScored, variants: ranked, noClearWinner: ranked.every((v) => Math.abs(v.delta) <= 3) });
}
