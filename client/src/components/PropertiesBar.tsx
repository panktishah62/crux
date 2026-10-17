import { useEffect, useState } from 'react';
import { nanoid } from 'nanoid';
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronUp, Copy, Square, Trash2, Type, CaseUpper, FlaskConical,
} from 'lucide-react';
import type { Layer, ShapeLayer, TextLayer } from '../../../shared/types.ts';
import { useEditor } from '../store.ts';
import { canRunTestLab, runTestLab } from '../testlab.ts';

export function PropertiesBar() {
  const { scene, selectedId, updateLayer, deleteLayer, moveLayer, duplicateLayer } = useEditor();
  const layer = scene.layers.find((l) => l.id === selectedId);

  if (!layer) return <AddBar />;
  const patch = (p: Partial<Layer>) => updateLayer(layer.id, p);

  return (
    <div className="props-bar">
      <span className="props-title">{layer.name}</span>
      {layer.type === 'text' && <TextProps layer={layer} patch={patch} />}
      {layer.type === 'shape' && <ShapeProps layer={layer} patch={patch} />}
      {layer.type === 'image' && (
        <div className="segmented small">
          {(['cover', 'contain'] as const).map((f) => (
            <button key={f} className={(layer.fit ?? 'cover') === f ? 'active' : ''} onClick={() => patch({ fit: f })}>
              {f}
            </button>
          ))}
        </div>
      )}
      <NumberField label="Opacity" value={Math.round((layer.opacity ?? 1) * 100)} min={0} max={100} onCommit={(v) => patch({ opacity: v / 100 })} />
      <div className="divider" />
      <button className="icon-btn" title="Bring to front" onClick={() => moveLayer(layer.id, 'front')}><ArrowUpToLine size={15} /></button>
      <button className="icon-btn" title="Bring forward" onClick={() => moveLayer(layer.id, 'forward')}><ChevronUp size={15} /></button>
      <button className="icon-btn" title="Send backward" onClick={() => moveLayer(layer.id, 'backward')}><ChevronDown size={15} /></button>
      <button className="icon-btn" title="Send to back" onClick={() => moveLayer(layer.id, 'back')}><ArrowDownToLine size={15} /></button>
      <button className="icon-btn" title="Duplicate" onClick={() => duplicateLayer(layer.id)}><Copy size={15} /></button>
      <button className="icon-btn danger" title="Delete (⌫)" onClick={() => deleteLayer(layer.id)}><Trash2 size={15} /></button>
    </div>
  );
}

function AddBar() {
  const { scene, kit, addLayer, select, busy } = useEditor();
  const layered = canRunTestLab(scene);
  const palette = kit.profile?.palette ?? [];
  const dark = palette.find((c) => /primary|text/i.test(c.role ?? ''))?.hex ?? '#111111';

  const addText = () => {
    const w = Math.round(scene.width * 0.7);
    const fontSize = Math.round(scene.width * 0.08);
    const layer: TextLayer = {
      id: `txt_${nanoid(5)}`, type: 'text', name: 'Headline', role: 'headline', text: 'Your headline',
      x: Math.round((scene.width - w) / 2), y: Math.round(scene.height * 0.4), width: w, height: fontSize * 1.2,
      fontSize, fontFamily: kit.profile?.fonts.headline.family ?? 'Anton', fontWeight: kit.profile?.fonts.headline.weight ?? 800,
      fill: dark, align: 'center', lineHeight: 1.05,
    };
    addLayer(layer);
    select(layer.id);
  };

  const addRect = () => {
    const w = Math.round(scene.width * 0.4);
    const h = Math.round(scene.width * 0.08);
    const layer: ShapeLayer = {
      id: `shp_${nanoid(5)}`, type: 'shape', name: 'Button', role: 'cta', shape: 'rect',
      x: Math.round((scene.width - w) / 2), y: Math.round(scene.height * 0.6), width: w, height: h,
      fill: dark, cornerRadius: h / 2, label: 'Shop now', labelColor: '#FFFFFF',
      labelFontFamily: kit.profile?.fonts.body.family ?? 'Inter', labelFontSize: Math.round(h * 0.38), labelFontWeight: 700,
    };
    addLayer(layer);
    select(layer.id);
  };

  return (
    <div className="props-bar">
      <span className="muted small">Select a layer to edit it, or add:</span>
      <button className="btn ghost" onClick={addText}><Type size={14} /> Text</button>
      <button className="btn ghost" onClick={addRect}><Square size={14} /> Button</button>
      <span className="grow" />
      <button
        className="btn primary"
        disabled={busy || !layered}
        onClick={() => runTestLab()}
        title={layered ? 'Have our Creative Strategist score this design, then build and rank 4 single-change experiments' : 'Creative Strategist needs a layered design'}
      >
        <FlaskConical size={14} /> Creative Strategist
      </button>
    </div>
  );
}

