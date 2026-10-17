import fs from 'node:fs';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import { config } from './config.ts';
import { getKit, readyKit, saveKit } from './store.ts';
import { reextractProfile, startIngestion } from './brand/ingest.ts';
import { runAgent } from './agent/loop.ts';
import { runVariants, type VariantsInput } from './agent/variants.ts';
import { runCritique } from './agent/critique.ts';
import { extractTemplates } from './brand/archetypes.ts';
import { analyse, planAndBuild, scoreAndRank, type ScoreInput } from './testlab/pipeline.ts';
import type { AgentEvent, BrandProfile, LayoutTemplate, Scene } from '../../shared/types.ts';
import type { Analysis, TestLabEvent, VariantPlan } from '../../shared/testlab.ts';

const app = express();
app.use(cors());
app.use(express.json({ limit: '60mb' }));

fs.mkdirSync(config.dataDir, { recursive: true });
app.use('/files', express.static(config.dataDir, { maxAge: '1h' }));

const upload = multer({ storage: multer.memoryStorage(), preservePath: true, limits: { fileSize: 200 * 1024 * 1024 } });

const sessionOf = (req: Request): string => {
  const id = req.header('x-session-id');
  if (!id || !/^[\w-]{4,64}$/.test(id)) throw Object.assign(new Error('Missing or invalid x-session-id'), { status: 400 });
  return id;
};

const route =
  (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
  async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      console.error(err);
      if (!res.headersSent) res.status(err?.status ?? 500).json({ error: err?.message ?? 'Internal error' });
      else res.end();
    }
  };

/** Opens an NDJSON stream; aborts the agent if the client disconnects. */
function openStream(res: Response) {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const emit = (event: AgentEvent) => {
    if (!res.writableEnded) res.write(JSON.stringify(event) + '\n');
  };
  return { emit, signal: controller.signal };
}

// Brand kit

app.get('/api/brand', route(async (req, res) => res.json(await readyKit(sessionOf(req)))));

app.post(
  '/api/brand/upload',
  upload.array('files'),
  route((req, res) => {
    const files = ((req.files as Express.Multer.File[]) ?? []).map((f) => ({ relPath: f.originalname, data: f.buffer }));
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
    res.json(startIngestion(sessionOf(req), files, { asReferences: req.body?.asReferences === 'true' }));
  }),
);

app.put(
  '/api/brand/profile',
  route((req, res) => {
    const sessionId = sessionOf(req);
    const kit = getKit(sessionId);
    kit.profile = req.body as BrandProfile;
    saveKit(sessionId, kit);
    res.json(kit);
  }),
);

