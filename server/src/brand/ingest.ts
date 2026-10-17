import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import { PDFParse } from 'pdf-parse';
import { ASSET_CATEGORIES, type Asset, type AssetCategory, type BrandKit, type BrandProfile } from '../../../shared/types.ts';
import { fileUrl, getKit, saveKit, sessionDir, urlToPath } from '../store.ts';
import { visionJson } from '../llm.ts';
import { GRID_CATEGORIES, aggregatePalette, colorGrid, dominantColors } from './colors.ts';
import { HEADLINE_FONTS, BODY_FONTS } from './fonts.ts';
import { pMap } from '../util.ts';
import { extractTemplates } from './archetypes.ts';

interface RawFile {
  relPath: string;
  data: Buffer;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
const FONT_EXT = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

/** Upload entry point: expands zips, stores files, then runs the pipeline in the background. */
export function startIngestion(sessionId: string, files: RawFile[], opts: { asReferences?: boolean } = {}): BrandKit {
  const kit = getKit(sessionId);
  kit.status = 'ingesting';
  kit.progress = 'Unpacking files...';
  saveKit(sessionId, kit);

  ingest(sessionId, files, opts).catch((err) => {
    console.error('[ingest] failed', err);
    const k = getKit(sessionId);
    k.status = k.profile ? 'ready' : 'error';
    k.progress = `Ingestion failed: ${err?.message ?? err}`;
    saveKit(sessionId, k);
  });
  return kit;
}

function expand(files: RawFile[]): RawFile[] {
  const out: RawFile[] = [];
  for (const f of files) {
    if (f.relPath.toLowerCase().endsWith('.zip')) {
      const zip = new AdmZip(f.data);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        out.push({ relPath: entry.entryName, data: entry.getData() });
      }
    } else out.push(f);
  }
  return out.filter((f) => {
    const parts = f.relPath.split('/');
    return !parts.some((p) => p.startsWith('.') || p === '__MACOSX');
  });
}

