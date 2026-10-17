import { Ellipse, FabricImage, FabricText, Group, Rect, StaticCanvas, Textbox, type FabricObject } from 'fabric';
import type { ImageLayer, Layer, Scene, ShapeLayer, TextLayer } from '../../../shared/types.ts';
import { ensureSceneFonts } from '../lib/fonts.ts';

/** Fabric objects carry the id of the layer they render plus a signature of the layer JSON. */
export type LayerObject = FabricObject & { layerId?: string; signature?: string };

const ORIGIN = { originX: 'left', originY: 'top' } as const;
const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imageCache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        imageCache.delete(src);
        reject(new Error(`Failed to load ${src}`));
      };
      img.src = src;
    });
    imageCache.set(src, p);
  }
  return p;
}

function common(l: Layer) {
  return { ...ORIGIN, left: l.x, top: l.y, angle: l.rotation ?? 0, opacity: l.opacity ?? 1 };
}

function makeText(l: TextLayer): FabricObject {
  return new Textbox(l.uppercase ? l.text.toUpperCase() : l.text, {
    ...common(l),
    width: l.width,
    fontSize: l.fontSize,
    fontFamily: `"${l.fontFamily}"`,
    fontWeight: l.fontWeight ?? 400,
    fontStyle: l.fontStyle ?? 'normal',
    fill: l.fill,
    textAlign: l.align ?? 'left',
    lineHeight: l.lineHeight ?? 1.15,
    charSpacing: l.letterSpacing ?? 0,
    splitByGrapheme: false,
  });
}

function makeShape(l: ShapeLayer): FabricObject {
  const base = {
    fill: l.fill,
    stroke: l.stroke,
    strokeWidth: l.stroke ? l.strokeWidth ?? 2 : 0,
    strokeUniform: true,
  };
  const body =
    l.shape === 'ellipse'
      ? new Ellipse({ ...ORIGIN, left: 0, top: 0, rx: l.width / 2, ry: l.height / 2, ...base })
      : new Rect({ ...ORIGIN, left: 0, top: 0, width: l.width, height: l.height, rx: l.cornerRadius ?? 0, ry: l.cornerRadius ?? 0, ...base });

  if (!l.label) {
    body.set(common(l));
    return body;
  }
  const label = new FabricText(l.label, {
    originX: 'center',
    originY: 'center',
    left: l.width / 2,
    top: l.height / 2,
    fontSize: l.labelFontSize ?? Math.round(l.height * 0.38),
    fontFamily: `"${l.labelFontFamily ?? 'Inter'}"`,
    fontWeight: l.labelFontWeight ?? 700,
    fill: l.labelColor ?? '#FFFFFF',
  });
  const group = new Group([body, label], { ...ORIGIN, subTargetCheck: false, interactive: false });
  group.set(common(l));
  return group;
}

function makePlaceholder(l: ImageLayer, text: string): FabricObject {
  const rect = new Rect({ ...ORIGIN, left: 0, top: 0, width: l.width, height: l.height, fill: '#E8E6F0', rx: l.cornerRadius ?? 0, ry: l.cornerRadius ?? 0 });
  const label = new FabricText(text, {
    originX: 'center', originY: 'center', left: l.width / 2, top: l.height / 2,
    fontSize: Math.max(14, Math.min(l.width, l.height) * 0.06), fontFamily: 'Inter', fill: '#7C7891',
  });
  const group = new Group([rect, label], { ...ORIGIN, interactive: false });
  group.set(common(l));
  return group;
}

function makeImage(l: ImageLayer, el: HTMLImageElement): FabricObject {
  const img = new FabricImage(el, { ...ORIGIN });
  const iw = el.naturalWidth || l.width;
  const ih = el.naturalHeight || l.height;
  const W = l.width, H = l.height;
  if ((l.fit ?? 'cover') === 'cover') {
    const s = Math.max(W / iw, H / ih);
    const cw = W / s, ch = H / s;
    img.set({ cropX: (iw - cw) / 2, cropY: (ih - ch) / 2, width: cw, height: ch, scaleX: s, scaleY: s, left: l.x, top: l.y });
  } else {
    const s = Math.min(W / iw, H / ih);
    img.set({ cropX: 0, cropY: 0, width: iw, height: ih, scaleX: s, scaleY: s, left: l.x + (W - iw * s) / 2, top: l.y + (H - ih * s) / 2 });
  }
  img.set({ angle: l.rotation ?? 0, opacity: l.opacity ?? 1 });
  if (l.cornerRadius) {
    const s = img.scaleX;
    img.clipPath = new Rect({
      originX: 'center', originY: 'center', left: 0, top: 0,
      width: img.width, height: img.height, rx: l.cornerRadius / s, ry: l.cornerRadius / s,
    });
  }
  return img;
}

