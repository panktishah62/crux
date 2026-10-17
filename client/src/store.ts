import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { FORMAT_PRESETS, type AgentEvent, type BrandKit, type Layer, type LintIssue, type Scene } from '../../shared/types.ts';
import { applyLintFixes, lintScene } from '../../shared/lint.ts';
import { api, streamEvents } from './lib/api.ts';
import { ensureSceneFonts, registerBrandFonts } from './lib/fonts.ts';
import { measureTextHeight, renderScenePng } from './canvas/render.ts';
import { fitTextLayers } from '../../shared/testlab.ts';
import { canRunTestLab, runTestLab, shouldRouteToTestLab, type TestLabState } from './testlab.ts';

type View = 'editor' | 'variants' | 'testlab';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  steps: string[];
  status: 'streaming' | 'done' | 'error';
  attachment?: { url: string; name: string };
  layerName?: string;
  review?: { score: number; verdict: string };
  /** Yes/No offer to run the Creative Strategist on the design this turn produced. */
  offer?: { status: 'pending' | 'accepted' | 'declined'; fromVariants?: boolean };
}

const VARIATIONS = /\b(variations?|variants?|versions?|alternatives?|options|different (images|designs|posts|ads))\b|\b(images?|designs?|posts?|ads?) like this\b/i;
const IMAGE_STEP = /^(Generating|Regenerating) image|^Applying layout/;

export interface VariantState {
  scenes: Scene[];
  status: ('running' | 'reviewing' | 'done' | 'error')[];
  steps: string[][];
  scores: (number | null)[];
}

const SELF_REVIEW_KEY = 'crux-self-review';

const HISTORY_LIMIT = 100;

export const blankScene = (formatId = 'post'): Scene => {
  const f = FORMAT_PRESETS.find((p) => p.id === formatId) ?? FORMAT_PRESETS[0];
  return { id: nanoid(8), format: f.id, width: f.width, height: f.height, background: '#FFFFFF', layers: [] };
};

interface EditorState {
  scene: Scene;
  past: Scene[];
  future: Scene[];
  selectedId: string | null;
  measuredHeights: Record<string, number>;

  kit: BrandKit;
  messages: ChatMessage[];
  busy: boolean;
  abort: AbortController | null;

  variants: VariantState | null;
  view: View;
  testLab: TestLabState | null;
  /** Loads a Creative Strategist creative onto the canvas as a new version. */
  openCreative: (scene: Scene) => void;

  /** Replaces the scene, recording the previous one for undo. */
  commit: (scene: Scene) => void;
  updateLayer: (id: string, patch: Partial<Layer>) => void;
  addLayer: (layer: Layer, index?: number) => void;
  deleteLayer: (id: string) => void;
  moveLayer: (id: string, z: 'front' | 'back' | 'forward' | 'backward') => void;
  duplicateLayer: (id: string) => void;
  setBackground: (color: string) => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  reportHeights: (heights: Record<string, number>) => void;
  newDesign: (formatId: string) => void;

  setKit: (kit: BrandKit) => void;
  refreshKit: () => Promise<void>;

  selfReview: boolean;
  setSelfReview: (on: boolean) => void;
  /** Applies deterministic brand-lint fixes as one undoable step. */
  fixLint: (issues: LintIssue[]) => void;

  sendMessage: (text: string, reference?: File) => Promise<void>;
  answerOffer: (messageId: string, yes: boolean) => void;
  /** Runs the vision self-review + one fix round on the current design. */
  reviewNow: () => Promise<void>;
  stop: () => void;
  openVariant: (index: number) => void;
  setView: (view: View) => void;
}

const clone = <T,>(v: T): T => structuredClone(v);
const SCENE_KEY = 'crux-scene';

function loadScene(): Scene {
  try {
    const raw = localStorage.getItem(SCENE_KEY);
    if (raw) {
      const scene = JSON.parse(raw) as Scene;
      scene.layers = scene.layers.filter((l) => !(l.type === 'image' && l.pending));
      return scene;
    }
  } catch {
    /* fall through to a blank scene */
  }
  return blankScene();
}

