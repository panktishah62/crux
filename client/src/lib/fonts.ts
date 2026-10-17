import { cache } from 'fabric';
import type { BrandProfile, Scene } from '../../../shared/types.ts';

const SYSTEM = new Set(['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'sans-serif', 'serif']);
const requested = new Map<string, Promise<void>>();
const uploaded = new Map<string, string>();

/** Registers brand fonts that came from uploaded files so ensureFonts uses them instead of Google Fonts. */
export function registerBrandFonts(profile: BrandProfile | null | undefined) {
  if (!profile) return;
  for (const f of [profile.fonts.headline, profile.fonts.body]) {
    if (f?.source === 'upload' && f.url) uploaded.set(f.family, f.url);
  }
  for (const f of [profile.fonts.headline, profile.fonts.body]) {
    if (f?.family) loadFamily(f.family, [f.weight ?? 400, 700]);
  }
}

function loadFamily(family: string, weights: number[]): Promise<void> {
  const key = `${family}|${weights.join(',')}`;
  const existing = requested.get(key);
  if (existing) return existing;

  const p = (async () => {
    const url = uploaded.get(family);
    if (url) {
      const face = new FontFace(family, `url(${url})`);
      document.fonts.add(await face.load());
    } else {
      // One stylesheet per weight: css2 rejects the whole request if any listed weight is missing.
      await Promise.all([400, ...weights].map((w) => addStylesheet(family, w)));
    }
    await Promise.all([400, ...weights].map((w) => document.fonts.load(`${w} 48px "${family}"`).catch(() => undefined)));
    cache.clearFontCache(family);
  })();

  const withTimeout = Promise.race([p, new Promise<void>((r) => setTimeout(r, 4000))]);
  requested.set(key, withTimeout);
  return withTimeout;
}

const stylesheets = new Map<string, Promise<void>>();

/** Resolves once the stylesheet is parsed, so document.fonts.load can see its @font-face rules. */
function addStylesheet(family: string, weight: number): Promise<void> {
  const id = `gf-${family}-${weight}`.replace(/\s+/g, '-');
  let p = stylesheets.get(id);
  if (!p) {
    p = new Promise<void>((resolve) => {
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}${weight === 400 ? '' : `:wght@${weight}`}&display=block`;
      link.onload = () => resolve();
      link.onerror = () => resolve();
      document.head.appendChild(link);
    });
    stylesheets.set(id, p);
  }
  return p;
}

export async function ensureSceneFonts(scene: Scene): Promise<void> {
  const byFamily = new Map<string, Set<number>>();
  const add = (family: string | undefined, weight: number | undefined) => {
    if (!family || SYSTEM.has(family)) return;
    const set = byFamily.get(family) ?? new Set<number>();
    set.add(weight ?? 400);
    byFamily.set(family, set);
  };
  for (const l of scene.layers) {
    if (l.type === 'text') add(l.fontFamily, l.fontWeight);
    if (l.type === 'shape' && l.label) add(l.labelFontFamily, l.labelFontWeight);
  }
  await Promise.all([...byFamily].map(([family, weights]) => loadFamily(family, [...weights].sort())));
}
