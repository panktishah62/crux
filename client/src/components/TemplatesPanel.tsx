import { useEffect, useMemo, useState } from 'react';
import { LayoutTemplate as LayoutIcon, RefreshCw, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { FRAME_KEYS, type FrameKey, type LayoutTemplate, type Scene } from '../../../shared/types.ts';
import { buildFromTemplate, frameKeyFor } from '../../../shared/templates.ts';
import { useEditor } from '../store.ts';
import { api } from '../lib/api.ts';
import { ScenePreview } from '../canvas/ScenePreview.tsx';

const FRAME_DIMS: Record<FrameKey, [number, number]> = { '1:1': [1080, 1080], '4:5': [1080, 1350], '9:16': [1080, 1920] };

/** Layout archetypes extracted from reference ads: review, rename, delete, preview per ratio, and apply. */
export function TemplatesPanel() {
  const kit = useEditor((s) => s.kit);
  const setKit = useEditor((s) => s.setKit);
  const scene = useEditor((s) => s.scene);
  const [frame, setFrame] = useState<FrameKey>(frameKeyFor(scene.width, scene.height));
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templates = kit.templates ?? [];
  const hasRefs = kit.assets.some((a) => a.category === 'reference');

  useEffect(() => setFrame(frameKeyFor(scene.width, scene.height)), [scene.width, scene.height]);

  const extract = async () => {
    setExtracting(true);
    setError(null);
    try {
      setKit(await api.extractTemplates());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExtracting(false);
    }
  };

  const save = async (next: LayoutTemplate[]) => {
    setKit({ ...kit, templates: next });
    try {
      setKit(await api.saveTemplates(next));
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (!templates.length && !hasRefs) {
    return (
      <div className="templates-empty muted small">
        <LayoutIcon size={14} /> Upload reference ads to extract reusable layout templates.
      </div>
    );
  }

  return (
    <div className="templates">
      <div className="section-head">
        <h4 className="grow">Layout templates</h4>
        <div className="segmented tiny">
          {FRAME_KEYS.map((k) => (
            <button key={k} className={frame === k ? 'active' : ''} onClick={() => setFrame(k)}>
              {k}
            </button>
          ))}
        </div>
        <button className="icon-btn" title="Re-extract templates from reference ads" onClick={extract} disabled={extracting || !hasRefs}>
          <RefreshCw size={14} className={extracting ? 'spin' : ''} />
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {!templates.length && (
        <button className="btn full" onClick={extract} disabled={extracting}>
          {extracting ? 'Extracting layouts...' : 'Extract templates from references'}
        </button>
      )}
      {templates.map((t) => (
        <TemplateCard
          key={t.id}
          template={t}
          frame={frame}
          onChange={(next) => save(templates.map((x) => (x.id === t.id ? next : x)))}
          onDelete={() => save(templates.filter((x) => x.id !== t.id))}
        />
      ))}
    </div>
  );
}

function TemplateCard({ template, frame, onChange, onDelete }: { template: LayoutTemplate; frame: FrameKey; onChange: (t: LayoutTemplate) => void; onDelete: () => void }) {
  const kit = useEditor((s) => s.kit);
  const busy = useEditor((s) => s.busy);
  const sendMessage = useEditor((s) => s.sendMessage);
  const commit = useEditor((s) => s.commit);
  const select = useEditor((s) => s.select);
  const scene = useEditor((s) => s.scene);
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);

  useEffect(() => {
    setName(template.name);
    setDescription(template.description);
  }, [template.name, template.description]);

  const preview = useMemo<Scene>(() => {
    const [width, height] = FRAME_DIMS[frame];
    const built = buildFromTemplate(template, { width, height }, kit);
    return { id: template.id, format: frame, width, height, background: built.background, layers: built.layers };
  }, [template, frame, kit]);

  const applyNow = () => {
    const built = buildFromTemplate(template, scene, kit);
    commit({ ...scene, background: built.background, layers: built.layers.map(({ slotId, ...l }) => l) });
    select(null);
  };

  const commitText = () => {
    if (name !== template.name || description !== template.description) onChange({ ...template, name: name.trim() || template.name, description });
  };

  return (
    <div className="template-card">
      <div className="template-preview">
        <ScenePreview scene={preview} width={frame === '9:16' ? 90 : frame === '4:5' ? 128 : 160} />
      </div>
      <div className="template-body">
        <input className="input title" value={name} onChange={(e) => setName(e.target.value)} onBlur={commitText} />
        <textarea className="input small" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} onBlur={commitText} />
        <div className="muted tiny">
          {template.slots.length} slots · {template.slots.filter((s) => s.kind === 'text').map((s) => s.role).join(', ')}
        </div>
        <div className="row gap">
          <button
            className="btn primary small"
            disabled={busy}
            title="Copilot writes copy and generates photos for this layout"
            onClick={() => {
              select(null);
              sendMessage(`Create a new design using the "${template.name}" layout template (${template.id}).`);
            }}
          >
            <Sparkles size={12} /> Use
          </button>
          <button className="btn small" title="Apply the layout instantly with example copy" onClick={applyNow}>
            <Wand2 size={12} /> Apply
          </button>
          <button className="icon-btn ghost" title="Delete template" onClick={onDelete}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