function TextProps({ layer, patch }: { layer: TextLayer; patch: (p: Partial<TextLayer>) => void }) {
  const kit = useEditor((s) => s.kit);
  const fonts = [...new Set([kit.profile?.fonts.headline.family, kit.profile?.fonts.body.family, layer.fontFamily, 'Inter', 'Anton'].filter(Boolean))] as string[];
  return (
    <>
      <TextField value={layer.text} onCommit={(text) => patch({ text })} />
      <select className="select small" value={layer.fontFamily} onChange={(e) => patch({ fontFamily: e.target.value })}>
        {fonts.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>
      <NumberField label="Size" value={layer.fontSize} min={6} max={600} onCommit={(fontSize) => patch({ fontSize })} />
      <select className="select small" value={layer.fontWeight ?? 400} onChange={(e) => patch({ fontWeight: Number(e.target.value) })}>
        {[300, 400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
      </select>
      <ColorPicker value={layer.fill} onChange={(fill) => patch({ fill })} />
      <div className="segmented small">
        {(['left', 'center', 'right'] as const).map((a) => (
          <button key={a} className={(layer.align ?? 'left') === a ? 'active' : ''} onClick={() => patch({ align: a })}>
            {a === 'left' ? <AlignLeft size={14} /> : a === 'center' ? <AlignCenter size={14} /> : <AlignRight size={14} />}
          </button>
        ))}
      </div>
      <button className={`icon-btn ${layer.uppercase ? 'on' : ''}`} title="Uppercase" onClick={() => patch({ uppercase: !layer.uppercase })}>
        <CaseUpper size={15} />
      </button>
    </>
  );
}

function ShapeProps({ layer, patch }: { layer: ShapeLayer; patch: (p: Partial<ShapeLayer>) => void }) {
  return (
    <>
      <ColorPicker value={layer.fill} onChange={(fill) => patch({ fill })} />
      {layer.shape === 'rect' && <NumberField label="Radius" value={layer.cornerRadius ?? 0} min={0} max={2000} onCommit={(cornerRadius) => patch({ cornerRadius })} />}
      {layer.label !== undefined && (
        <>
          <TextField value={layer.label} onCommit={(label) => patch({ label })} />
          <ColorPicker value={layer.labelColor ?? '#FFFFFF'} onChange={(labelColor) => patch({ labelColor })} />
        </>
      )}
    </>
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const palette = useEditor((s) => s.kit.profile?.palette ?? []);
  const [open, setOpen] = useState(false);
  return (
    <div className="color-picker">
      <button className="swatch-btn" style={{ background: value }} onClick={() => setOpen(!open)} title={value} />
      {open && (
        <div className="color-pop" onMouseLeave={() => setOpen(false)}>
          <div className="muted tiny">Brand palette</div>
          <div className="row gap-sm wrap">
            {palette.map((c) => (
              <button
                key={c.hex}
                className={`swatch-btn ${value.toUpperCase() === c.hex.toUpperCase() ? 'active' : ''}`}
                style={{ background: c.hex }}
                title={`${c.name} ${c.hex}`}
                onClick={() => {
                  onChange(c.hex);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <label className="row gap-sm custom-color">
            <span className="muted tiny">Custom</span>
            <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
          </label>
        </div>
      )}
    </div>
  );
}

function NumberField({ label, value, min, max, onCommit }: { label: string; value: number; min: number; max: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(Math.round(value)));
  }, [value]);
  const commit = () => {
    const n = Math.min(max, Math.max(min, Number(draft)));
    if (!Number.isNaN(n) && n !== value) onCommit(n);
    else setDraft(String(Math.round(value)));
  };
  return (
    <label className="num-field">
      <span className="muted tiny">{label}</span>
      <input className="input num" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  );
}

function TextField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <input
      className="input text-field"
      value={draft.replace(/\n/g, '⏎')}
      onChange={(e) => setDraft(e.target.value.replace(/⏎/g, '\n'))}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}
