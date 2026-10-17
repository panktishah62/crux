import type OpenAI from 'openai';
import type { AgentEvent, BrandKit, ChatTurn, Scene } from '../../../shared/types.ts';
import { config } from '../config.ts';
import { pro, withRetry } from '../llm.ts';
import { describeScene } from '../scene/ops.ts';
import { applyLintFixes, lintScene } from '../../../shared/lint.ts';
import { systemPrompt } from './prompts.ts';
import { runTool, toolDefinitions, type ToolContext } from './tools.ts';

export interface AgentRunInput {
  sessionId: string;
  kit: BrandKit;
  scene: Scene;
  request: string;
  history?: ChatTurn[];
  selectedLayerId?: string;
  variant?: number;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

const MAX_ROUNDS = 12;
/** Layout and brand problems get re-checked after each repair, up to this many repair rounds. */
const MAX_REPAIRS = 2;

/** Plan -> tool calls -> scene updates, until the model replies without tools. Returns the final scene. */
export async function runAgent(input: AgentRunInput): Promise<Scene> {
  const { emit, variant } = input;
  const scene: Scene = structuredClone(input.scene);
  const ctx: ToolContext = {
    sessionId: input.sessionId,
    scene,
    kit: input.kit,
    pending: [],
    emitStep: (text) => emit({ type: 'step', text, variant }),
    emitScene: (label) => emit({ type: 'scene', scene: structuredClone(scene), label, variant }),
  };

  const selected = input.selectedLayerId ? scene.layers.find((l) => l.id === input.selectedLayerId) : undefined;
  ctx.lockLayerId = selected?.id;
  const userContent = [
    input.request,
    selected ? `\nThe designer has selected layer ${selected.id} ("${selected.name}"). Edit ONLY that layer (update_layer, generate_image with its layerId, or delete_layer); calls touching other layers will be rejected.` : '',
    scene.layers.length ? `\nCurrent scene (edit only what the request targets):\n${describeScene(scene)}` : `\nThe canvas is empty (${scene.width}x${scene.height}). Create a complete design.`,
  ].join('');

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt(input.kit, scene) },
    ...(input.history ?? []).slice(-6).map((t) => ({ role: t.role, content: t.content }) as const),
    { role: 'user', content: userContent },
  ];

  emit({ type: 'step', text: scene.layers.length ? 'Reading the current design...' : 'Planning the layout...', variant });

  const isCreate = scene.layers.length === 0;
  let nudged = false;
  let repaired = 0;
  let finalText = '';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (input.signal?.aborted) break;
    const roundStart = Date.now();
    const res = await withRetry(
      () => pro.chat.completions.create({ model: config.pro.model, messages, tools: toolDefinitions, temperature: 0.7 }, { signal: input.signal }),
      'planner',
    );
    const msg = res.choices[0]?.message;
    if (!msg) {
      console.warn('[agent] empty response', JSON.stringify(res).slice(0, 500));
      break;
    }
    const calls = (msg.tool_calls ?? []).filter((c) => c.type === 'function');
    console.log(
      `[agent${variant !== undefined ? ` v${variant + 1}` : ''}] round ${round + 1} (${((Date.now() - roundStart) / 1000).toFixed(1)}s, ${res.usage?.completion_tokens ?? '?'} out tokens): ${calls.map((c) => c.function.name).join(', ') || 'reply'}`,
    );
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls.length ? calls : undefined });

    if (!calls.length) {
      const hasText = scene.layers.some((l) => l.type === 'text' || (l.type === 'shape' && l.label));
      if (isCreate && !hasText && !nudged) {
        nudged = true;
        emit({ type: 'step', text: 'Design incomplete, continuing...', variant });
        messages.push({ role: 'user', content: `The canvas is incomplete:\n${describeScene(scene)}\nFinish the full design now (background, visuals, headline, CTA, logo) using tools.` });
        continue;
      }
      const issues = repaired >= MAX_REPAIRS ? [] : checkIssues(scene, input.kit, ctx.lockLayerId);
      if (issues.length) {
        repaired++;
        emit({ type: 'step', text: `Layout & brand check: fixing ${issues.length} issue${issues.length > 1 ? 's' : ''}...`, variant });
        messages.push({
          role: 'user',
          content: `Layout and brand check found problems:\n${issues.map((i) => `- ${i}`).join('\n')}\nCurrent scene:\n${describeScene(scene)}\nFix them with update_layer/delete_layer (do not rebuild), then reply with a one-sentence summary of the whole design for the designer (not of these fixes).`,
        });
        continue;
      }
      finalText = msg.content?.trim() ?? '';
      console.log(`[agent${variant !== undefined ? ` v${variant + 1}` : ''}] finished after ${round + 1} rounds, ${scene.layers.length} layers`);
      break;
    }
    for (const call of calls) {
      if (process.env.AGENT_DEBUG) console.log(`[debug v${variant}] ${call.function.name} ${call.function.arguments.slice(0, 400)}\n  content: ${(msg.content ?? '').slice(0, 300)}`);
      let output: string;
      try {
        output = await runTool(ctx, call.function.name, call.function.arguments);
      } catch (err: any) {
        output = `Error: ${err?.message ?? err}`;
      }
      if (output.startsWith('Error') || /"(error|skipped)"/.test(output)) {
        console.log(`[agent${variant !== undefined ? ` v${variant + 1}` : ''}] ${call.function.name} -> ${output.slice(0, 300)}`);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }

  if (!input.signal?.aborted) autoFixBrand(scene, input.kit, ctx);

  if (ctx.pending.length) {
    emit({ type: 'step', text: `Waiting for ${ctx.pending.length} image${ctx.pending.length > 1 ? 's' : ''}...`, variant });
    await Promise.all(ctx.pending);
  }
  emit({ type: 'message', text: conciseReply(finalText), variant });
  return scene;
}

function checkIssues(scene: Scene, kit: BrandKit, lockLayerId?: string): string[] {
  return lintScene(scene, kit)
    .filter((i) => i.severity === 'error' && (!lockLayerId || i.layerId === lockLayerId))
    .map((i) => `[${i.rule}] ${i.message}${i.layerId ? ` (layer ${i.layerId})` : ''}`);
}

/** Deterministic repair of brand errors the model left behind (palette snaps, brand fonts, contrast, logo size/variant). */
function autoFixBrand(scene: Scene, kit: BrandKit, ctx: ToolContext): void {
  let applied = 0;
  for (let pass = 0; pass < 3; pass++) {
    const n = applyLintFixes(scene, lintScene(scene, kit), ctx.lockLayerId);
    if (!n) break;
    applied += n;
  }
  const remaining = lintScene(scene, kit).filter((i) => i.severity === 'error' && (!ctx.lockLayerId || i.layerId === ctx.lockLayerId));
  if (applied) {
    ctx.emitStep(`Brand linter auto-fixed ${applied} issue${applied > 1 ? 's' : ''}`);
    ctx.emitScene('Brand fixes');
  } else if (!remaining.length && kit.profile) {
    ctx.emitStep('Brand check passed');
  }
  if (remaining.length) ctx.emitStep(`Brand check: ${remaining.length} issue${remaining.length > 1 ? 's' : ''} need a designer's eye`);
}

/** Models sometimes narrate their layout maths before the summary; keep only the closing paragraph. */
function conciseReply(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return 'Done.';
  return paragraphs[paragraphs.length - 1].slice(0, 600);
}
