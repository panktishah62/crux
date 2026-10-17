import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, PenTool, ShieldCheck } from 'lucide-react';
import type { Scene } from '../../../shared/types.ts';
import { lintScene } from '../../../shared/lint.ts';
import { useEditor } from '../store.ts';
import { ScenePreview } from '../canvas/ScenePreview.tsx';

/** Live linter result for a finished variant: the same errors the agent repairs. */
function BrandBadge({ scene }: { scene: Scene }) {
  const kit = useEditor((s) => s.kit);
  const issues = useMemo(() => lintScene(scene, kit).filter((i) => i.severity === 'error').map((i) => i.message), [scene, kit]);
  if (!kit.profile) return null;
  return issues.length ? (
    <span className="brand-badge warn" title={issues.join('\n')}><AlertTriangle size={11} /> {issues.length}</span>
  ) : (
    <span className="brand-badge ok" title="Linter passed: palette, fonts, contrast, logo, canvas bounds, text and image collisions, card edges"><ShieldCheck size={11} /> Brand</span>
  );
}

export function VariantsGrid() {
  const variants = useEditor((s) => s.variants);
  const openVariant = useEditor((s) => s.openVariant);
  const containerRef = useRef<HTMLDivElement>(null);
  const [cardWidth, setCardWidth] = useState(280);

  const n = variants?.scenes.length ?? 0;
  const aspect = variants?.scenes[0] ? variants.scenes[0].height / variants.scenes[0].width : 1;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !n) return;
    const fit = () => {
      const cols = n <= 2 ? n : n <= 4 ? 2 : 3;
      const rows = Math.ceil(n / cols);
      const byWidth = (el.clientWidth - 48 - (cols - 1) * 20) / cols;
      const byHeight = ((el.clientHeight - 48 - (rows - 1) * 20) / rows - 56) / aspect;
      setCardWidth(Math.max(160, Math.floor(Math.min(byWidth, byHeight))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [n, aspect]);

  if (!variants) return null;
  const cols = n <= 2 ? n : n <= 4 ? 2 : 3;

  return (
    <div className="variants" ref={containerRef}>
      <div className="variants-grid" style={{ gridTemplateColumns: `repeat(${cols}, ${cardWidth}px)` }}>
        {variants.scenes.map((scene, i) => {
          const status = variants.status[i];
          const lastStep = variants.steps[i][variants.steps[i].length - 1];
          return (
            <div key={i} className={`variant-card ${status}`}>
              <div className="variant-canvas" style={{ width: cardWidth, height: Math.round(cardWidth * aspect) }}>
                <ScenePreview scene={scene} width={cardWidth} />
                {status === 'running' && !scene.layers.length && <div className="variant-shimmer" />}
              </div>
              <div className="variant-foot">
                <span className="variant-status">
                  {(status === 'running' || status === 'reviewing') && <Loader2 size={12} className="spin" />}
                  {status === 'done' && <Check size={12} />}
                  {status === 'error' && <AlertTriangle size={12} />}
                  <span className="truncate">{status === 'done' ? `Variant ${i + 1}` : lastStep ?? 'Starting...'}</span>
                  {variants.scores[i] !== null && <span className="score-pill">{variants.scores[i]}/10</span>}
                  {status === 'done' && <BrandBadge scene={scene} />}
                </span>
                <button className="btn small primary" disabled={status === 'running' || status === 'reviewing'} onClick={() => openVariant(i)}>
                  <PenTool size={12} /> Open
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
