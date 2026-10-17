import { nanoid } from 'nanoid';
import type { Scene } from '../../shared/types.ts';
import {
  PARAM_KEYS, PARAM_LABEL, fitTextLayers,
  type Analysis, type BuiltVariant, type CreativeId, type ScoredCreative, type TestLabEvent, type VariantId, type VariantPlan,
} from '../../shared/testlab.ts';
import { streamEvents } from './lib/api.ts';
import { measureTextHeight, renderScenePng } from './canvas/render.ts';
import { ensureSceneFonts } from './lib/fonts.ts';
import { useEditor, type ChatMessage } from './store.ts';

export type TestLabStage = 'analysing' | 'planning' | 'building' | 'scoring' | 'ranked' | 'error';

export interface TestLabState {
  stage: TestLabStage;
  original: Scene;
  analysis: Analysis | null;
  plans: VariantPlan[];
  built: Partial<Record<VariantId, BuiltVariant>>;
  scores: Partial<Record<CreativeId, ScoredCreative>>;
  ranking: VariantId[];
  noClearWinner: boolean;
  pngs: Partial<Record<CreativeId, string>>;
  steps: string[];
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/** Rendered at full design width so measurements and the vision models see real pixels. */
const render = (scene: Scene) => renderScenePng(scene, Math.max(scene.width, scene.height));

const set = (fn: (t: TestLabState) => void) =>
  useEditor.setState((s) => {
    if (!s.testLab) return {};
    const next = structuredClone(s.testLab);
    fn(next);
    return { testLab: next };
  });

const get = () => useEditor.getState().testLab;

export function canRunTestLab(scene: Scene): boolean {
  return scene.layers.some((l) => l.type === 'text');
}

/** Click to ranked grid: analyse the original, plan and build 4 single-change variants, render them, score and rank. */
export async function runTestLab(opts: { fromChat?: string } = {}): Promise<void> {
  const state = useEditor.getState();
  if (state.busy || !canRunTestLab(state.scene)) return;
  const original = structuredClone(state.scene);
  const abort = new AbortController();
  const chatMsgs: ChatMessage[] = opts.fromChat ? [{ id: nanoid(6), role: 'user', text: opts.fromChat, steps: [], status: 'done' }] : [];
  const reply: ChatMessage = { id: nanoid(6), role: 'assistant', text: '', steps: ['Our Creative Strategist is analysing your design...'], status: 'streaming' };
  useEditor.setState((s) => ({
    busy: true,
    abort,
    view: 'testlab',
    selectedId: null,
    messages: [...s.messages, ...chatMsgs, reply],
    testLab: {
      stage: 'analysing', original, analysis: null, plans: [], built: {}, scores: {}, ranking: [], noClearWinner: false, pngs: {},
      steps: [], startedAt: Date.now(),
    },
  }));
  const patchReply = (fn: (m: ChatMessage) => ChatMessage) =>
    useEditor.setState((s) => ({ messages: s.messages.map((m) => (m.id === reply.id ? fn(m) : m)) }));
  const step = (text: string) => {
    set((t) => void t.steps.push(text));
    patchReply((m) => ({ ...m, steps: [...m.steps, text] }));
  };

  try {
    const png = await render(original);
    set((t) => void (t.pngs.original = png));
    await streamEvents<TestLabEvent>('/api/test-lab/analyse', JSON.stringify({ scene: original, png }), (e) => {
      if (e.type === 'analysed') set((t) => void (t.analysis = e.analysis));
      else if (e.type === 'error') throw new Error(e.text);
    }, { json: true, signal: abort.signal });
    const analysis = get()?.analysis;
    if (!analysis) throw new Error('Analysis failed');
    step(`Analysed: ${analysis.total}/100`);

    set((t) => void (t.stage = 'planning'));
    await streamPlan(original, analysis, undefined, abort.signal, step);
    await scoreAll(abort.signal, step);

    const t = get()!;
    set((x) => void (x.finishedAt = Date.now()));
    patchReply((m) => ({ ...m, status: 'done', text: summary(t) }));
  } catch (err: any) {
    const aborted = err?.name === 'AbortError';
    set((t) => {
      t.stage = 'error';
      t.error = aborted ? 'Stopped.' : err?.message ?? String(err);
    });
    patchReply((m) => ({ ...m, status: aborted ? 'done' : 'error', text: aborted ? 'Creative Strategist stopped.' : `Creative Strategist failed: ${err?.message ?? err}` }));
  } finally {
    useEditor.setState({ busy: false, abort: null });
  }
}

async function streamPlan(original: Scene, analysis: Analysis, only: VariantPlan | undefined, signal: AbortSignal, step: (s: string) => void) {
  await streamEvents<TestLabEvent>('/api/test-lab/plan', JSON.stringify({ scene: original, analysis, only }), (e) => {
    if (e.type === 'planned') {
      set((t) => {
        if (only) t.plans = t.plans.map((p) => (p.id === only.id ? e.plans[0] : p));
        else t.plans = e.plans;
        t.stage = 'building';
      });
      if (!only) step(`Building ${e.plans.length} experiments from these opportunities...`);
    } else if (e.type === 'variant_built') {
      set((t) => {
        t.built[e.variant.id] = e.variant;
        t.plans = t.plans.map((p) => (p.id === e.variant.id ? e.variant.plan : p));
      });
      if (e.variant.scene) fits.set(e.variant.id, fitVariant(original, e.variant));
    } else if (e.type === 'step') step(e.text);
    else if (e.type === 'error') throw new Error(e.text);
  }, { json: true, signal });
}

const fits = new Map<VariantId, Promise<void>>();

/** Server fitting is an estimate; re-fit text with real font metrics so rewritten copy never runs into the layer below. */
async function fitVariant(original: Scene, variant: BuiltVariant): Promise<void> {
  const built = JSON.stringify(variant.scene);
  const scene = structuredClone(variant.scene!);
  await ensureSceneFonts(scene);
  await ensureSceneFonts(original);
  const fitted = fitTextLayers(original, scene, measureTextHeight);
  for (const l of scene.layers) if (l.type === 'text') l.height = measureTextHeight(l);
  set((t) => {
    const b = t.built[variant.id];
    if (!b?.scene || JSON.stringify(b.scene) !== built) return;
    b.scene = scene;
    if (fitted.length && !b.notes.includes('Text size auto-fitted')) b.notes.push('Text size auto-fitted');
  });
}

/** Renders every built variant offscreen and scores them together with the original. */
async function scoreAll(signal: AbortSignal, step: (s: string) => void) {
  await Promise.all(fits.values());
  fits.clear();
  const t = get()!;
  const ready = t.plans.map((p) => t.built[p.id]).filter((b): b is BuiltVariant => !!b?.scene);
  if (!ready.length) throw new Error('No variant passed the one-change check');
  set((x) => void (x.stage = 'scoring'));
  step(`Scoring ${ready.length} variants against the original...`);
  const rendered = await Promise.all(ready.map(async (b) => ({ id: b.id, scene: b.scene!, plan: b.plan, png: await render(b.scene!) })));
  set((x) => {
    for (const r of rendered) x.pngs[r.id] = r.png;
  });
  await streamEvents<TestLabEvent>(
    '/api/test-lab/score',
    JSON.stringify({ analysis: t.analysis, original: { scene: t.original, png: t.pngs.original }, variants: rendered }),
    (e) => {
      if (e.type === 'ranked') {
        set((x) => {
          x.scores = { original: e.original, ...Object.fromEntries(e.variants.map((v) => [v.id, v])) };
          x.ranking = e.variants.map((v) => v.id as VariantId);
          x.noClearWinner = e.noClearWinner;
          x.stage = 'ranked';
        });
      } else if (e.type === 'error') throw new Error(e.text);
    },
    { json: true, signal },
  );
  step('Ranked');
}

export async function retryVariant(id: VariantId): Promise<void> {
  const t = get();
  const state = useEditor.getState();
  if (!t?.analysis || state.busy) return;
  const plan = t.plans.find((p) => p.id === id);
  if (!plan) return;
  const abort = new AbortController();
  useEditor.setState({ busy: true, abort });
  set((x) => {
    delete x.built[id];
    x.stage = 'building';
  });
  const step = (text: string) => set((x) => void x.steps.push(text));
  try {
    await streamPlan(t.original, t.analysis, plan, abort.signal, step);
    await scoreAll(abort.signal, step);
    const done = get()!;
    useEditor.setState((s) => ({
      messages: [...s.messages, { id: nanoid(6), role: 'assistant', text: `Re-ran ${id.toUpperCase()}. ${summary(done)}`, steps: [], status: 'done' }],
    }));
  } catch (err: any) {
    set((x) => {
      x.stage = 'error';
      x.error = err?.message ?? String(err);
    });
  } finally {
    useEditor.setState({ busy: false, abort: null });
  }
}

/** Code-built chat summary, e.g. "Tested 4 ideas. Predicted best: V2 (+14), a pain-led headline." */
function summary(t: TestLabState): string {
  const best = t.ranking[0] ? t.scores[t.ranking[0]] : undefined;
  const plan = t.plans.find((p) => p.id === best?.id);
  const tested = t.ranking.length;
  if (!best || !plan) return 'The Creative Strategist finished, but no experiment could be scored.';
  const weakest = [...PARAM_KEYS].sort((a, b) => best.params[a].score - best.params[b].score)[0];
  const lead = t.noClearWinner
    ? `Tested ${tested} ideas. No clear winner; these differences are within scoring noise.`
    : `Tested ${tested} ideas. Predicted best: ${best.id.toUpperCase()} (${best.delta >= 0 ? '+' : ''}${best.delta}), ${plan.changed.charAt(0).toLowerCase()}${plan.changed.slice(1)}.`;
  const dropped = t.plans.length - tested;
  return `${lead} Biggest open issue: ${PARAM_LABEL[weakest]} (${best.params[weakest].score}/5).${dropped ? ` ${dropped} variant${dropped > 1 ? 's' : ''} failed the one-change check.` : ''}`;
}

const ROUTE = /\b(do better|perform better|improve (this|the|my) (ad|design|post|creative)|a\/b test|creative test|creative strategist|strategist|analy[sz]e (this|the|my) (ad|design|post|creative))\b/i;

/** "How can this ad do better?" / "analyse my design" go to the Creative Strategist; variation requests never do. */
export function shouldRouteToTestLab(text: string, scene: Scene): boolean {
  return canRunTestLab(scene) && ROUTE.test(text);
}
