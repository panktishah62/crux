import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import sharp from 'sharp';
import { toFile } from 'openai';
import type { Asset, BrandKit } from '../../shared/types.ts';
import { config } from './config.ts';
import { openai, visionJson, withRetry } from './llm.ts';
import { fileUrl, saveKit, sessionDir, urlToPath } from './store.ts';

type ImageSize = '1024x1024' | '1024x1536' | '1536x1024';

function sizeFor(width: number, height: number): ImageSize {
  const ratio = width / height;
  if (ratio > 1.25) return '1536x1024';
  if (ratio < 0.8) return '1024x1536';
  return '1024x1024';
}

const NO_TEXT =
  'Absolutely no text, letters, numbers, words, logos, watermarks, UI or signage anywhere in the image. ' +
  'Leave calm negative space so text layers can be placed on top.';

const ILLUSTRATION = /illustrat|vector|flat|cartoon|3d render|isometric|icon/i;
const PEOPLE = /\b(person|people|wom[ae]n|m[ae]n|owners?|founders?|team|customers?|clients?|staff|workers?|employees?|designers?|smiling|portrait|florists?|bakers?|chefs?|family|colleagues?|entrepreneurs?|freelancers?)\b/i;

const describe = (a: Asset) => [a.description ?? '', ...(a.tags ?? [])].join(' ');

/** Up to 3 kit images whose look the new image should match, chosen by what the prompt depicts. */
export function pickStyleReferences(kit: BrandKit, prompt: string, role?: string): Asset[] {
  const drawn = role === 'illustration' || ILLUSTRATION.test(prompt);
  const people = !drawn && PEOPLE.test(prompt);
  const words = new Set(prompt.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const score = (a: Asset) =>
    (describe(a).toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => words.has(w)).length ?? 0) + (people && PEOPLE.test(describe(a)) ? 5 : 0);
  const ranked = (categories: string[], filter: (a: Asset) => boolean = () => true) =>
    kit.assets
      .filter((a) => categories.includes(a.category) && a.url && filter(a))
      .sort((x, y) => score(y) - score(x));
  if (drawn) return [...ranked(['illustration']).slice(0, 2), ...ranked(['reference']).slice(0, 1)].slice(0, 3);
  if (people) {
    const withPeople = ranked(['reference', 'photo', 'product_photo'], (a) => PEOPLE.test(describe(a))).slice(0, 3);
    return [...withPeople, ...ranked(['photo', 'product_photo'], (a) => !withPeople.includes(a))].slice(0, 3);
  }
  return [...ranked(['photo', 'product_photo']).slice(0, 2), ...ranked(['reference']).slice(0, 1)].slice(0, 3);
}

const refCache = new Map<string, Buffer>();

