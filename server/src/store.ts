import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import type { BrandKit } from '../../shared/types.ts';
import { GRID_CATEGORIES, colorGrid } from './brand/colors.ts';

/** One active brand kit per session, cached on disk so restarts keep the extracted profile. */

const kits = new Map<string, BrandKit>();

export function sessionDir(sessionId: string, ...parts: string[]): string {
  if (!/^[\w-]{4,64}$/.test(sessionId)) throw new Error('Invalid session id');
  const dir = path.join(config.dataDir, 'sessions', sessionId, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Public URL for a file stored under the data dir. */
export function fileUrl(absPath: string): string {
  return '/files/' + path.relative(config.dataDir, absPath).split(path.sep).map(encodeURIComponent).join('/');
}

/** Inverse of fileUrl, guarded against path traversal. */
export function urlToPath(url: string): string | null {
  if (!url.startsWith('/files/')) return null;
  const rel = decodeURIComponent(url.slice('/files/'.length));
  const abs = path.resolve(config.dataDir, rel);
  return abs.startsWith(config.dataDir) ? abs : null;
}

export function getKit(sessionId: string): BrandKit {
  let kit = kits.get(sessionId);
  if (kit) return kit;
  const file = path.join(sessionDir(sessionId), 'kit.json');
  kit = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as BrandKit)
    : { profile: null, assets: [], status: 'empty' };
  if (kit.status === 'ingesting') kit.status = kit.profile ? 'ready' : 'empty';
  kits.set(sessionId, kit);
  return kit;
}

/** getKit plus colour maps for templates and shapes that predate them (or were recategorised), so contrast checks see every region. */
export async function readyKit(sessionId: string): Promise<BrandKit> {
  const kit = getKit(sessionId);
  const missing = kit.assets.filter((a) => GRID_CATEGORIES.has(a.category) && !a.grid && (a.thumbUrl ?? a.url));
  if (!missing.length) return kit;
  let added = 0;
  await Promise.all(missing.map(async (a) => {
    const file = urlToPath(a.thumbUrl ?? a.url);
    if (!file || !fs.existsSync(file)) return;
    try {
      a.grid = await colorGrid(fs.readFileSync(file));
      added++;
    } catch (err) {
      console.warn('[kit] colour map failed for', a.filename, err);
    }
  }));
  if (added) saveKit(sessionId, kit);
  return kit;
}

export function saveKit(sessionId: string, kit: BrandKit): void {
  kits.set(sessionId, kit);
  const dir = sessionDir(sessionId);
  fs.writeFileSync(path.join(dir, 'kit.json'), JSON.stringify(kit, null, 2));
  if (kit.profile) fs.writeFileSync(path.join(dir, 'brand_profile.json'), JSON.stringify(kit.profile, null, 2));
}
