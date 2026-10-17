import { useEffect, useRef, useState } from 'react';
import { FolderUp, Loader2, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import type { BrandProfile } from '../../../shared/types.ts';
import { useEditor } from '../store.ts';
import { api } from '../lib/api.ts';
import { TemplatesPanel } from './TemplatesPanel.tsx';

export function BrandPanel() {
  const kit = useEditor((s) => s.kit);
  const setKit = useEditor((s) => s.setKit);
  const refreshKit = useEditor((s) => s.refreshKit);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const refRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (kit.status !== 'ingesting') return;
    const t = setInterval(() => refreshKit().catch(() => undefined), 1000);
    return () => clearInterval(t);
  }, [kit.status, refreshKit]);

  const upload = async (files: File[], asReferences = false) => {
    if (!files.length) return;
    setError(null);
    try {
      setKit(await api.uploadKit(files, asReferences));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = await filesFromDrop(e.dataTransfer);
    upload(files);
  };

  const ingesting = kit.status === 'ingesting';

  return (
    <div className="panel-scroll">
      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {ingesting ? (
          <div className="ingest-progress">
            <Loader2 className="spin" size={20} />
            <div>{kit.progress ?? 'Working...'}</div>
          </div>
        ) : (
          <>
            <Upload size={20} />
            <div className="dz-title">{kit.assets.length ? 'Add more brand files' : 'Upload your brand kit'}</div>
            <div className="muted small">Drop a folder or zip of logos, shapes, icons, photos, guideline PDFs and fonts</div>
            <div className="row gap">
              <button className="btn" onClick={() => fileRef.current?.click()}>
                <Upload size={14} /> Files / zip
              </button>
              <button className="btn" onClick={() => folderRef.current?.click()}>
                <FolderUp size={14} /> Folder
              </button>
            </div>
            <button className="link-btn" onClick={() => refRef.current?.click()}>
              + Upload reference ads
            </button>
          </>
        )}
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => upload([...(e.target.files ?? [])])} />
        <input
          ref={folderRef}
          type="file"
          hidden
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => upload([...(e.target.files ?? [])])}
        />
        <input ref={refRef} type="file" multiple accept="image/*" hidden onChange={(e) => upload([...(e.target.files ?? [])], true)} />
      </div>
      {error && <div className="error-box">{error}</div>}
      {!ingesting && kit.progress && kit.status !== 'empty' && <div className="muted small center">{kit.progress}</div>}

      {kit.profile && <TemplatesPanel />}
      {kit.profile && <ProfileEditor profile={kit.profile} />}
    </div>
  );
}

