import { nanoid } from 'nanoid';
import type { AgentEvent, BrandKit, Scene } from '../../../shared/types.ts';
import { flashJson } from '../llm.ts';
import { parseReference, type LayoutSpec } from '../reference.ts';
import { runAgent } from './loop.ts';

interface VariantBrief {
  headline: string;
  subheadline?: string;
  cta: string;
  background: string;
  imageIdea?: string;
  twist: string;
}

export interface VariantsInput {
  sessionId: string;
  kit: BrandKit;
  request: string;
  count: number;
  base: Pick<Scene, 'width' | 'height' | 'format'>;
  reference?: Buffer;
  /** Earlier asks in the chat and the copy on the source design, so "variants of the same" keeps the campaign. */
  context?: { history?: string[]; sourceCopy?: string[] };
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

function specToText(spec: LayoutSpec, w: number, h: number): string {
  const px = (b: [number, number, number, number]) =>
    `x=${Math.round(b[0] * w)} y=${Math.round(b[1] * h)} w=${Math.round(b[2] * w)} h=${Math.round(b[3] * h)}`;
  return [
    `Summary: ${spec.summary}. Mood: ${spec.mood}. Typography: ${spec.typography}.`,
    `Background: ${spec.background.kind}${spec.background.color ? ` ${spec.background.color}` : ''}${spec.background.description ? ` — ${spec.background.description}` : ''}`,
    'Elements back to front (scaled to this canvas):',
    ...spec.elements.map((e) => `- ${e.role} (${e.kind}) ${px(e.bbox)}${e.text ? ` text="${e.text}"` : ''}${e.color ? ` colour ${e.color}` : ''}${e.notes ? ` — ${e.notes}` : ''}`),
  ].join('\n');
}

export async function runVariants(input: VariantsInput): Promise<void> {
  const { emit, kit, base } = input;
  const count = Math.max(1, Math.min(input.count, 6));
  const scenes: Scene[] = Array.from({ length: count }, () => ({
    id: nanoid(8), format: base.format, width: base.width, height: base.height, background: '#FFFFFF', layers: [],
  }));
  emit({ type: 'variants_start', count, scenes });

  const t0 = Date.now();
  const lap = (label: string) => console.log(`[variants] ${label} at ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  let spec: LayoutSpec | undefined;
  if (input.reference) {
    emit({ type: 'step', text: 'Analysing the reference layout...' });
    spec = await parseReference(input.sessionId, input.reference);
    lap('reference parsed');
    emit({ type: 'step', text: `Reference: ${spec.summary}` });
  }

  emit({ type: 'step', text: `Writing ${count} variant briefs...` });
  const palette = kit.profile?.palette.map((c) => `${c.name} ${c.hex}`).join(', ') ?? 'neutral palette';
  let briefs: VariantBrief[] = [];
  let campaign = '';
  const history = input.context?.history?.length ? input.context.history.map((h) => `- "${h}"`).join('\n') : '';
  const sourceCopy = input.context?.sourceCopy?.length ? input.context.sourceCopy.map((c) => `- ${c}`).join('\n') : '';
  try {
    const res = await flashJson<{ campaign?: string; variants: VariantBrief[] }>(
      'You write concise creative briefs for on-brand ad variants. Respond with JSON only.',
      `Designer request: "${input.request}"
${history ? `Earlier requests in this chat (oldest first):\n${history}\n` : ''}${sourceCopy ? `Copy on the source design:\n${sourceCopy}\n` : ''}Brand: ${kit.profile?.name ?? 'unknown'}; tone: ${kit.profile?.tone ?? 'clear, confident'}; palette: ${palette}.
${spec ? `Reference copy: ${JSON.stringify(spec.copy)}. Reference summary: ${spec.summary}` : ''}
First pin down the CAMPAIGN every variant must keep: the occasion or theme (e.g. a festival, launch, hiring), the product or service, the offer and its exact numbers, and the audience. Take it from the designer request; if the request refers to "this"/"the same"/"it", take it from the source design copy and earlier requests. Only change the campaign if the designer explicitly asks for a different one.
Then write ${count} clearly different variants of THAT campaign that keep the reference's structure but vary the angle within the campaign, the copy wording, the background colourway and the hero visual. Every headline or subheadline must still make the occasion and offer obvious.
Headlines 2-6 words (two short sentences work well). Background must be one of the palette colours.
JSON: {"campaign":"one line: occasion/theme, product, offer, audience","variants":[{"headline":"...","subheadline":"...","cta":"...","background":"#hex","imageIdea":"hero visual idea that fits the occasion (photo subject, illustration or product shot)","twist":"what makes this one different"}]}`,
    );
    briefs = res.variants ?? [];
    campaign = String(res.campaign ?? '').trim();
    if (campaign) emit({ type: 'step', text: `Campaign: ${campaign}` });
    lap('briefs written');
  } catch (err) {
    console.warn('[variants] brief generation failed, continuing without briefs', err);
  }

  const layout = spec ? specToText(spec, base.width, base.height) : '';
  await Promise.all(
    scenes.map(async (scene, i) => {
      const brief = briefs[i];
      const request = [
        `Designer request: "${input.request}"`,
        campaign ? `Campaign every element must serve (copy, visuals, decorations): ${campaign}` : '',
        spec
          ? `Recreate the STRUCTURE of this reference as an original, on-brand design (same layout logic and hierarchy, new copy and visuals). The text values below are the reference's copy, shown only to convey length and hierarchy; use the variant brief's copy instead:\n${layout}`
          : '',
        brief
          ? `Variant ${i + 1} brief: headline "${brief.headline}"${brief.subheadline ? `, subheadline "${brief.subheadline}"` : ''}, CTA "${brief.cta}", background ${brief.background}, hero visual: ${brief.imageIdea ?? 'brand asset'}. Twist: ${brief.twist}.`
          : `This is variant ${i + 1} of ${count}; make it distinct from the others.`,
        'Use brand assets for logo, shapes, icons and product shots; generate at most one image (people/scene) if the layout needs a photo the kit lacks.',
      ]
        .filter(Boolean)
        .join('\n\n');
      try {
        // The reference defines the layout here; offering templates too makes the planner build twice.
        await runAgent({ sessionId: input.sessionId, kit: { ...kit, templates: [] }, scene, request, variant: i, emit, signal: input.signal });
      } catch (err: any) {
        emit({ type: 'error', text: err?.message ?? String(err), variant: i });
      }
      lap(`variant ${i + 1} done`);
      emit({ type: 'done', variant: i });
    }),
  );
}
