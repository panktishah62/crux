import { nanoid } from 'nanoid';
import type { Layer, Scene } from '../../../shared/types.ts';

export { estimateTextHeight } from '../../../shared/text.ts';

export const newLayerId = (prefix: string) => `${prefix}_${nanoid(5)}`;

export function findLayer(scene: Scene, id: string): Layer | undefined {
  return scene.layers.find((l) => l.id === id);
}

export function moveLayer(scene: Scene, id: string, z: 'front' | 'back' | 'forward' | 'backward'): void {
  const i = scene.layers.findIndex((l) => l.id === id);
  if (i < 0) return;
  const [layer] = scene.layers.splice(i, 1);
  const target = z === 'front' ? scene.layers.length : z === 'back' ? 0 : z === 'forward' ? Math.min(i + 1, scene.layers.length) : Math.max(i - 1, 0);
  scene.layers.splice(target, 0, layer);
}

/** Compact, token-cheap view of the scene for the planner. */
export function describeScene(scene: Scene): string {
  const r = (n: number) => Math.round(n);
  const layers = scene.layers.map((l, z) => {
    const base: Record<string, unknown> = { id: l.id, z, type: l.type, name: l.name, role: l.role, x: r(l.x), y: r(l.y), w: r(l.width), h: r(l.height) };
    if (l.rotation) base.rotation = l.rotation;
    if (l.opacity !== undefined && l.opacity !== 1) base.opacity = l.opacity;
    if (l.type === 'text') Object.assign(base, { text: l.text, fontFamily: l.fontFamily, fontSize: l.fontSize, fontWeight: l.fontWeight, fill: l.fill, align: l.align });
    if (l.type === 'shape') Object.assign(base, { shape: l.shape, fill: l.fill, cornerRadius: l.cornerRadius, label: l.label, labelColor: l.labelColor });
    if (l.type === 'image') Object.assign(base, { assetId: l.assetId, prompt: l.prompt, fit: l.fit });
    return base;
  });
  return JSON.stringify({ width: scene.width, height: scene.height, background: scene.background, layers });
}