async function ingest(sessionId: string, files: RawFile[], opts: { asReferences?: boolean }) {
  const t0 = Date.now();
  const progress = (msg: string) => {
    const k = getKit(sessionId);
    k.progress = msg;
    saveKit(sessionId, k);
  };

  const all = expand(files);
  const filesDir = sessionDir(sessionId, 'files');
  const thumbsDir = sessionDir(sessionId, 'thumbs');
  const newAssets: (Asset & { _thumb?: Buffer })[] = [];
  const guidelineText: string[] = [];

  progress(`Processing ${all.length} files...`);
  await pMap(all, 8, async (f) => {
    const ext = path.extname(f.relPath).toLowerCase();
    const folder = path.dirname(f.relPath) === '.' ? undefined : path.dirname(f.relPath);
    const base = path.basename(f.relPath);

    if (IMAGE_EXT.has(ext)) {
      const id = nanoid(8);
      const abs = path.join(filesDir, `${id}${ext}`);
      fs.writeFileSync(abs, f.data);
      try {
        const img = sharp(f.data, { density: ext === '.svg' ? 144 : undefined });
        const meta = await img.metadata();
        const thumb = await sharp(f.data, { density: ext === '.svg' ? 144 : undefined })
          .resize(384, 384, { fit: 'inside', withoutEnlargement: false })
          .png()
          .toBuffer();
        const thumbAbs = path.join(thumbsDir, `${id}.png`);
        fs.writeFileSync(thumbAbs, thumb);
        const colors = (await dominantColors(thumb)).map((c) => c.hex);
        newAssets.push({
          id, filename: base, folder, url: fileUrl(abs), thumbUrl: fileUrl(thumbAbs), mime: MIME[ext],
          width: meta.width, height: meta.height, category: opts.asReferences ? 'reference' : 'other',
          colors, _thumb: thumb,
        });
      } catch (err) {
        console.warn('[ingest] could not read image', f.relPath, err);
      }
    } else if (FONT_EXT.has(ext)) {
      const id = nanoid(8);
      const abs = path.join(filesDir, `${id}${ext}`);
      fs.writeFileSync(abs, f.data);
      newAssets.push({
        id, filename: base, folder, url: fileUrl(abs), mime: MIME[ext], category: 'font',
        description: fontFamilyFromFilename(base),
      });
    } else if (ext === '.pdf') {
      const parser = new PDFParse({ data: new Uint8Array(f.data) });
      try {
        const text = await parser.getText();
        if (text.text.trim()) guidelineText.push(`# ${base}\n${text.text.slice(0, 20000)}`);
        const shots = await parser.getScreenshot({ first: 8, desiredWidth: 1200, imageBuffer: true, imageDataUrl: false });
        for (const page of shots.pages) {
          const id = nanoid(8);
          const buf = Buffer.from(page.data);
          const abs = path.join(filesDir, `${id}.png`);
          fs.writeFileSync(abs, buf);
          const thumb = await sharp(buf).resize(384, 384, { fit: 'inside' }).png().toBuffer();
          const thumbAbs = path.join(thumbsDir, `${id}.png`);
          fs.writeFileSync(thumbAbs, thumb);
          newAssets.push({
            id, filename: `${base} p${page.pageNumber}`, folder, url: fileUrl(abs), thumbUrl: fileUrl(thumbAbs),
            mime: 'image/png', width: page.width, height: page.height, category: 'guideline_page',
            colors: (await dominantColors(thumb)).map((c) => c.hex), _thumb: thumb,
          });
        }
      } catch (err) {
        console.warn('[ingest] could not parse pdf', f.relPath, err);
      } finally {
        await parser.destroy();
      }
    } else if (ext === '.txt' || ext === '.md') {
      guidelineText.push(`# ${base}\n${f.data.toString('utf8').slice(0, 20000)}`);
    }
  });

  const images = newAssets.filter((a) => a._thumb);
  progress(`Tagging ${images.length} assets with vision...`);
  const batches: (typeof images)[] = [];
  for (let i = 0; i < images.length; i += 8) batches.push(images.slice(i, i + 8));
  let done = 0;
  await pMap(batches, 6, async (batch) => {
    await classifyBatch(batch, guidelineText, opts.asReferences);
    done += batch.length;
    progress(`Tagged ${done}/${images.length} assets...`);
  });

  await Promise.all(images.filter((a) => GRID_CATEGORIES.has(a.category)).map(async (a) => (a.grid = await colorGrid(a._thumb!))));

  const kit = getKit(sessionId);
  const strip = ({ _thumb, ...a }: Asset & { _thumb?: Buffer }) => a as Asset;
  kit.assets = [...kit.assets, ...newAssets.map(strip)];
  delete kit.imageStyle;
  saveKit(sessionId, kit);

  const needsProfile = !kit.profile || newAssets.some((a) => a.category === 'logo' || a.category === 'guideline_page' || a.category === 'font');
  if (needsProfile && !opts.asReferences) {
    progress('Extracting brand profile...');
    const textFile = path.join(sessionDir(sessionId), 'guidelines.txt');
    const priorText = fs.existsSync(textFile) ? fs.readFileSync(textFile, 'utf8') : '';
    const allText = [priorText, ...guidelineText].filter(Boolean).join('\n\n');
    fs.writeFileSync(textFile, allText);
    kit.profile = await extractProfile(kit.assets, allText, newAssets);
    saveKit(sessionId, kit);
  }

  if (newAssets.some((a) => a.category === 'reference')) {
    progress('Extracting layout templates...');
    try {
      kit.templates = await extractTemplates(sessionId, kit, progress);
    } catch (err) {
      console.warn('[ingest] template extraction failed', err);
    }
  }

  kit.status = 'ready';
  kit.progress = `Ingested ${newAssets.length} assets in ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  saveKit(sessionId, kit);
  fs.writeFileSync(path.join(sessionDir(sessionId), 'assets.json'), JSON.stringify(kit.assets, null, 2));
}

export async function reextractProfile(sessionId: string): Promise<BrandKit> {
  const kit = getKit(sessionId);
  const textFile = path.join(sessionDir(sessionId), 'guidelines.txt');
  const text = fs.existsSync(textFile) ? fs.readFileSync(textFile, 'utf8') : '';
  kit.profile = await extractProfile(kit.assets, text, []);
  saveKit(sessionId, kit);
  return kit;
}

function fontFamilyFromFilename(name: string): string {
  return name
    .replace(/\.(ttf|otf|woff2?)$/i, '')
    .replace(/[-_](Regular|Bold|Black|Medium|Light|Thin|Heavy|SemiBold|ExtraBold|Italic|Condensed|Variable|VF)+$/gi, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

async function classifyBatch(batch: (Asset & { _thumb?: Buffer })[], guidelineText: string[], asReferences?: boolean) {
  const prompt = `You are tagging files from a brand kit for a design tool.
For each numbered image, return its category, a short description (max 15 words, mention dominant colours and subject), and 2-5 lowercase tags.
Categories:
- logo: brand wordmark/logo (note colour variant and whether it is a pill/badge version in the description)
- shape: abstract organic blobs/blooms or geometric shapes used as decoration or crop masks
- icon: small icons, 3D charms, emoji-like accents
- illustration: spot illustrations / drawn scenes
- background_template: full-format layouts made of shapes, intended as starting backgrounds
- product_photo: photos showing the product UI on devices (laptop/phone/tablet)
- photo: other photography (people, scenes)
- guideline_page: brand guideline pages with text/rules
- reference: finished ad/social post designs with headline text
- other: anything else
Folder names are strong hints when present.${asReferences ? '\nThese files were uploaded as reference ads, so prefer "reference" unless clearly something else.' : ''}
Respond as JSON: {"items":[{"index":0,"category":"...","description":"...","tags":["..."]}]}`;

  const images = batch.map((a, i) => ({
    label: `Image ${i}: file "${a.folder ? a.folder + '/' : ''}${a.filename}" (${a.width}x${a.height})`,
    dataUrl: `data:image/png;base64,${a._thumb!.toString('base64')}`,
  }));
  try {
    const res = await visionJson<{ items: { index: number; category: string; description: string; tags: string[] }[] }>(prompt, images);
    for (const item of res.items ?? []) {
      const asset = batch[item.index];
      if (!asset) continue;
      if (asset.category !== 'guideline_page' || item.category === 'guideline_page') {
        asset.category = (ASSET_CATEGORIES as string[]).includes(item.category) ? (item.category as AssetCategory) : 'other';
      }
      asset.description = item.description;
      asset.tags = item.tags;
    }
  } catch (err) {
    console.warn('[ingest] classification failed for batch', err);
    for (const a of batch) if (a.category === 'other') a.category = guessFromFolder(a);
  }
}

function guessFromFolder(a: Asset): AssetCategory {
  const p = `${a.folder ?? ''}/${a.filename}`.toLowerCase();
  if (p.includes('logo')) return 'logo';
  if (p.includes('bloom') || p.includes('shape')) return 'shape';
  if (p.includes('icon') || p.includes('charm')) return 'icon';
  if (p.includes('illustration')) return 'illustration';
  if (p.includes('template') || p.includes('background')) return 'background_template';
  if (p.includes('product') || p.includes('ui')) return 'product_photo';
  if (p.includes('photo')) return 'photo';
  return 'other';
}

const CATEGORY_WEIGHT: Partial<Record<AssetCategory, number>> = {
  logo: 4, shape: 3, background_template: 3, icon: 1.5, illustration: 1.5, guideline_page: 1, reference: 1, product_photo: 0.3, photo: 0.2,
};

async function extractProfile(assets: Asset[], guidelineText: string, fresh: (Asset & { _thumb?: Buffer })[]): Promise<BrandProfile> {
  const samples = assets.flatMap((a) =>
    (a.colors ?? []).map((hex, i) => ({ hex, weight: (CATEGORY_WEIGHT[a.category] ?? 0.5) / (i + 1) })),
  );
  const candidates = aggregatePalette(samples, 14);
  const logos = assets.filter((a) => a.category === 'logo');
  const fontFiles = assets.filter((a) => a.category === 'font');
  const thumbOf = (id: string): Buffer | undefined => {
    const cached = fresh.find((f) => f.id === id)?._thumb;
    if (cached) return cached;
    const asset = assets.find((a) => a.id === id);
    const p = asset?.thumbUrl ? urlToPath(asset.thumbUrl) : null;
    return p && fs.existsSync(p) ? fs.readFileSync(p) : undefined;
  };

  const visuals = [
    ...assets.filter((a) => a.category === 'guideline_page').slice(0, 6),
    ...logos.slice(0, 6),
    ...assets.filter((a) => a.category === 'reference' || a.category === 'background_template').slice(0, 4),
  ];
  const images = visuals
    .map((a) => {
      const thumb = thumbOf(a.id);
      return thumb
        ? { label: `Asset ${a.id} (${a.category}): ${a.filename} — ${a.description ?? ''}`, dataUrl: `data:image/png;base64,${thumb.toString('base64')}` }
        : null;
    })
    .filter((x): x is { label: string; dataUrl: string } => !!x);

  const counts = assets.reduce<Record<string, number>>((acc, a) => ((acc[a.category] = (acc[a.category] ?? 0) + 1), acc), {});

  const prompt = `You are extracting a structured brand profile from an uploaded brand kit. Nothing about the brand is known in advance.

Guideline text (may be empty):
"""
${guidelineText.slice(0, 15000) || '(none)'}
"""

Colour candidates sampled from asset pixels (most prominent first, approximate): ${candidates.join(', ')}
Asset counts by category: ${JSON.stringify(counts)}
Logo assets: ${logos.map((l) => `${l.id}: ${l.filename} — ${l.description ?? ''}`).join(' | ') || '(none)'}
Uploaded font files: ${fontFiles.map((f) => `${f.description} (${f.filename}, url ${f.url})`).join(' | ') || '(none)'}

Rules:
- palette: 4-8 brand colours. Prefer colours stated in guideline text (exact hex), else pick from the sampled candidates. Always include the neutrals the brand actually uses (e.g. white/off-white). Give each a short name and a role (primary, secondary, accent, background, text).
- fonts: if font files were uploaded use them (source "upload", url as given). Otherwise pick the closest Google Font substitute: headline from [${HEADLINE_FONTS.join(', ')}], body from [${BODY_FONTS.join(', ')}] (source "google"). Include a weight (e.g. 800 for heavy headlines) and a note on why.
- logos: one entry per logo asset id with its colour variant and what backgrounds it should be used on.
- rules: 5-10 short, concrete, enforceable rules (text colour on which backgrounds, logo usage, accent usage, things to never do).
- tone: one sentence on voice and copy style (e.g. headline length).
- safeZones: only if the kit specifies them (fractions 0-1 of canvas per side).

Respond as JSON:
{"name":"Brand","palette":[{"name":"Navy","hex":"#000856","role":"primary"}],"fonts":{"headline":{"family":"...","weight":800,"source":"google","note":"..."},"body":{"family":"...","weight":400,"source":"google"}},"logos":[{"assetId":"...","variant":"navy","useOn":"light backgrounds"}],"rules":["..."],"tone":"...","safeZones":[{"format":"story","top":0.14,"bottom":0.35,"left":0.06,"right":0.06}]}`;

  const profile = await visionJson<BrandProfile>(prompt, images, { strong: true, maxTokens: 3000 });
  profile.palette = (profile.palette ?? []).filter((c) => /^#[0-9a-f]{6}$/i.test(c.hex)).map((c) => ({ ...c, hex: c.hex.toUpperCase() }));
  profile.logos = (profile.logos ?? []).filter((l) => assets.some((a) => a.id === l.assetId));
  profile.rules ??= [];
  profile.fonts ??= { headline: { family: 'Anton', source: 'google' }, body: { family: 'Inter', source: 'google' } };
  return profile;
}