async function makeObject(l: Layer): Promise<FabricObject> {
  if (l.type === 'text') return makeText(l);
  if (l.type === 'shape') return makeShape(l);
  if (l.pending) return makePlaceholder(l, 'Generating image…');
  if (!l.src) return makePlaceholder(l, 'Image slot');
  try {
    return makeImage(l, await loadImage(l.src));
  } catch {
    return makePlaceholder(l, 'Image failed to load');
  }
}

const renderTokens = new WeakMap<StaticCanvas, number>();

/**
 * Reconciles the canvas with the scene: unchanged layers keep their objects, changed layers are rebuilt.
 * Returns rendered text heights so the store can report exact geometry to the agent.
 */
export async function syncScene(
  canvas: StaticCanvas,
  scene: Scene,
  opts: { interactive?: boolean; selectedId?: string | null } = {},
): Promise<Record<string, number> | null> {
  const token = (renderTokens.get(canvas) ?? 0) + 1;
  renderTokens.set(canvas, token);

  await ensureSceneFonts(scene);
  const existing = new Map((canvas.getObjects() as LayerObject[]).map((o) => [o.layerId, o]));
  const built = await Promise.all(
    scene.layers.map(async (l) => {
      const signature = JSON.stringify(l);
      const current = existing.get(l.id);
      if (current && current.signature === signature) return current;
      const obj = (await makeObject(l)) as LayerObject;
      obj.layerId = l.id;
      obj.signature = signature;
      return obj;
    }),
  );
  if (renderTokens.get(canvas) !== token) return null;

  canvas.backgroundColor = scene.background;
  const keep = new Set(built);
  for (const obj of canvas.getObjects()) if (!keep.has(obj as LayerObject)) canvas.remove(obj);

  const heights: Record<string, number> = {};
  built.forEach((obj, i) => {
    const layer = scene.layers[i];
    const interactive = !!opts.interactive && !layer.locked;
    obj.set({ selectable: interactive, evented: interactive, hoverCursor: interactive ? 'move' : 'default' });
    if (!canvas.getObjects().includes(obj)) canvas.add(obj);
    canvas.moveObjectTo(obj, i);
    if (layer.type === 'text') heights[layer.id] = Math.round(obj.height);
  });

  if (opts.interactive && 'setActiveObject' in canvas) {
    const c = canvas as unknown as import('fabric').Canvas;
    const target = built.find((o) => o.layerId === opts.selectedId);
    if (target && c.getActiveObject() !== target) c.setActiveObject(target);
    if (!target && c.getActiveObject()) c.discardActiveObject();
  }
  canvas.requestRenderAll();
  return heights;
}

/** Converts a user-modified Fabric object back into a layer patch (scale folded into width/height/fontSize). */
export function patchFromObject(obj: LayerObject, layer: Layer): Partial<Layer> {
  const sx = obj.scaleX ?? 1, sy = obj.scaleY ?? 1;
  const base = { x: Math.round(obj.left), y: Math.round(obj.top), rotation: Math.round(obj.angle ?? 0) };
  if (layer.type === 'text') {
    const tb = obj as unknown as Textbox;
    const scaled = Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001;
    return {
      ...base,
      width: Math.round(tb.width * sx),
      height: Math.round(tb.height * sy),
      fontSize: scaled ? Math.round(layer.fontSize * sy) : layer.fontSize,
      text: layer.uppercase && tb.text === layer.text.toUpperCase() ? layer.text : tb.text,
    };
  }
  return { ...base, width: Math.round(obj.width * sx), height: Math.round(obj.height * sy) };
}

/** Exact rendered height of a text layer (fonts must already be loaded, see ensureSceneFonts). */
export function measureTextHeight(l: TextLayer): number {
  return Math.round((makeText(l) as Textbox).height);
}

/** Renders a scene offscreen to a PNG data URL (used for self-review of any scene, including variants). */
export async function renderScenePng(scene: Scene, maxSide = 1024): Promise<string> {
  const el = document.createElement('canvas');
  const zoom = Math.min(1, maxSide / Math.max(scene.width, scene.height));
  const canvas = new StaticCanvas(el, { enableRetinaScaling: false, renderOnAddRemove: false });
  try {
    canvas.setDimensions({ width: Math.round(scene.width * zoom), height: Math.round(scene.height * zoom) });
    canvas.setZoom(zoom);
    await syncScene(canvas, scene);
    canvas.renderAll();
    return canvas.toDataURL({ format: 'png', multiplier: 1 });
  } finally {
    canvas.dispose();
  }
}
