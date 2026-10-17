import OpenAI from 'openai';
import { z } from 'zod';
import { config } from './config.ts';

// The shared DeepSeek endpoint occasionally stalls a request indefinitely; time out and let withRetry re-issue it.
export const pro = new OpenAI({ baseURL: config.pro.baseURL, apiKey: config.pro.apiKey, maxRetries: 0, timeout: 45_000 });
export const flash = new OpenAI({ baseURL: config.flash.baseURL, apiKey: config.flash.apiKey, maxRetries: 0, timeout: 45_000 });
export const openai = new OpenAI({ apiKey: config.openai.apiKey, maxRetries: 0, timeout: 120_000 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries on 429 / 5xx / network errors with exponential backoff (rate limits are shared). */
export async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 5): Promise<T> {
  let delay = 1500;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status as number | undefined;
      const aborted = err?.name === 'APIUserAbortError' || err?.name === 'AbortError';
      const retriable = !aborted && (status === undefined || status === 429 || status >= 500);
      if (!retriable || i >= attempts - 1) throw err;
      console.warn(`[${label}] attempt ${i + 1} failed (${status ?? err?.message}); retrying in ${delay}ms`);
      await sleep(delay + Math.random() * 500);
      delay *= 2;
    }
  }
}

/** Extracts the first JSON object from a model response (tolerates ```json fences and prose). */
export function parseJsonLoose<T = any>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start === -1) throw new Error('No JSON found in model output');
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  return JSON.parse(body.slice(start, end + 1));
}

export async function flashJson<T>(system: string, user: string): Promise<T> {
  const res = await withRetry(
    () =>
      flash.chat.completions.create({
        model: config.flash.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.9,
      }),
    'flash',
  );
  return parseJsonLoose<T>(res.choices[0]?.message?.content ?? '');
}

export type VisionImage = { dataUrl: string; label?: string };

export async function visionJson<T>(
  prompt: string,
  images: VisionImage[],
  opts: { strong?: boolean; maxTokens?: number; detail?: 'low' | 'high'; system?: string; temperature?: number; seed?: number } = {},
): Promise<T> {
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: prompt }];
  for (const img of images) {
    if (img.label) content.push({ type: 'text', text: img.label });
    content.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: opts.detail ?? 'low' } });
  }
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'user', content }];
  if (opts.system) messages.unshift({ role: 'system', content: opts.system });
  const res = await withRetry(
    () =>
      openai.chat.completions.create({
        model: opts.strong ? config.openai.visionModelStrong : config.openai.visionModel,
        messages,
        response_format: { type: 'json_object' },
        max_tokens: opts.maxTokens ?? 4000,
        temperature: opts.temperature,
        seed: opts.seed,
      }),
    'vision',
  );
  return parseJsonLoose<T>(res.choices[0]?.message?.content ?? '');
}

/** Validates a model response; on a schema error re-asks once with the error appended. */
export async function askValidated<T>(ask: (feedback?: string) => Promise<unknown>, schema: z.ZodType<T>, label: string): Promise<T> {
  let raw: unknown;
  try {
    raw = await ask();
  } catch (err: any) {
    raw = { __error: err?.message ?? String(err) };
  }
  const first = schema.safeParse(raw);
  if (first.success) return first.data;
  const problem = '__error' in (raw as object) ? String((raw as any).__error) : z.prettifyError(first.error);
  console.warn(`[${label}] invalid response, re-asking: ${problem.slice(0, 300)}`);
  const second = schema.safeParse(await ask(`Your previous reply was invalid:\n${problem}\nReply again with JSON that matches the schema exactly.`));
  if (second.success) return second.data;
  throw new Error(`${label}: model returned invalid JSON twice (${z.prettifyError(second.error).slice(0, 200)})`);
}