async function referenceBuffer(asset: Asset): Promise<Buffer | null> {
  let buf = refCache.get(asset.id);
  if (!buf) {
    const file = urlToPath(asset.url);
    if (!file || !fs.existsSync(file)) return null;
    buf = await sharp(fs.readFileSync(file)).resize(768, 768, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    refCache.set(asset.id, buf);
  }
  return buf;
}

async function referenceFile(asset: Asset) {
  const buf = await referenceBuffer(asset);
  return buf ? toFile(buf, `${asset.id}.png`, { type: 'image/png' }) : null;
}

const styleJobs = new Map<string, Promise<string | undefined>>();

/** Writes (once per kit, cached on it) the brand's photography or illustration house style from its own images. */
async function brandStyle(sessionId: string, kit: BrandKit, kind: 'photo' | 'illustration'): Promise<string | undefined> {
  if (kit.imageStyle?.[kind]) return kit.imageStyle[kind];
  const key = `${sessionId}:${kind}`;
  if (!styleJobs.has(key)) {
    styleJobs.set(key, (async () => {
      const samples = kind === 'illustration'
        ? kit.assets.filter((a) => a.category === 'illustration').slice(0, 6)
        : [
            ...kit.assets.filter((a) => (a.category === 'reference' || a.category === 'photo') && PEOPLE.test(describe(a))).slice(0, 5),
            ...kit.assets.filter((a) => a.category === 'product_photo').slice(0, 2),
          ];
      const images = (await Promise.all(samples.map(referenceBuffer))).filter((b) => b !== null).map((b) => ({ dataUrl: `data:image/png;base64,${b.toString('base64')}` }));
      if (!images.length) return undefined;
      try {
        const res = await visionJson<{ style: string }>(
          `These are a brand's own ${kind === 'photo' ? 'ads and product photos' : 'illustrations'}. Write the brand's ${kind === 'photo' ? 'photography' : 'illustration'} house style as a 2-3 sentence art direction an image model can follow: ${kind === 'photo' ? 'who the subjects are and how they are shown (candid vs posed), settings, lighting, white balance (warm, neutral or cool) and overall brightness, colour grading, lens/depth of field, framing, and mood' : 'rendering style (flat, 3D, line), shapes, line weight, shading, palette use, level of detail and mood'}. Ignore the text, logos, buttons and graphic overlays. Respond as JSON: {"style":"..."}`,
          images,
          { maxTokens: 300 },
        );
        const style = String(res.style ?? '').trim();
        if (!style) return undefined;
        kit.imageStyle = { ...kit.imageStyle, [kind]: style };
        saveKit(sessionId, kit);
        console.log(`[image] ${kind} house style: ${style}`);
        return style;
      } catch (err) {
        console.warn('[image] could not derive house style:', (err as Error)?.message ?? err);
        return undefined;
      } finally {
        styleJobs.delete(key);
      }
    })());
  }
  return styleJobs.get(key);
}

/** The image model only ever produces pixels (photos, scenes, textures); text and brand assets are separate layers. */
export async function generateImage(
  sessionId: string,
  prompt: string,
  slot: { width: number; height: number; role?: string },
  styleHint?: string,
  kit?: BrandKit,
): Promise<string> {
  const size = sizeFor(slot.width, slot.height);
  const drawn = slot.role === 'illustration' || ILLUSTRATION.test(prompt);
  const refs = kit ? pickStyleReferences(kit, prompt, slot.role) : [];
  const [files, house] = await Promise.all([
    Promise.all(refs.map(referenceFile)).then((f) => f.filter((x) => x !== null)),
    kit ? brandStyle(sessionId, kit, drawn ? 'illustration' : 'photo') : undefined,
  ]);
  const fullPrompt = [
    house && `Brand ${drawn ? 'illustration' : 'photography'} style (follow closely): ${house}`,
    `Subject: ${prompt}`,
    files.length && `The attached images are this brand's own ${drawn ? 'illustrations' : 'ads and photos'}. Make a NEW image that looks like it belongs in the same campaign: match their ${drawn ? 'illustration style, shapes, line weight, shading and palette' : 'kind of people and settings, lighting, colour grading, depth of field, framing and mood'}. Do not copy their exact subjects, layouts, UI, text, graphics or logos.`,
    styleHint,
    NO_TEXT,
  ].filter(Boolean).join('\n');

  const generate = () =>
    withRetry(
      () => openai.images.generate({ model: config.openai.imageModel, prompt: fullPrompt, size, quality: config.openai.imageQuality, n: 1 }),
      'image',
      3,
    );
  let res;
  if (files.length) {
    try {
      res = await withRetry(
        () => openai.images.edit({ model: config.openai.imageModel, image: files, prompt: fullPrompt, size, quality: config.openai.imageQuality, n: 1 }),
        'image-styled',
        2,
      );
      console.log(`[image] styled on ${refs.map((a) => `${a.category}:${(a.description ?? a.filename).slice(0, 40)}`).join(' | ')}`);
    } catch (err) {
      console.warn('[image] style-referenced generation failed, falling back to plain generation:', (err as Error)?.message ?? err);
      res = await generate();
    }
  } else {
    res = await generate();
  }
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error('Image model returned no data');
  let png: Buffer = Buffer.from(b64, 'base64');
  if (!drawn && kit) png = await neutralise(png);
  const abs = path.join(sessionDir(sessionId, 'generated'), `${nanoid(10)}.png`);
  fs.writeFileSync(abs, png);
  return fileUrl(abs);
}

/**
 * The image model drifts to a warm amber, dim "stock cafe" grade regardless of references; brand photography is bright
 * and neutral. Pulls channel means 60% of the way to grey and lifts dim images, leaving composition untouched.
 */
async function neutralise(png: Buffer): Promise<Buffer> {
  const { channels } = await sharp(png).stats();
  const [r, g, b] = channels.slice(0, 3).map((c) => Math.max(1, c.mean));
  const grey = (r + g + b) / 3;
  const gains = [r, g, b].map((m) => 1 + 0.6 * (grey / m - 1));
  const lift = Math.min(1.3, Math.max(1, 118 / grey));
  return sharp(png).linear(gains.map((k) => k * lift), [0, 0, 0]).png().toBuffer();
}
