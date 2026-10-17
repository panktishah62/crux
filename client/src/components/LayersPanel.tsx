import { Image, Lock, Square, Trash2, Type, Unlock } from 'lucide-react';
import { useEditor } from '../store.ts';

export function LayersPanel() {
  const { scene, selectedId, select, updateLayer, deleteLayer } = useEditor();
  const layers = [...scene.layers].reverse();

  if (!layers.length) return <div className="empty-panel">No layers yet. Ask the copilot to create a design, or add assets.</div>;

  return (
    <div className="panel-scroll">
      <div className="layer-list">
        {layers.map((l) => (
          <div key={l.id} className={`layer-row ${l.id === selectedId ? 'selected' : ''}`} onClick={() => select(l.id)}>
            <span className="layer-icon">
              {l.type === 'text' ? <Type size={13} /> : l.type === 'image' ? <Image size={13} /> : <Square size={13} />}
            </span>
            <div className="grow col tight">
              <span className="layer-name">{l.type === 'text' ? l.text.replace(/\n/g, ' ') : l.name}</span>
              <span className="muted tiny">
                {l.role ?? l.type}
                {l.type === 'image' && l.pending ? ' · generating…' : ''}
              </span>
            </div>
            <button
              className="icon-btn ghost"
              title={l.locked ? 'Unlock' : 'Lock'}
              onClick={(e) => {
                e.stopPropagation();
                updateLayer(l.id, { locked: !l.locked });
              }}
            >
              {l.locked ? <Lock size={12} /> : <Unlock size={12} />}
            </button>
            <button
              className="icon-btn ghost"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                deleteLayer(l.id);
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="bg-row">
        <span className="muted small">Canvas background</span>
        <BackgroundPicker />
      </div>
    </div>
  );
}

function BackgroundPicker() {
  const { scene, setBackground, kit } = useEditor();
  return (
    <div className="row gap-sm wrap">
      {(kit.profile?.palette ?? []).map((c) => (
        <button
          key={c.hex}
          className={`swatch-btn ${scene.background.toUpperCase() === c.hex.toUpperCase() ? 'active' : ''}`}
          style={{ background: c.hex }}
          title={c.name}
          onClick={() => setBackground(c.hex)}
        />
      ))}
      <label className="swatch-btn custom" style={{ background: scene.background }}>
        <input type="color" value={scene.background} onChange={(e) => setBackground(e.target.value.toUpperCase())} />
      </label>
    </div>
  );
}
