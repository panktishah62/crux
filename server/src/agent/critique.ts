import type { AgentEvent, BrandKit, Scene } from '../../../shared/types.ts';
import { lintScene } from '../../../shared/lint.ts';
import { visionJson } from '../llm.ts';
import { describeScene } from '../scene/ops.ts';
import { runAgent } from './loop.ts';

interface Review {
  score: number;
  verdict: string;
  fixes: string[];
}

export interface CritiqueInput {
  sessionId: string;
  kit: BrandKit;
  scene: Scene;
  request: string;
  /** PNG data URL of the rendered canvas. */
  png: string;
  variant?: number;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

const PASS_SCORE = 8;

/** Vision reviews the rendered design against the ask and the brand; the planner then applies one round of fixes. */
export async function runCritique(input: CritiqueInput): Promise<Scene> {
  const { emit, variant, kit, scene } = input;
  emit({ type: 'step', text: 'Self-review: looking at the rendered design...', variant });

  const p = kit.profile;
  const brand = p
    ? `Brand "${p.name}". Palette: ${p.palette.map((c) => `${c.name} ${c.hex}`).join(', ')}. Fonts: ${p.fonts.headline.family} (headlines), ${p.fonts.body.family} (body). Rules: ${p.rules.join(' | ')}. Tone: ${p.tone ?? 'n/a'}.`
    : 'No brand kit; judge general design quality.';
  const lint = lintScene(scene, kit);
  const warnings = lint.map((i) => `${i.severity} [${i.rule}]: ${i.message}${i.layerId ? ` (layer ${i.layerId})` : ''}`);
  const mustFix = lint.filter((i) => i.severity === 'error').map((i) => `${i.message}${i.layerId ? ` (layer ${i.layerId})` : ''}`);

  const t0 = Date.now();
  const review = await visionJson<Review>(
    `You are an art director reviewing a social design produced by a junior designer.
The designer asked for: "${input.request}"
${brand}
Layers (bottom to top, ids for reference): ${describeScene(scene)}
Automated layout and brand linter notes (facts; fix every layout and error item): ${warnings.join(' | ') || 'none'}

Look at the rendered image. Judge: does it answer the ask, is it on-brand, is the hierarchy clear (one dominant headline, readable copy, obvious CTA), is anything cropped, overlapping, illegible, misaligned, cramped or empty-looking, and does the photo suit the message?
Score 1-10 (8+ means ship it). List at most 3 concrete fixes, each naming the layer (id or name) and the exact change (e.g. "Move headline txt_ab12 up 40px so it clears the photo"). Only list fixes that clearly improve the design; do not ask to regenerate images unless the photo is clearly wrong for the ask.
Respond as JSON: {"score":7,"verdict":"one sentence","fixes":["..."]}`,
    [{ dataUrl: input.png }],
    { strong: true, detail: 'high', maxTokens: 800 },
  );
  const score = Math.max(1, Math.min(10, Math.round(Number(review.score) || 0)));
  const fixes = [...mustFix, ...(review.fixes ?? []).filter((f) => typeof f === 'string' && f.trim()).slice(0, 3)];
  console.log(`[critique${variant !== undefined ? ` v${variant + 1}` : ''}] score ${score} in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${mustFix.length} linter errors: ${fixes.join(' / ') || 'no fixes'}`);
  emit({ type: 'review', score, verdict: String(review.verdict ?? ''), variant });

  if (score >= PASS_SCORE && !fixes.length) {
    emit({ type: 'step', text: `Self-review: ${score}/10, no changes needed`, variant });
    emit({ type: 'message', text: `Self-review ${score}/10: ${review.verdict}`, variant });
    return scene;
  }
  if (!fixes.length) {
    emit({ type: 'message', text: `Self-review ${score}/10: ${review.verdict}`, variant });
    return scene;
  }

  emit({ type: 'step', text: `Self-review: ${score}/10, applying ${fixes.length} fix${fixes.length > 1 ? 'es' : ''}...`, variant });
  return runAgent({
    sessionId: input.sessionId,
    kit,
    scene,
    request: `An art director reviewed the rendered design (score ${score}/10: ${review.verdict}). Apply these fixes in one round using update_layer / generate_image(layerId) / delete_layer, without rebuilding:\n${fixes.map((f) => `- ${f}`).join('\n')}\nThen reply in one sentence starting "Self-review ${score}/10:" describing what you improved.`,
    variant,
    emit,
    signal: input.signal,
  });
}