app.patch(
  '/api/brand/assets/:id',
  route((req, res) => {
    const sessionId = sessionOf(req);
    const kit = getKit(sessionId);
    const asset = kit.assets.find((a) => a.id === req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    const { category, description } = req.body ?? {};
    if (category) asset.category = category;
    if (typeof description === 'string') asset.description = description;
    saveKit(sessionId, kit);
    res.json(kit);
  }),
);

app.delete(
  '/api/brand/assets/:id',
  route((req, res) => {
    const sessionId = sessionOf(req);
    const kit = getKit(sessionId);
    kit.assets = kit.assets.filter((a) => a.id !== req.params.id);
    saveKit(sessionId, kit);
    res.json(kit);
  }),
);

app.post('/api/brand/reextract', route(async (req, res) => res.json(await reextractProfile(sessionOf(req)))));

app.post(
  '/api/brand/templates/extract',
  route(async (req, res) => {
    const sessionId = sessionOf(req);
    const kit = getKit(sessionId);
    kit.templates = await extractTemplates(sessionId, kit);
    saveKit(sessionId, kit);
    res.json(kit);
  }),
);

app.put(
  '/api/brand/templates',
  route((req, res) => {
    const sessionId = sessionOf(req);
    const kit = getKit(sessionId);
    if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected an array of templates' });
    kit.templates = req.body as LayoutTemplate[];
    saveKit(sessionId, kit);
    res.json(kit);
  }),
);

app.delete(
  '/api/brand',
  route((req, res) => {
    const sessionId = sessionOf(req);
    const kit = { profile: null, assets: [], status: 'empty' as const };
    saveKit(sessionId, kit);
    res.json(kit);
  }),
);

// Agent

app.post(
  '/api/agent',
  route(async (req, res) => {
    const sessionId = sessionOf(req);
    const { scene, message, history, selectedLayerId } = req.body as {
      scene: Scene; message: string; history?: { role: 'user' | 'assistant'; content: string }[]; selectedLayerId?: string;
    };
    if (!scene || !message) return res.status(400).json({ error: 'scene and message are required' });
    const { emit, signal } = openStream(res);
    try {
      await runAgent({ sessionId, kit: await readyKit(sessionId), scene, request: message, history, selectedLayerId, emit, signal });
    } catch (err: any) {
      console.error('[agent]', err);
      emit({ type: 'error', text: err?.message ?? String(err) });
    }
    emit({ type: 'done' });
    res.end();
  }),
);

app.post(
  '/api/critique',
  route(async (req, res) => {
    const sessionId = sessionOf(req);
    const { scene, request, png, variant } = req.body as { scene: Scene; request: string; png: string; variant?: number };
    if (!scene || !png?.startsWith('data:image/')) return res.status(400).json({ error: 'scene and png are required' });
    const { emit, signal } = openStream(res);
    try {
      await runCritique({ sessionId, kit: await readyKit(sessionId), scene, request: request ?? '', png, variant, emit, signal });
    } catch (err: any) {
      console.error('[critique]', err);
      emit({ type: 'error', text: `Self-review failed: ${err?.message ?? err}`, variant });
    }
    emit({ type: 'done', variant });
    res.end();
  }),
);

// Creative Test Lab: analyse -> plan/build -> (client renders) -> score/rank

function testLabRoute(handler: (req: Request, sessionId: string, emit: (e: TestLabEvent) => void, signal: AbortSignal) => Promise<void>) {
  return route(async (req, res) => {
    const sessionId = sessionOf(req);
    const { emit, signal } = openStream(res);
    const send = emit as unknown as (e: TestLabEvent) => void;
    try {
      await handler(req, sessionId, send, signal);
    } catch (err: any) {
      console.error('[testlab]', err);
      send({ type: 'error', text: err?.message ?? String(err) });
    }
    send({ type: 'done' });
    res.end();
  });
}

app.post(
  '/api/test-lab/analyse',
  testLabRoute(async (req, sessionId, emit) => {
    const { scene, png } = req.body as { scene: Scene; png: string };
    if (!scene?.layers?.length || !png?.startsWith('data:image/')) throw new Error('scene and png are required');
    const t0 = Date.now();
    const analysis = await analyse({ scene, png, kit: await readyKit(sessionId) }, emit);
    console.log(`[testlab] analysed in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${analysis.total}/100`);
    emit({ type: 'analysed', analysis });
  }),
);

app.post(
  '/api/test-lab/plan',
  testLabRoute(async (req, sessionId, emit, signal) => {
    const { scene, analysis, only } = req.body as { scene: Scene; analysis: Analysis; only?: VariantPlan };
    if (!scene || !analysis) throw new Error('scene and analysis are required');
    const t0 = Date.now();
    await planAndBuild({ sessionId, scene, analysis, kit: await readyKit(sessionId), only, signal }, emit);
    console.log(`[testlab] planned and built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }),
);

app.post(
  '/api/test-lab/score',
  testLabRoute(async (req, sessionId, emit) => {
    const body = req.body as Omit<ScoreInput, 'kit'>;
    if (!body.original?.png || !body.variants?.length || !body.analysis) throw new Error('original, variants and analysis are required');
    const t0 = Date.now();
    await scoreAndRank({ ...body, kit: await readyKit(sessionId) }, emit);
    console.log(`[testlab] scored in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }),
);

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1 };

function parseCount(message: string): number {
  const m = message.toLowerCase().match(/\b(\d+|one|two|three|four|five|six)\b\s+(?:\w+\s+){0,3}?(?:images?|variations?|variants?|versions?|alternatives?|designs?|options?|posts?|ads?|creatives?)/);
  if (!m) return 4;
  return Number(m[1]) || WORD_NUMBERS[m[1]] || 4;
}

app.post(
  '/api/variants',
  upload.single('reference'),
  route(async (req, res) => {
    const sessionId = sessionOf(req);
    const message = String(req.body?.message ?? 'Create 4 different images like this');
    const width = Number(req.body?.width) || 1080;
    const height = Number(req.body?.height) || 1350;
    const format = String(req.body?.format ?? 'portrait');
    let context: VariantsInput['context'];
    try {
      const raw = JSON.parse(String(req.body?.context ?? '{}'));
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, 300)).slice(0, 12) : []);
      context = { history: strings(raw.history), sourceCopy: strings(raw.sourceCopy) };
    } catch {
      context = undefined;
    }
    const { emit, signal } = openStream(res);
    try {
      await runVariants({
        sessionId, kit: await readyKit(sessionId), request: message, count: parseCount(message), context,
        base: { width, height, format }, reference: req.file?.buffer, emit, signal,
      });
    } catch (err: any) {
      console.error('[variants]', err);
      emit({ type: 'error', text: err?.message ?? String(err) });
    }
    emit({ type: 'done' });
    res.end();
  }),
);

app.listen(config.port, () => console.log(`Server listening on http://localhost:${config.port}`));
