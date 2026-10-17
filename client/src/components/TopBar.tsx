import { Download, FlaskConical, LayoutGrid, PenTool, Redo2, Sparkles, Undo2 } from 'lucide-react';
import { FORMAT_PRESETS } from '../../../shared/types.ts';
import { useEditor } from '../store.ts';
import { exportPng } from '../canvas/CanvasEditor.tsx';
import { BrandCheck } from './BrandCheck.tsx';

export function TopBar() {
  const { scene, past, future, undo, redo, newDesign, variants, testLab, view, setView, kit } = useEditor();

  const onFormat = (id: string) => {
    if (id === scene.format && !scene.layers.length) return;
    if (scene.layers.length && !confirm('Start a new blank design in this format? (You can undo.)')) return;
    newDesign(id);
  };

  const onExport = () => {
    const url = exportPng();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${kit.profile?.name ?? 'design'}-${scene.format}-${scene.width}x${scene.height}.png`.replace(/\s+/g, '-').toLowerCase();
    a.click();
  };

  return (
    <header className="topbar">
      <div className="brand-mark">
        <Sparkles size={18} />
        <span>Crux</span>
        <span className="muted">Agentic Image Editor</span>
      </div>

      <div className="topbar-center">
        <select className="select" value={scene.format} onChange={(e) => onFormat(e.target.value)} title="Format">
          {FORMAT_PRESETS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label} · {f.width}×{f.height}
            </option>
          ))}
        </select>
        <button className="icon-btn" onClick={undo} disabled={!past.length} title="Undo (⌘Z)">
          <Undo2 size={16} />
        </button>
        <button className="icon-btn" onClick={redo} disabled={!future.length} title="Redo (⇧⌘Z)">
          <Redo2 size={16} />
        </button>
        {(variants || testLab) && (
          <div className="segmented">
            <button className={view === 'editor' ? 'active' : ''} onClick={() => setView('editor')}>
              <PenTool size={14} /> Editor
            </button>
            {variants && (
              <button className={view === 'variants' ? 'active' : ''} onClick={() => setView('variants')}>
                <LayoutGrid size={14} /> Variants
              </button>
            )}
            {testLab && (
              <button className={view === 'testlab' ? 'active' : ''} onClick={() => setView('testlab')}>
                <FlaskConical size={14} /> Strategist
              </button>
            )}
          </div>
        )}
      </div>

      <div className="topbar-right">
        {view === 'editor' && <BrandCheck />}
        <button className="btn primary" onClick={onExport} disabled={view !== 'editor'}>
          <Download size={15} /> Export PNG
        </button>
      </div>
    </header>
  );
}
