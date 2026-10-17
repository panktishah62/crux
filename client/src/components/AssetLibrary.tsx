import { useMemo, useState } from 'react';
import { nanoid } from 'nanoid';
import { Trash2 } from 'lucide-react';
import { ASSET_CATEGORIES, type Asset, type AssetCategory, type ImageLayer } from '../../../shared/types.ts';
import { useEditor } from '../store.ts';
import { api } from '../lib/api.ts';

const LABELS: Record<AssetCategory, string> = {
  logo: 'Logos', shape: 'Shapes', icon: 'Icons', illustration: 'Illustrations', background_template: 'Backgrounds',
  product_photo: 'Product', photo: 'Photos', guideline_page: 'Guidelines', reference: 'References', font: 'Fonts', other: 'Other',
};

export function AssetLibrary() {
  const assets = useEditor((s) => s.kit.assets);
  const setKit = useEditor((s) => s.setKit);
  const [filter, setFilter] = useState<AssetCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Partial<Record<AssetCategory, number>> = {};
    for (const a of assets) c[a.category] = (c[a.category] ?? 0) + 1;
    return c;
  }, [assets]);

  const visible = assets.filter(
    (a) =>
      a.category !== 'font' &&
      (filter === 'all' || a.category === filter) &&
      (!query || `${a.filename} ${a.description ?? ''} ${(a.tags ?? []).join(' ')}`.toLowerCase().includes(query.toLowerCase())),
  );

  if (!assets.length) return <div className="empty-panel">Upload a brand kit to fill the asset library.</div>;

  return (
    <div className="panel-scroll">
      <input className="input" placeholder="Search assets..." value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="chips">
        <button className={`chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
          All {assets.length}
        </button>
        {ASSET_CATEGORIES.filter((c) => counts[c] && c !== 'font').map((c) => (
          <button key={c} className={`chip ${filter === c ? 'active' : ''}`} onClick={() => setFilter(c)}>
            {LABELS[c]} {counts[c]}
          </button>
        ))}
      </div>
      <div className="asset-grid">
        {visible.map((a) => (
          <AssetTile
            key={a.id}
            asset={a}
            editing={editing === a.id}
            onEdit={() => setEditing(editing === a.id ? null : a.id)}
            onCategory={async (category) => setKit(await api.updateAsset(a.id, { category }))}
            onDelete={async () => setKit(await api.deleteAsset(a.id))}
          />
        ))}
      </div>
      <div className="muted small center">Click to add · drag onto canvas · right-click to retag</div>
    </div>
  );
}

function AssetTile({
  asset, editing, onEdit, onCategory, onDelete,
}: {
  asset: Asset;
  editing: boolean;
  onEdit: () => void;
  onCategory: (c: AssetCategory) => void;
  onDelete: () => void;
}) {
  const place = () => {
    const { scene: s, addLayer, select } = useEditor.getState();
    const isBg = asset.category === 'background_template';
    const width = isBg ? s.width : Math.round(s.width * (asset.category === 'logo' ? 0.22 : 0.4));
    const height = isBg ? s.height : Math.round(width * ((asset.height ?? 1) / (asset.width ?? 1)));
    const layer: ImageLayer = {
      id: `ast_${nanoid(5)}`, type: 'image', name: LABELS[asset.category].replace(/s$/, ''),
      role: isBg ? 'background' : asset.category === 'logo' ? 'logo' : 'decoration',
      x: isBg ? 0 : Math.round((s.width - width) / 2), y: isBg ? 0 : Math.round((s.height - height) / 2),
      width, height, src: asset.url, assetId: asset.id, fit: isBg ? 'cover' : 'contain',
    };
    addLayer(layer, isBg ? 0 : undefined);
    select(layer.id);
  };

  return (
    <div
      className="asset-tile"
      title={`${asset.filename}\n${asset.description ?? ''}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-asset-id', asset.id)}
      onClick={place}
      onContextMenu={(e) => {
        e.preventDefault();
        onEdit();
      }}
    >
      <div className="asset-img">
        <img src={asset.thumbUrl ?? asset.url} alt={asset.description ?? asset.filename} loading="lazy" />
      </div>
      <div className="asset-meta">
        <span className={`tag tag-${asset.category}`}>{LABELS[asset.category].replace(/s$/, '')}</span>
      </div>
      {editing && (
        <div className="asset-edit" onClick={(e) => e.stopPropagation()}>
          <select className="select small" value={asset.category} onChange={(e) => onCategory(e.target.value as AssetCategory)}>
            {ASSET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {LABELS[c]}
              </option>
            ))}
          </select>
          <button className="icon-btn ghost" onClick={onDelete} title="Remove asset">
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
