import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ShieldCheck, Wand2, XCircle } from 'lucide-react';
import { lintScene } from '../../../shared/lint.ts';
import type { LintIssue } from '../../../shared/types.ts';
import { useEditor } from '../store.ts';

const RULE_LABEL: Record<LintIssue['rule'], string> = {
  palette: 'Palette', font: 'Font', logo: 'Logo', contrast: 'Contrast', safe_zone: 'Safe zone', bounds: 'Bounds', legibility: 'Legibility', layout: 'Layout',
};

/** Live brand linter for the editor scene: badge + issue list with one-click fixes. */
export function BrandCheck() {
  const { scene, kit, fixLint, select, sendMessage, busy, measuredHeights } = useEditor();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const issues = useMemo(() => {
    if (!scene.layers.length) return [];
    const rendered = { ...scene, layers: scene.layers.map((l) => (l.type === 'text' && measuredHeights[l.id] ? { ...l, height: measuredHeights[l.id] } : l)) };
    return lintScene(rendered, kit);
  }, [scene, kit, measuredHeights]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (!kit.profile || !scene.layers.length) return null;
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.length - errors.length;
  const fixable = errors.filter((i) => i.fix);
  const state = errors.length ? 'error' : warnings ? 'warn' : 'ok';

  const askCopilot = () => {
    setOpen(false);
    select(null);
    sendMessage(`Fix these brand check issues without rebuilding the design:\n${issues.map((i) => `- ${i.message}`).join('\n')}`);
  };

  return (
    <div className="brand-check" ref={ref}>
      <button className={`brand-check-badge ${state}`} onClick={() => setOpen((o) => !o)} title="Brand check">
        {state === 'ok' ? <ShieldCheck size={15} /> : state === 'error' ? <XCircle size={15} /> : <AlertTriangle size={15} />}
        {state === 'ok' ? 'On brand' : `${errors.length ? `${errors.length} error${errors.length > 1 ? 's' : ''}` : ''}${errors.length && warnings ? ' · ' : ''}${warnings ? `${warnings} warning${warnings > 1 ? 's' : ''}` : ''}`}
      </button>
      {open && (
        <div className="brand-check-pop">
          <div className="brand-check-head">
            <strong>Brand check</strong>
            <span className="muted">{kit.profile.name}</span>
          </div>
          {!issues.length ? (
            <div className="brand-check-ok">
              <CheckCircle2 size={16} /> Palette, fonts, logo, contrast and safe zones all pass.
            </div>
          ) : (
            <ul className="lint-list">
              {issues.map((i) => (
                <li key={i.id} className={i.severity} onClick={() => i.layerId && select(i.layerId)}>
                  <span className={`lint-tag ${i.severity}`}>{RULE_LABEL[i.rule]}</span>
                  <span className="lint-msg">{i.message}</span>
                  {i.fix && i.severity === 'error' && (
                    <button
                      className="btn small"
                      onClick={(e) => {
                        e.stopPropagation();
                        fixLint([i]);
                      }}
                    >
                      Fix
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!!issues.length && (
            <div className="brand-check-actions">
              <button className="btn primary small" disabled={!fixable.length} onClick={() => fixLint(fixable)}>
                <Wand2 size={13} /> Auto-fix {fixable.length || ''}
              </button>
              <button className="btn small" disabled={busy} onClick={askCopilot}>
                Ask copilot to fix
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
