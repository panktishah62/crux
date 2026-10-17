import { nanoid } from 'nanoid';
import type { AgentEvent, BrandKit, BrandProfile, LayoutTemplate } from '../../../shared/types.ts';

const SESSION_KEY = 'crux-session-id';

export const sessionId: string = (() => {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = nanoid(16);
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
})();

const headers = (extra: Record<string, string> = {}) => ({ 'x-session-id': sessionId, ...extra });

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  getKit: () => fetch('/api/brand', { headers: headers() }).then((r) => json<BrandKit>(r)),

  uploadKit: (files: File[], asReferences = false) => {
    const form = new FormData();
    for (const f of files) form.append('files', f, (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
    form.append('asReferences', String(asReferences));
    return fetch('/api/brand/upload', { method: 'POST', headers: headers(), body: form }).then((r) => json<BrandKit>(r));
  },

  saveProfile: (profile: BrandProfile) =>
    fetch('/api/brand/profile', {
      method: 'PUT',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(profile),
    }).then((r) => json<BrandKit>(r)),

  updateAsset: (id: string, patch: { category?: string; description?: string }) =>
    fetch(`/api/brand/assets/${id}`, {
      method: 'PATCH',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(patch),
    }).then((r) => json<BrandKit>(r)),

  deleteAsset: (id: string) =>
    fetch(`/api/brand/assets/${id}`, { method: 'DELETE', headers: headers() }).then((r) => json<BrandKit>(r)),

  reextract: () => fetch('/api/brand/reextract', { method: 'POST', headers: headers() }).then((r) => json<BrandKit>(r)),

  resetKit: () => fetch('/api/brand', { method: 'DELETE', headers: headers() }).then((r) => json<BrandKit>(r)),

  extractTemplates: () =>
    fetch('/api/brand/templates/extract', { method: 'POST', headers: headers() }).then((r) => json<BrandKit>(r)),

  saveTemplates: (templates: LayoutTemplate[]) =>
    fetch('/api/brand/templates', {
      method: 'PUT',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(templates),
    }).then((r) => json<BrandKit>(r)),
};

/** POSTs and invokes onEvent for each NDJSON line of the streamed response. */
export async function streamEvents<E = AgentEvent>(
  url: string,
  body: BodyInit,
  onEvent: (e: E) => void,
  opts: { json?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(opts.json ? { 'Content-Type': 'application/json' } : {}),
    body,
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}