export const useEditor = create<EditorState>((set, get) => {
  const withHistory = (next: Scene) =>
    set((s) => ({ scene: next, past: [...s.past, s.scene].slice(-HISTORY_LIMIT), future: [] }));

  const mutate = (fn: (scene: Scene) => void) => {
    const next = clone(get().scene);
    fn(next);
    withHistory(next);
  };

  return {
    scene: loadScene(),
    past: [],
    future: [],
    selectedId: null,
    measuredHeights: {},
    kit: { profile: null, assets: [], status: 'empty' },
    messages: [],
    busy: false,
    abort: null,
    variants: null,
    view: 'editor',
    testLab: null,
    selfReview: localStorage.getItem(SELF_REVIEW_KEY) !== 'off',

    commit: withHistory,

    setSelfReview: (on) => {
      localStorage.setItem(SELF_REVIEW_KEY, on ? 'on' : 'off');
      set({ selfReview: on });
    },

    fixLint: (issues) => mutate((scene) => void applyLintFixes(scene, issues)),

    updateLayer: (id, patch) =>
      mutate((scene) => {
        const layer = scene.layers.find((l) => l.id === id);
        if (layer) Object.assign(layer, patch);
      }),

    addLayer: (layer, index) =>
      mutate((scene) => {
        if (index === undefined) scene.layers.push(layer);
        else scene.layers.splice(index, 0, layer);
      }),

    deleteLayer: (id) => {
      mutate((scene) => {
        scene.layers = scene.layers.filter((l) => l.id !== id);
      });
      if (get().selectedId === id) set({ selectedId: null });
    },

    moveLayer: (id, z) =>
      mutate((scene) => {
        const i = scene.layers.findIndex((l) => l.id === id);
        if (i < 0) return;
        const [layer] = scene.layers.splice(i, 1);
        const n = scene.layers.length;
        const target = z === 'front' ? n : z === 'back' ? 0 : z === 'forward' ? Math.min(i + 1, n) : Math.max(i - 1, 0);
        scene.layers.splice(target, 0, layer);
      }),

    duplicateLayer: (id) => {
      const layer = get().scene.layers.find((l) => l.id === id);
      if (!layer) return;
      const copy = { ...clone(layer), id: `${layer.type}_${nanoid(5)}`, name: `${layer.name} copy`, x: layer.x + 24, y: layer.y + 24 };
      const index = get().scene.layers.indexOf(layer) + 1;
      get().addLayer(copy, index);
      set({ selectedId: copy.id });
    },

    setBackground: (color) => mutate((scene) => void (scene.background = color)),

    undo: () => {
      const { past, scene, future } = get();
      if (!past.length) return;
      set({ scene: past[past.length - 1], past: past.slice(0, -1), future: [scene, ...future] });
    },

    redo: () => {
      const { past, scene, future } = get();
      if (!future.length) return;
      set({ scene: future[0], future: future.slice(1), past: [...past, scene] });
    },

    select: (id) => set({ selectedId: id }),

    reportHeights: (heights) => set((s) => ({ measuredHeights: { ...s.measuredHeights, ...heights } })),

    newDesign: (formatId) => {
      withHistory(blankScene(formatId));
      set({ selectedId: null, view: 'editor' });
    },

    setKit: (kit) => {
      registerBrandFonts(kit.profile);
      set({ kit });
    },

    refreshKit: async () => get().setKit(await api.getKit()),

    stop: () => {
      get().abort?.abort();
      set({ busy: false, abort: null });
    },

    sendMessage: async (text, reference) => {
      if (get().busy) return;
      const wantsVariations = !!reference || VARIATIONS.test(text);
      if (!wantsVariations && shouldRouteToTestLab(text, get().scene)) return runTestLab({ fromChat: text });
      const { scene, selectedId, messages } = get();
      const selected = scene.layers.find((l) => l.id === selectedId);
      const userMsg: ChatMessage = {
        id: nanoid(6), role: 'user', text, steps: [], status: 'done',
        attachment: reference ? { url: URL.createObjectURL(reference), name: reference.name } : undefined,
        layerName: selected?.name,
      };
      const reply: ChatMessage = { id: nanoid(6), role: 'assistant', text: '', steps: [], status: 'streaming' };
      const abort = new AbortController();
      set({ messages: [...messages, userMsg, reply], busy: true, abort });

      const patchReply = (fn: (m: ChatMessage) => ChatMessage) =>
        set((s) => ({ messages: s.messages.map((m) => (m.id === reply.id ? fn(m) : m)) }));
      const addStep = (step: string) => patchReply((m) => ({ ...m, steps: [...m.steps, step] }));

      let generatedImages = false;
      try {
        if (wantsVariations) {
          const ref = reference ?? (await defaultReference(addStep));
          await streamVariants(text, ref, abort.signal, addStep, patchReply);
          await fitVariantsText(addStep);
          if (get().selfReview && !abort.signal.aborted) {
            await reviewVariants(text, abort.signal, addStep);
            await fitVariantsText(addStep);
          }
          generatedImages = !!get().variants?.status.some((s) => s === 'done');
        } else {
          const wasEmpty = scene.layers.length === 0;
          // Send exact rendered text heights so the planner can stack layers precisely.
          const sceneForAgent = await withExactText(scene);
          const history = messages
            .filter((m) => m.text && m.status === 'done' && !m.offer)
            .map((m) => ({ role: m.role, content: m.text }));
          await streamEvents(
            '/api/agent',
            JSON.stringify({ scene: sceneForAgent, message: text, history, selectedLayerId: selectedId ?? undefined }),
            (e) => {
              if (e.type === 'step') addStep(e.text);
              else if (e.type === 'scene') {
                withHistory(e.scene);
                const sel = get().selectedId;
                if (sel && !e.scene.layers.some((l) => l.id === sel)) set({ selectedId: null });
              } else if (e.type === 'message') patchReply((m) => ({ ...m, text: e.text }));
              else if (e.type === 'error') patchReply((m) => ({ ...m, status: 'error', text: e.text }));
            },
            { json: true, signal: abort.signal },
          );
          const ok = get().messages.find((m) => m.id === reply.id)?.status !== 'error';
          const rendered = await syncExactText();
          const errors = rendered.layers.length ? lintScene(rendered, get().kit).filter((i) => i.severity === 'error') : [];
          if (ok && !abort.signal.aborted && rendered.layers.length && ((wasEmpty && get().selfReview) || errors.length)) {
            if (errors.length) addStep(`Rendered check found ${errors.length} issue${errors.length > 1 ? 's' : ''}; fixing...`);
            await critiqueEditor(text, abort.signal, addStep, patchReply);
            await syncExactText();
          }
          const steps = get().messages.find((m) => m.id === reply.id)?.steps ?? [];
          generatedImages = ok && canRunTestLab(get().scene) && (wasEmpty || steps.some((s) => IMAGE_STEP.test(s)));
        }
        patchReply((m) => ({ ...m, status: m.status === 'error' ? 'error' : 'done', text: m.text || 'Done.' }));
        if (generatedImages && !abort.signal.aborted) {
          set((s) => ({
            messages: [...s.messages, {
              id: nanoid(6), role: 'assistant', steps: [], status: 'done',
              text: 'Do you want our Creative Strategist to analyse your design?',
              offer: { status: 'pending', fromVariants: wantsVariations },
            }],
          }));
        }
      } catch (err: any) {
        const aborted = err?.name === 'AbortError';
        patchReply((m) => ({ ...m, status: aborted ? 'done' : 'error', text: aborted ? m.text || 'Stopped.' : err?.message ?? String(err) }));
      } finally {
        set({ busy: false, abort: null });
      }
    },

    reviewNow: async () => {
      if (get().busy || !get().scene.layers.length) return;
      const lastAsk = [...get().messages].reverse().find((m) => m.role === 'user')?.text ?? 'An on-brand social post';
      const reply: ChatMessage = { id: nanoid(6), role: 'assistant', text: '', steps: [], status: 'streaming' };
      const abort = new AbortController();
      set((s) => ({ messages: [...s.messages, reply], busy: true, abort }));
      const patchReply = (fn: (m: ChatMessage) => ChatMessage) =>
        set((s) => ({ messages: s.messages.map((m) => (m.id === reply.id ? fn(m) : m)) }));
      try {
        await critiqueEditor(lastAsk, abort.signal, (step) => patchReply((m) => ({ ...m, steps: [...m.steps, step] })), patchReply);
        patchReply((m) => ({ ...m, status: m.status === 'error' ? 'error' : 'done', text: m.text || 'Review finished.' }));
      } catch (err: any) {
        const aborted = err?.name === 'AbortError';
        patchReply((m) => ({ ...m, status: aborted ? 'done' : 'error', text: aborted ? m.text || 'Stopped.' : err?.message ?? String(err) }));
      } finally {
        set({ busy: false, abort: null });
      }
    },

    openVariant: (index) => {
      const v = get().variants?.scenes[index];
      if (!v) return;
      withHistory(clone({ ...v, id: nanoid(8) }));
      set({ view: 'editor', selectedId: null });
    },

    setView: (view) => set({ view }),

    answerOffer: (messageId, yes) => {
      const msg = get().messages.find((m) => m.id === messageId);
      if (!msg?.offer || msg.offer.status !== 'pending' || (yes && get().busy)) return;
      set((s) => ({
        messages: s.messages.map((m) => (m.id === messageId ? { ...m, offer: { ...m.offer!, status: yes ? 'accepted' : 'declined' } } : m)),
      }));
      if (!yes) return;
      if (msg.offer.fromVariants) {
        const v = get().variants;
        if (v) {
          const done = v.scenes.map((_, i) => i).filter((i) => v.status[i] === 'done');
          const best = done.sort((a, b) => (v.scores[b] ?? 0) - (v.scores[a] ?? 0))[0];
          if (best !== undefined) get().openVariant(best);
        }
      }
      void runTestLab();
    },

    openCreative: (scene) => {
      withHistory(clone({ ...scene, id: nanoid(8) }));
      set({ view: 'editor', selectedId: null });
    },
  };

  /** Copy of the scene with every text height measured from the real font, so linting matches what is drawn. */
  async function withExactText(scene: Scene): Promise<Scene> {
    const next = clone(scene);
    await ensureSceneFonts(next);
    for (const l of next.layers) if (l.type === 'text') l.height = measureTextHeight(l);
    return next;
  }

  /** Writes exact text heights into the editor scene in place (no undo step); returns it. */
  async function syncExactText(): Promise<Scene> {
    const current = get().scene;
    const exact = await withExactText(current);
    const changed = exact.layers.some((l, i) => l.height !== current.layers[i].height);
    if (changed && get().scene === current) set({ scene: exact });
    return changed ? exact : current;
  }

  /** Self-review of the editor scene; fixes stream in as normal undoable scene updates. */
  async function critiqueEditor(
    request: string,
    signal: AbortSignal,
    addStep: (s: string) => void,
    patchReply: (fn: (m: ChatMessage) => ChatMessage) => void,
  ) {
    addStep('Rendering design for self-review...');
    const scene = await withExactText(get().scene);
    const png = await renderScenePng(scene);
    await streamEvents(
      '/api/critique',
      JSON.stringify({ scene, request, png }),
      (e) => {
        if (e.type === 'step') addStep(e.text);
        else if (e.type === 'review') patchReply((m) => ({ ...m, review: { score: e.score, verdict: e.verdict } }));
        else if (e.type === 'scene') withHistory(e.scene);
        else if (e.type === 'message') patchReply((m) => ({ ...m, text: m.text ? `${m.text}\n\n${e.text}` : e.text }));
        else if (e.type === 'error') addStep(e.text);
      },
      { json: true, signal },
    );
  }

  /** Reviews every finished variant in parallel; each gets one fix round. */
  async function reviewVariants(request: string, signal: AbortSignal, addStep: (s: string) => void) {
    const v = get().variants;
    if (!v) return;
    const targets = v.status.map((s, i) => (s === 'done' ? i : -1)).filter((i) => i >= 0);
    if (!targets.length) return;
    addStep(`Self-reviewing ${targets.length} variants...`);
    const update = (i: number, fn: (v: VariantState) => void) =>
      set((s) => {
        if (!s.variants) return {};
        const next = clone(s.variants);
        fn(next);
        return { variants: next };
      });
    await Promise.all(
      targets.map(async (i) => {
        update(i, (v) => (v.status[i] = 'reviewing'));
        try {
          const scene = get().variants!.scenes[i];
          const png = await renderScenePng(scene);
          await streamEvents(
            '/api/critique',
            JSON.stringify({ scene, request, png, variant: i }),
            (e) => {
              if (e.type === 'step') update(i, (v) => v.steps[i].push(e.text));
              else if (e.type === 'scene') update(i, (v) => (v.scenes[i] = e.scene));
              else if (e.type === 'review') update(i, (v) => (v.scores[i] = e.score));
            },
            { json: true, signal },
          );
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') throw err;
          console.warn('variant review failed', err);
        } finally {
          update(i, (v) => (v.status[i] = 'done'));
        }
      }),
    );
    const scores = get().variants?.scores.filter((s): s is number => s !== null) ?? [];
    if (scores.length) addStep(`Self-review scores: ${scores.map((s) => `${s}/10`).join(', ')}`);
  }

  /** Server text heights are estimates; re-fit every finished variant with real font metrics so no text runs into the layer below. */
  async function fitVariantsText(addStep: (s: string) => void) {
    const v = get().variants;
    if (!v) return;
    let fittedCount = 0;
    const scenes = await Promise.all(
      v.scenes.map(async (scene, i) => {
        if (v.status[i] !== 'done' || !scene.layers.length) return scene;
        const next = clone(scene);
        await ensureSceneFonts(next);
        const fitted = fitTextLayers({ ...next, layers: [] }, next, measureTextHeight);
        for (const l of next.layers) if (l.type === 'text') l.height = measureTextHeight(l);
        if (fitted.length) fittedCount++;
        return next;
      }),
    );
    set((s) => (s.variants ? { variants: { ...s.variants, scenes: s.variants.scenes.map((sc, i) => (s.variants!.status[i] === 'done' ? scenes[i] : sc)) } } : {}));
    if (fittedCount) addStep(`Fitted overflowing text in ${fittedCount} variant${fittedCount > 1 ? 's' : ''}`);
  }

  /** Variations without an attached image follow the design on the canvas, else the brand kit's first reference image. */
  async function defaultReference(addStep: (s: string) => void): Promise<File | undefined> {
    const { scene, kit } = get();
    if (scene.layers.length) {
      addStep('Using the current design as the reference...');
      const blob = await (await fetch(await renderScenePng(scene))).blob();
      return new File([blob], 'current-design.png', { type: 'image/png' });
    }
    const ref = kit.assets.find((a) => a.category === 'reference');
    if (!ref) return undefined;
    addStep(`Using the brand kit reference "${ref.description ?? ref.filename}"...`);
    const blob = await (await fetch(ref.url)).blob();
    return new File([blob], ref.filename ?? 'reference.png', { type: blob.type || 'image/png' });
  }

  async function streamVariants(
    text: string,
    reference: File | undefined,
    signal: AbortSignal,
    addStep: (s: string) => void,
    patchReply: (fn: (m: ChatMessage) => ChatMessage) => void,
  ) {
    const { scene, messages } = get();
    const form = new FormData();
    if (reference) form.append('reference', reference);
    form.append('message', text);
    // "Variants of the same" only makes sense with the campaign it refers to: earlier asks and the design's own copy.
    const history = messages.filter((m) => m.role === 'user' && m.text && m.text !== text).slice(-4).map((m) => m.text);
    const sourceCopy = scene.layers
      .map((l) => (l.type === 'text' ? l.text : l.type === 'shape' && l.label ? `[button] ${l.label}` : ''))
      .filter(Boolean);
    form.append('context', JSON.stringify({ history, sourceCopy }));
    form.append('width', String(scene.width));
    form.append('height', String(scene.height));
    form.append('format', scene.format);

    const setVariant = (i: number, fn: (v: VariantState) => void) =>
      set((s) => {
        if (!s.variants) return {};
        const v = clone(s.variants);
        if (i < v.scenes.length) fn(v);
        return { variants: v };
      });

    await streamEvents(
      '/api/variants',
      form,
      (e: AgentEvent) => {
        if (e.type === 'variants_start') {
          set({
            variants: { scenes: e.scenes, status: e.scenes.map(() => 'running'), steps: e.scenes.map(() => []), scores: e.scenes.map(() => null) },
            view: 'variants',
          });
          addStep(`Generating ${e.count} variants in parallel...`);
        } else if (e.type === 'step') {
          if (e.variant === undefined) addStep(e.text);
          else setVariant(e.variant, (v) => v.steps[e.variant!].push(e.text));
        } else if (e.type === 'scene' && e.variant !== undefined) {
          setVariant(e.variant, (v) => (v.scenes[e.variant!] = e.scene));
        } else if (e.type === 'done' && e.variant !== undefined) {
          setVariant(e.variant, (v) => v.status[e.variant!] !== 'error' && (v.status[e.variant!] = 'done'));
        } else if (e.type === 'error') {
          if (e.variant === undefined) patchReply((m) => ({ ...m, status: 'error', text: e.text }));
          else setVariant(e.variant, (v) => (v.status[e.variant!] = 'error'));
        }
      },
      { signal },
    );
    const count = get().variants?.scenes.length ?? 0;
    patchReply((m) => ({ ...m, text: `Here are ${count} on-brand variants. Pick one to open it in the editor and refine.` }));
  }
});

let saveTimer: ReturnType<typeof setTimeout> | undefined;
useEditor.subscribe((state, prev) => {
  if (state.scene === prev.scene) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => localStorage.setItem(SCENE_KEY, JSON.stringify(state.scene)), 300);
});