function ProfileEditor({ profile }: { profile: BrandProfile }) {
  const setKit = useEditor((s) => s.setKit);
  const assets = useEditor((s) => s.kit.assets);
  const [draft, setDraft] = useState(profile);
  const [saving, setSaving] = useState(false);
  const [reextracting, setReextracting] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(profile);

  useEffect(() => {
    setDraft(profile);
  }, [profile]);

  const save = async () => {
    setSaving(true);
    try {
      setKit(await api.saveProfile(draft));
    } finally {
      setSaving(false);
    }
  };

  const reextract = async () => {
    setReextracting(true);
    try {
      setKit(await api.reextract());
    } finally {
      setReextracting(false);
    }
  };

  const reset = async () => {
    if (!confirm('Remove the brand kit and all its assets from this session?')) return;
    setKit(await api.resetKit());
  };

  const set = <K extends keyof BrandProfile>(key: K, value: BrandProfile[K]) => setDraft({ ...draft, [key]: value });

  return (
    <div className="profile">
      <div className="section-head">
        <input className="title-input" value={draft.name} onChange={(e) => set('name', e.target.value)} />
        <button className="icon-btn" title="Re-extract profile from kit" onClick={reextract} disabled={reextracting}>
          <RefreshCw size={14} className={reextracting ? 'spin' : ''} />
        </button>
        <button className="icon-btn" title="Remove brand kit" onClick={reset}>
          <Trash2 size={14} />
        </button>
      </div>

      <h4>Palette</h4>
      <div className="palette-list">
        {draft.palette.map((c, i) => (
          <div className="palette-row" key={i}>
            <label className="swatch" style={{ background: c.hex }}>
              <input
                type="color"
                value={c.hex}
                onChange={(e) => set('palette', draft.palette.map((p, j) => (j === i ? { ...p, hex: e.target.value.toUpperCase() } : p)))}
              />
            </label>
            <input className="input grow" value={c.name} onChange={(e) => set('palette', draft.palette.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))} />
            <input
              className="input mono hex"
              value={c.hex}
              onChange={(e) => set('palette', draft.palette.map((p, j) => (j === i ? { ...p, hex: e.target.value } : p)))}
            />
            <button className="icon-btn ghost" onClick={() => set('palette', draft.palette.filter((_, j) => j !== i))}>
              <X size={13} />
            </button>
          </div>
        ))}
        <button className="link-btn" onClick={() => set('palette', [...draft.palette, { name: 'New colour', hex: '#888888' }])}>
          <Plus size={12} /> Add colour
        </button>
      </div>

      <h4>Fonts</h4>
      {(['headline', 'body'] as const).map((k) => (
        <div className="font-row" key={k}>
          <span className="muted small cap">{k}</span>
          <input
            className="input grow"
            style={{ fontFamily: `"${draft.fonts[k].family}"`, fontWeight: draft.fonts[k].weight }}
            value={draft.fonts[k].family}
            onChange={(e) => set('fonts', { ...draft.fonts, [k]: { ...draft.fonts[k], family: e.target.value } })}
          />
          <input
            className="input num"
            type="number"
            step={100}
            min={100}
            max={900}
            value={draft.fonts[k].weight ?? 400}
            onChange={(e) => set('fonts', { ...draft.fonts, [k]: { ...draft.fonts[k], weight: Number(e.target.value) } })}
          />
        </div>
      ))}
      {draft.fonts.headline.note && <div className="muted small">{draft.fonts.headline.note}</div>}

      {draft.logos.length > 0 && (
        <>
          <h4>Logos</h4>
          <div className="logo-list">
            {draft.logos.map((l, i) => {
              const asset = assets.find((a) => a.id === l.assetId);
              return (
                <div className="logo-row" key={l.assetId}>
                  <div className="logo-thumb">{asset && <img src={asset.thumbUrl ?? asset.url} alt="" />}</div>
                  <div className="grow col">
                    <input className="input" value={l.variant} onChange={(e) => set('logos', draft.logos.map((x, j) => (j === i ? { ...x, variant: e.target.value } : x)))} />
                    <input className="input small" value={l.useOn} onChange={(e) => set('logos', draft.logos.map((x, j) => (j === i ? { ...x, useOn: e.target.value } : x)))} />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <h4>Rules</h4>
      <textarea
        className="input rules"
        rows={Math.max(4, draft.rules.length + 1)}
        value={draft.rules.join('\n')}
        onChange={(e) => set('rules', e.target.value.split('\n'))}
      />
      <h4>Tone</h4>
      <textarea className="input" rows={2} value={draft.tone ?? ''} onChange={(e) => set('tone', e.target.value)} />

      <div className="sticky-save">
        <button
          className="btn primary full"
          disabled={!dirty || saving}
          onClick={() => {
            set('rules', draft.rules.filter((r) => r.trim()));
            save();
          }}
        >
          {saving ? 'Saving...' : dirty ? 'Save brand profile' : 'Profile saved'}
        </button>
      </div>
    </div>
  );
}

/** Walks dropped folders so the upload keeps relative paths (folder names are classification hints). */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...dt.files];
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push(new File([file], `${prefix}${file.name}`, { type: file.type }));
      Object.defineProperty(out[out.length - 1], 'webkitRelativePath', { value: `${prefix}${file.name}` });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}
