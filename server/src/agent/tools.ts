import { z } from 'zod';
import type OpenAI from 'openai';
import type { BrandKit, ImageLayer, Layer, LayerRole, Scene, ShapeLayer, TextLayer } from '../../../shared/types.ts';
import { describeScene, estimateTextHeight, findLayer, moveLayer, newLayerId } from '../scene/ops.ts';
import { generateImage } from '../images.ts';
import { isOnPalette, nearestColor } from '../../../shared/color.ts';
import { buildFromTemplate } from '../../../shared/templates.ts';

export interface ToolContext {
  sessionId: string;
  scene: Scene;
  kit: BrandKit;
  /** Streams the current scene to the client. */
  emitScene: (label: string) => void;
  emitStep: (text: string) => void;
  /** Background work (image generation) awaited before the turn ends. */
  pending: Promise<void>[];
  /** Selection-aware chat: only this layer may be changed. */
  lockLayerId?: string;
}

const ROLES = ['background', 'photo', 'illustration', 'decoration', 'card', 'headline', 'subheadline', 'body', 'offer', 'cta', 'logo', 'disclaimer', 'other'] as const;
const hex = z.string().regex(/^#([0-9a-fA-F]{6})$/, 'Colour must be a 6-digit hex like #000856');
const role = z.enum(ROLES).optional();
const box = {
  x: z.number().describe('Left edge in canvas px'),
  y: z.number().describe('Top edge in canvas px'),
  width: z.number().positive(),
};

const schemas = {
  get_scene: z.object({}).describe('Return the current scene graph (layers bottom to top).'),

  set_background: z
    .object({
      color: hex.optional().describe('Solid canvas background colour'),
      assetId: z.string().optional().describe('Optional background_template asset id to place full-bleed as the bottom layer'),
    })
    .describe('Set the canvas background colour and/or a full-bleed background template from the brand kit.'),

  add_text: z
    .object({
      text: z.string().min(1).describe('Use \\n for deliberate line breaks'),
      role,
      ...box,
      fontSize: z.number().positive(),
      fill: hex,
      fontFamily: z.string().optional().describe('Defaults to the brand headline font for headline/subheadline/offer, body font otherwise'),
      fontWeight: z.number().optional(),
      align: z.enum(['left', 'center', 'right']).optional(),
      lineHeight: z.number().optional(),
      letterSpacing: z.number().optional().describe('In 1/1000 em'),
      uppercase: z.boolean().optional(),
      name: z.string().optional(),
    })
    .describe('Add a text layer. Returns the layer id and its estimated rendered height.'),

  add_shape: z
    .object({
      shape: z.enum(['rect', 'ellipse']),
      role,
      ...box,
      height: z.number().positive(),
      fill: hex,
      cornerRadius: z.number().optional().describe('For rect; use height/2 for a pill'),
      stroke: hex.optional(),
      strokeWidth: z.number().optional(),
      opacity: z.number().min(0).max(1).optional(),
      label: z.string().optional().describe('Centred text inside the shape, e.g. a CTA pill'),
      labelColor: hex.optional(),
      labelFontSize: z.number().optional(),
      labelFontWeight: z.number().optional(),
      name: z.string().optional(),
    })
    .describe('Add a rectangle/ellipse: cards, panels, colour blocks, CTA pills (with label).'),

  add_asset: z
    .object({
      assetId: z.string().describe('Id from the brand asset library'),
      role,
      ...box,
      height: z.number().positive().optional().describe('Omit to keep the asset aspect ratio'),
      fit: z.enum(['contain', 'cover']).optional(),
      opacity: z.number().min(0).max(1).optional(),
      rotation: z.number().optional(),
      name: z.string().optional(),
    })
    .describe('Place a brand kit asset (logo, shape, icon, illustration, product photo, template) by id.'),

  generate_image: z
    .object({
      prompt: z.string().min(5).describe('Describe a photo/scene/texture only. Never ask for text, logos or product UI.'),
      role,
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      cornerRadius: z.number().optional(),
      layerId: z.string().optional().describe('Replace the pixels of an existing image layer, keeping its position'),
      name: z.string().optional(),
    })
    .describe('Generate a background or photo with the image model into an image slot. Runs in the background; returns the layer id immediately.'),

  add_layers: z
    .object({
      layers: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe(
          'Ordered bottom to top. Each item has "kind": "text" | "shape" | "asset" | "image" plus the same fields as add_text / add_shape / add_asset / generate_image.',
        ),
    })
    .describe('Add many NEW layers in one call (preferred for building a full design). Never use it to change or replace existing layers; use update_layer / generate_image(layerId) for those. Returns ids and text heights in order.'),

  update_layer: z
    .object({
      layerId: z.string(),
      changes: z
        .object({
          x: z.number(), y: z.number(), width: z.number(), height: z.number(), rotation: z.number(), opacity: z.number(),
          text: z.string(), fontSize: z.number(), fontFamily: z.string(), fontWeight: z.number(), fill: hex,
          align: z.enum(['left', 'center', 'right']), lineHeight: z.number(), letterSpacing: z.number(), uppercase: z.boolean(),
          cornerRadius: z.number(), stroke: hex, strokeWidth: z.number(),
          label: z.string(), labelColor: hex, labelFontSize: z.number(), labelFontWeight: z.number(),
          fit: z.enum(['contain', 'cover']), name: z.string(), role: z.enum(ROLES),
          assetId: z.string().describe('Swap an image layer to another brand asset (e.g. a different logo variant)'),
        })
        .partial()
        .strict(),
      z: z.enum(['front', 'back', 'forward', 'backward']).optional().describe('Change stacking order'),
    })
    .strict()
    .describe('Change properties of an existing layer. Only pass the fields that change. To change the pixels of an image use generate_image with layerId.'),

  delete_layer: z.object({ layerId: z.string() }).describe('Remove a layer.'),

  apply_layout: z
    .object({
      templateId: z.string().describe('Id of a layout template from the brand kit'),
      texts: z.record(z.string(), z.string()).optional().describe('slotId -> copy for text and cta slots; keep within maxWords'),
      imagePrompts: z.record(z.string(), z.string()).optional().describe('slotId -> photo prompt for photo slots (no text in images)'),
      replace: z.boolean().optional().describe('Replace all existing layers (default true)'),
    })
    .describe('Build a complete on-brand design from a layout template, adapted to the current canvas ratio. Brand assets, logo variant and text colours are chosen automatically. Afterwards adjust individual layers with update_layer.'),
} as const;

type ToolName = keyof typeof schemas;

export const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = (Object.keys(schemas) as ToolName[]).map((name) => {
  const { $schema, ...parameters } = z.toJSONSchema(schemas[name]) as Record<string, unknown>;
  return {
    type: 'function',
    function: { name, description: schemas[name].description ?? name, parameters },
  };
});

function paletteWarnings(kit: BrandKit, colors: (string | undefined)[]): string[] {
  const palette = kit.profile?.palette ?? [];
  if (!palette.length) return [];
  const hexes = palette.map((p) => p.hex);
  return colors
    .filter((c): c is string => !!c && !isOnPalette(c, hexes))
    .map((c) => {
      const near = nearestColor(c, hexes).hex;
      return `${c} is off-palette; nearest brand colour is ${palette.find((p) => p.hex === near)?.name ?? ''} ${near}.`;
    });
}

/** Fills an image layer from the image model in the background; the turn awaits ctx.pending. */
function startImageGeneration(ctx: ToolContext, layer: ImageLayer, prompt: string): void {
  layer.pending = true;
  layer.prompt = prompt;
  const palette = ctx.kit.profile?.palette.map((p) => `${p.name} ${p.hex}`).join(', ');
  const style = palette ? `Colour grading should harmonise with this brand palette: ${palette}.` : undefined;
  ctx.pending.push(
    generateImage(ctx.sessionId, prompt, layer, style, ctx.kit)
      .then((src) => {
        layer.src = src;
        layer.pending = false;
        ctx.emitStep(`Image ready for ${layer.name}`);
        ctx.emitScene(`${layer.name} image`);
      })
      .catch((err) => {
        console.error('[generate_image]', err);
        ctx.scene.layers = ctx.scene.layers.filter((l) => l !== layer || !!l.src);
        layer.pending = false;
        ctx.emitStep(`Image generation failed: ${err?.message ?? err}`);
        ctx.emitScene('Image failed');
      }),
  );
}

/** Models sometimes re-issue a whole build; an item matching an existing layer is skipped instead of stacked twice. */
function findDuplicate(scene: Scene, kit: BrandKit, kind: string, item: Record<string, unknown>): Layer | undefined {
  const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const near = (l: Layer) => Math.abs(l.x - Number(item.x ?? 0)) < 40 && Math.abs(l.y - Number(item.y ?? 0)) < 40;
  const isLogoAsset = (id: unknown) => kit.assets.some((a) => a.id === id && a.category === 'logo');
  const covers = (l: Layer) => {
    const x = Number(item.x ?? 0), y = Number(item.y ?? 0), w = Number(item.width ?? scene.width), h = Number(item.height ?? scene.height);
    const ox = Math.max(0, Math.min(l.x + l.width, x + w) - Math.max(l.x, x));
    const oy = Math.max(0, Math.min(l.y + l.height, y + h) - Math.max(l.y, y));
    return ox * oy > 0.6 * Math.min(w * h, l.width * l.height);
  };
  return scene.layers.find((l) => {
    if (kind === 'text') return l.type === 'text' && (norm(l.text) === norm(item.text) || (item.role === 'headline' && l.role === 'headline'));
    if (kind === 'shape') return l.type === 'shape' && !!item.label && !!l.label;
    if (kind === 'asset') return l.type === 'image' && ((l.assetId === item.assetId && near(l)) || (isLogoAsset(item.assetId) && l.role === 'logo'));
    if (kind === 'image') return l.type === 'image' && (item.role ?? 'photo') === l.role && (l.role === 'photo' || l.role === 'background') && covers(l);
    return false;
  });
}

/** With a selected layer, every tool call must target that layer only. */
function lockViolation(ctx: ToolContext, name: ToolName, args: any): string | null {
  const lock = ctx.lockLayerId;
  if (!lock || name === 'get_scene') return null;
  const target = name === 'update_layer' || name === 'delete_layer' || name === 'generate_image' ? args.layerId : undefined;
  if (target === lock) return null;
  return `Error: the designer selected layer ${lock}; only that layer may be changed this turn (use update_layer, generate_image with layerId "${lock}", or delete_layer on it). Do not touch or add other layers.`;
}

/** A new image that lands on an existing image of the same role is usually its replacement: stack it right above. */
function insertImage(scene: Scene, layer: ImageLayer): void {
  const area = layer.width * layer.height;
  const index = scene.layers.findIndex((l) => {
    if (l.type !== 'image' || l.role !== layer.role) return false;
    const ox = Math.max(0, Math.min(l.x + l.width, layer.x + layer.width) - Math.max(l.x, layer.x));
    const oy = Math.max(0, Math.min(l.y + l.height, layer.y + layer.height) - Math.max(l.y, layer.y));
    return ox * oy > 0.6 * Math.min(area, l.width * l.height);
  });
  if (index >= 0) scene.layers.splice(index + 1, 0, layer);
  else scene.layers.push(layer);
}

function defaultFont(kit: BrandKit, r?: LayerRole) {
  const fonts = kit.profile?.fonts;
  const isDisplay = r === 'headline' || r === 'subheadline' || r === 'offer';
  const f = isDisplay ? fonts?.headline : fonts?.body;
  return { family: f?.family ?? (isDisplay ? 'Anton' : 'Inter'), weight: f?.weight ?? (isDisplay ? 800 : 400) };
}

function step(name: ToolName, args: any, scene: Scene, templateName?: string): string {
  const layerName = (id: string) => {
    const l = findLayer(scene, id);
    if (!l) return id;
    return l.type === 'text' ? `“${l.text.replace(/\n/g, ' ').slice(0, 30)}”` : l.name;
  };
  switch (name) {
    case 'get_scene': return 'Reading the canvas...';
    case 'set_background': return args.assetId ? 'Placing background template...' : `Setting background ${args.color ?? ''}...`;
    case 'add_text': return `Adding ${args.role ?? 'text'} “${String(args.text).replace(/\n/g, ' ').slice(0, 40)}”...`;
    case 'add_shape': return args.label ? `Adding ${args.role ?? 'button'} “${args.label}”...` : `Adding ${args.role ?? args.shape}...`;
    case 'add_asset': return `Placing ${args.role ?? 'asset'} from brand kit...`;
    case 'generate_image': return args.layerId ? `Regenerating image: ${String(args.prompt).slice(0, 50)}...` : `Generating image: ${String(args.prompt).slice(0, 50)}...`;
    case 'add_layers': return `Laying out ${args.layers.length} layers...`;
    case 'update_layer': return `Updating ${layerName(args.layerId)} (${Object.keys(args.changes ?? {}).concat(args.z ? ['order'] : []).join(', ')})...`;
    case 'delete_layer': return `Removing ${layerName(args.layerId)}...`;
    case 'apply_layout': return `Applying layout “${templateName ?? args.templateId}”...`;
  }
}

/** Validates and executes one tool call against the scene. Errors are returned to the model as text. */
export async function runTool(ctx: ToolContext, name: string, rawArgs: string): Promise<string> {
  if (!(name in schemas)) return `Error: unknown tool "${name}".`;
  let json: unknown;
  try {
    json = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return 'Error: arguments were not valid JSON. Re-issue the call.';
  }
  const parsed = schemas[name as ToolName].safeParse(json);
  if (!parsed.success) {
    const hint = name === 'update_layer' && /prompt|src|image/i.test(rawArgs)
      ? ' To replace an image, call generate_image with layerId and a new prompt.'
      : '';
    return `Error: invalid arguments: ${z.prettifyError(parsed.error)}.${hint} Fix and re-issue the call.`;
  }
  const args = parsed.data as any;
  const violation = lockViolation(ctx, name as ToolName, args);
  if (violation) return violation;
  const { scene, kit } = ctx;
  ctx.emitStep(step(name as ToolName, args, scene, kit.templates?.find((t) => t.id === args.templateId)?.name));

  const result = (obj: Record<string, unknown>, warnings: string[] = []) =>
    JSON.stringify(warnings.length ? { ...obj, warnings } : obj);

  switch (name as ToolName) {
    case 'get_scene':
      return describeScene(scene);

    case 'set_background': {
      if (args.color) scene.background = args.color;
      let id: string | undefined;
      if (args.assetId) {
        const asset = kit.assets.find((a) => a.id === args.assetId);
        if (!asset) return `Error: no asset with id ${args.assetId}.`;
        scene.layers = scene.layers.filter((l) => l.role !== 'background' || l.type !== 'image');
        id = newLayerId('bg');
        scene.layers.unshift({
          id, type: 'image', name: 'Background', role: 'background', x: 0, y: 0, width: scene.width, height: scene.height,
          src: asset.url, assetId: asset.id, fit: 'cover',
        });
      }
      ctx.emitScene('Background');
      return result({ ok: true, layerId: id }, paletteWarnings(kit, [args.color]));
    }

    case 'add_text': {
      const font = defaultFont(kit, args.role);
      const layer: TextLayer = {
        id: newLayerId('txt'), type: 'text', name: args.name ?? args.role ?? 'Text', role: args.role ?? 'body',
        x: args.x, y: args.y, width: args.width, height: 0,
        text: args.text, fontSize: args.fontSize, fill: args.fill,
        fontFamily: args.fontFamily ?? font.family, fontWeight: args.fontWeight ?? font.weight,
        align: args.align ?? 'left', lineHeight: args.lineHeight, letterSpacing: args.letterSpacing, uppercase: args.uppercase,
      };
      layer.height = estimateTextHeight(layer);
      scene.layers.push(layer);
      ctx.emitScene(layer.name);
      return result({ layerId: layer.id, estimatedHeight: layer.height, bottom: Math.round(layer.y + layer.height) }, paletteWarnings(kit, [args.fill]));
    }

    case 'add_shape': {
      const body = defaultFont(kit, 'cta');
      const layer: ShapeLayer = {
        id: newLayerId('shp'), type: 'shape', name: args.name ?? args.role ?? args.shape, role: args.role ?? 'decoration',
        shape: args.shape, x: args.x, y: args.y, width: args.width, height: args.height, fill: args.fill,
        cornerRadius: args.cornerRadius, stroke: args.stroke, strokeWidth: args.strokeWidth, opacity: args.opacity,
        label: args.label, labelColor: args.labelColor,
        labelFontSize: args.labelFontSize ?? (args.label ? Math.round(args.height * 0.38) : undefined),
        labelFontWeight: args.labelFontWeight ?? (args.label ? 700 : undefined),
        labelFontFamily: args.label ? body.family : undefined,
      };
      scene.layers.push(layer);
      ctx.emitScene(layer.name);
      return result({ layerId: layer.id }, paletteWarnings(kit, [args.fill, args.stroke, args.labelColor]));
    }

    case 'add_asset': {
      const asset = kit.assets.find((a) => a.id === args.assetId);
      if (!asset) return `Error: no asset with id ${args.assetId}. Pick an id from the asset library list.`;
      const aspect = asset.width && asset.height ? asset.height / asset.width : 1;
      const layer: ImageLayer = {
        id: newLayerId('ast'), type: 'image', name: args.name ?? asset.category, role: args.role ?? (asset.category === 'logo' ? 'logo' : 'decoration'),
        x: args.x, y: args.y, width: args.width, height: args.height ?? Math.round(args.width * aspect),
        src: asset.url, assetId: asset.id, fit: args.fit ?? 'contain', opacity: args.opacity, rotation: args.rotation,
      };
      if (layer.role === 'photo' || layer.role === 'illustration') insertImage(scene, layer);
      else scene.layers.push(layer);
      ctx.emitScene(layer.name);
      return result({ layerId: layer.id, height: layer.height });
    }

    case 'generate_image': {
      let layer: ImageLayer;
      if (args.layerId) {
        const existing = findLayer(scene, args.layerId);
        if (!existing || existing.type !== 'image') return `Error: ${args.layerId} is not an image layer.`;
        layer = existing;
        delete layer.assetId;
      } else {
        layer = {
          id: newLayerId('img'), type: 'image', name: args.name ?? args.role ?? 'Image', role: args.role ?? 'photo',
          x: args.x ?? 0, y: args.y ?? 0, width: args.width ?? scene.width, height: args.height ?? scene.height,
          src: '', fit: 'cover', cornerRadius: args.cornerRadius,
        };
        insertImage(scene, layer);
      }
      startImageGeneration(ctx, layer, args.prompt);
      ctx.emitScene(layer.name);
      return result({ layerId: layer.id, status: 'generating in background; continue with other layers' });
    }

    case 'add_layers': {
      const KIND_TO_TOOL: Record<string, ToolName> = { text: 'add_text', shape: 'add_shape', asset: 'add_asset', image: 'generate_image' };
      const results: unknown[] = [];
      for (const [i, item] of (args.layers as Record<string, unknown>[]).entries()) {
        const { kind, ...rest } = item;
        const tool = KIND_TO_TOOL[String(kind)];
        if (!tool) {
          results.push({ index: i, error: `unknown kind "${kind}" (use text, shape, asset or image)` });
          continue;
        }
        const dup = findDuplicate(scene, kit, String(kind), rest);
        if (dup) {
          const how = kind === 'image' ? `generate_image with layerId "${dup.id}"` : `update_layer on ${dup.id}`;
          results.push({ index: i, skipped: `a ${dup.role ?? kind} already exists (${dup.id}); to change it use ${how}` });
          continue;
        }
        const out = await runTool(ctx, tool, JSON.stringify(rest));
        results.push(out.startsWith('Error') ? { index: i, error: out } : { index: i, ...JSON.parse(out) });
      }
      return JSON.stringify(results);
    }

    case 'update_layer': {
      const layer = findLayer(scene, args.layerId);
      if (!layer) return `Error: no layer ${args.layerId}. Call get_scene to see ids.`;
      if (args.changes.assetId) {
        const asset = kit.assets.find((a) => a.id === args.changes.assetId);
        if (!asset) return `Error: no asset with id ${args.changes.assetId}.`;
        if (layer.type !== 'image') return `Error: ${layer.id} is not an image layer; assetId only applies to images.`;
        layer.src = asset.url;
        layer.pending = false;
        delete layer.prompt;
      }
      Object.assign(layer, args.changes);
      if (layer.type === 'text' && (args.changes.text || args.changes.fontSize || args.changes.width)) {
        layer.height = estimateTextHeight(layer);
      }
      if (args.z) moveLayer(scene, layer.id, args.z);
      ctx.emitScene(layer.name);
      const c = args.changes;
      return result({ ok: true, layerId: layer.id, height: layer.height }, paletteWarnings(kit, [c.fill, c.stroke, c.labelColor]));
    }

    case 'delete_layer': {
      const before = scene.layers.length;
      scene.layers = scene.layers.filter((l: Layer) => l.id !== args.layerId);
      if (scene.layers.length === before) return `Error: no layer ${args.layerId}.`;
      ctx.emitScene('Delete');
      return result({ ok: true });
    }

    case 'apply_layout': {
      const template = kit.templates?.find((t) => t.id === args.templateId);
      if (!template) return `Error: no template ${args.templateId}. Available: ${(kit.templates ?? []).map((t) => t.id).join(', ') || 'none'}.`;
      const built = buildFromTemplate(template, scene, kit, { texts: args.texts, imagePrompts: args.imagePrompts });
      const layers = built.layers.map(({ slotId, ...l }) => l as Layer);
      if (args.replace === false) scene.layers.push(...layers);
      else {
        scene.layers = layers;
        scene.background = built.background;
      }
      for (const g of built.toGenerate) {
        const layer = layers.find((l) => l.id === g.layerId);
        if (layer?.type === 'image') startImageGeneration(ctx, layer, g.prompt);
      }
      ctx.emitScene(template.name);
      const missing = template.slots.filter((s) => (s.kind === 'text' || s.kind === 'cta') && !args.texts?.[s.id]).map((s) => s.id);
      return JSON.stringify({
        ok: true,
        layers: layers.map((l) => ({ id: l.id, role: l.role, type: l.type, x: l.x, y: l.y, width: l.width, height: l.height, ...(l.type === 'text' ? { text: l.text } : {}) })),
        ...(missing.length ? { note: `Slots ${missing.join(', ')} kept the template example copy; update them with update_layer if needed.` } : {}),
      });
    }
  }
}
