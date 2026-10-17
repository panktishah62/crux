import { useEffect, useState } from 'react';
import { Layers, Library, Palette } from 'lucide-react';
import { useEditor } from './store.ts';
import { TopBar } from './components/TopBar.tsx';
import { BrandPanel } from './components/BrandPanel.tsx';
import { AssetLibrary } from './components/AssetLibrary.tsx';
import { LayersPanel } from './components/LayersPanel.tsx';
import { PropertiesBar } from './components/PropertiesBar.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';
import { VariantsGrid } from './components/VariantsGrid.tsx';
import { TestLabView } from './components/TestLabView.tsx';
import { CanvasEditor } from './canvas/CanvasEditor.tsx';

type Tab = 'brand' | 'assets' | 'layers';

export function App() {
  const [tab, setTab] = useState<Tab>('brand');
  const view = useEditor((s) => s.view);
  const kit = useEditor((s) => s.kit);
  const refreshKit = useEditor((s) => s.refreshKit);

  useEffect(() => {
    refreshKit().catch(() => undefined);
  }, [refreshKit]);

  useKeyboardShortcuts();

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        {view === 'testlab' ? <TestLabView /> : (
        <>
        <aside className="sidebar">
          <nav className="tabs">
            <TabButton active={tab === 'brand'} onClick={() => setTab('brand')} icon={<Palette size={15} />} label="Brand" />
            <TabButton
              active={tab === 'assets'}
              onClick={() => setTab('assets')}
              icon={<Library size={15} />}
              label={`Assets${kit.assets.length ? ` ${kit.assets.filter((a) => a.category !== 'font').length}` : ''}`}
            />
            <TabButton active={tab === 'layers'} onClick={() => setTab('layers')} icon={<Layers size={15} />} label="Layers" />
          </nav>
          {tab === 'brand' && <BrandPanel />}
          {tab === 'assets' && <AssetLibrary />}
          {tab === 'layers' && <LayersPanel />}
        </aside>

        <section className="workspace">
          {view === 'editor' ? (
            <>
              <PropertiesBar />
              <CanvasEditor />
            </>
          ) : (
            <VariantsGrid />
          )}
        </section>
        </>
        )}

        <ChatPanel />
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button className={`tab ${active ? 'active' : ''}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.closest('input, textarea, select, [contenteditable]') || target.tagName === 'TEXTAREA';
      const s = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (typing || s.view !== 'editor' || !s.selectedId) return;
      const layer = s.scene.layers.find((l) => l.id === s.selectedId);
      if (!layer) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        s.deleteLayer(layer.id);
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        s.duplicateLayer(layer.id);
      } else if (e.key === 'Escape') {
        s.select(null);
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        s.updateLayer(layer.id, { x: layer.x + dx, y: layer.y + dy });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
