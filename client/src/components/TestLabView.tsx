import { useMemo, useState } from 'react';
import JSZip from 'jszip';
import {
  AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronUp, Download, FlaskConical, Info, LayoutGrid, Loader2, PenTool, RotateCw, Smartphone,
} from 'lucide-react';
import type { Scene } from '../../../shared/types.ts';
import {
  PARAM_KEYS, PARAM_LABEL, WEIGHTS, buildTags,
  type CreativeId, type ParamKey, type ParamScores, type ScoredCreative, type VariantId, type VariantPlan,
} from '../../../shared/testlab.ts';
import { useEditor } from '../store.ts';
import { retryVariant, runTestLab, type TestLabState } from '../testlab.ts';
import { ScenePreview } from '../canvas/ScenePreview.tsx';

const WEIGHTS_TIP = `Overall = weighted average of the 7 scores (1-5 → 0-100): ${PARAM_KEYS.map((k) => `${PARAM_LABEL[k]} ${Math.round(WEIGHTS[k] * 100)}%`).join(', ')}.`;

export function TestLabView() {
  const t = useEditor((s) => s.testLab);
  const setView = useEditor((s) => s.setView);
  const busy = useEditor((s) => s.busy);
  const [feed, setFeed] = useState(false);
  if (!t) return null;

  const ranked = t.stage === 'ranked';
  const order: VariantId[] = ranked ? [...t.ranking, ...t.plans.map((p) => p.id).filter((id) => !t.ranking.includes(id))] : t.plans.map((p) => p.id);
  const seconds = ((t.finishedAt ?? Date.now()) - t.startedAt) / 1000;
  const failed = ranked ? t.plans.length - t.ranking.length : 0;

  return (
    <div className="testlab">
      <div className="testlab-head">
        <button className="btn ghost" onClick={() => setView('editor')}><ArrowLeft size={15} /> Back to editor</button>
        <div className="testlab-title"><FlaskConical size={17} /> Creative Strategist</div>
        <span className="grow" />
        {ranked && t.finishedAt && <span className="muted small nowrap">Finished in {Math.round(seconds)}s</span>}
        <div className="segmented">
          <button className={!feed ? 'active' : ''} onClick={() => setFeed(false)}><LayoutGrid size={14} /> Grid</button>
          <button className={feed ? 'active' : ''} onClick={() => setFeed(true)} disabled={!t.plans.length}><Smartphone size={14} /> Feed</button>
        </div>
        <button className="btn" disabled={!ranked} onClick={() => exportAll(t)}><Download size={14} /> Export all</button>
        <button className="btn icon-only" disabled={busy} onClick={() => runTestLab()} title="Run the test again on the current canvas"><RotateCw size={14} /></button>
      </div>

      <div className="testlab-body">
        <ProgressStrip t={t} />
        {t.error && <div className="error-box">{t.error}</div>}
        <AnalysisCard t={t} />

        {feed ? (
          <FeedView t={t} order={order} />
        ) : (
          <>
            <div className="lab-section-head">
              <h3>{ranked ? 'Ranked experiments' : 'Experiments'}</h3>
              <span className="muted small">Each variant changes one thing from the control.</span>
            </div>
            {ranked && t.noClearWinner && <div className="testlab-note">No clear winner; these differences are within scoring noise.</div>}
            {failed > 0 && <div className="testlab-note">{failed} of {t.plans.length} experiments could not be built as a clean one-change test and were not scored. Use Retry to try a new plan.</div>}
            <div className="testlab-grid">
              {order.map((id) => <VariantCard key={`${id}-${ranked ? 'r' : 'p'}`} t={t} id={id} />)}
              {!t.plans.length && t.stage !== 'error' && [0, 1, 2, 3].map((i) => <div key={i} className="lab-card skeleton" />)}
            </div>
          </>
        )}
        <div className="testlab-footnote"><Info size={13} /> Predicted from creative best practices. Validate with a live A/B test.</div>
      </div>
    </div>
  );
}

function ProgressStrip({ t }: { t: TestLabState }) {
  const builtCount = Object.keys(t.built).length;
  const n = t.plans.length || 4;
  const stages = [
    { key: 'analysing', label: 'Analysed', done: !!t.analysis },
    { key: 'planning', label: 'Planning', done: t.plans.length > 0 },
    { key: 'building', label: `Building ${builtCount}/${n}`, done: t.plans.length > 0 && builtCount >= t.plans.length },
    { key: 'scoring', label: 'Scoring', done: t.stage === 'ranked' },
    { key: 'ranked', label: 'Ranked', done: t.stage === 'ranked' },
  ];
  const activeIndex = stages.findIndex((s) => !s.done);
  return (
    <div className="lab-progress">
      {stages.map((s, i) => {
        const active = i === activeIndex && t.stage !== 'error';
        return (
          <div key={s.key} className={`lab-step ${s.done ? 'done' : active ? 'active' : ''}`}>
            {s.done ? <Check size={13} /> : active ? <Loader2 size={13} className="spin" /> : <span className="dot" />}
            {s.label}
          </div>
        );
      })}
    </div>
  );
}

function ScoreBar({ score, highlight }: { score: number; highlight?: boolean }) {
  return (
    <span className={`seg-bar ${highlight ? 'hl' : ''}`}>
      {[1, 2, 3, 4, 5].map((i) => <span key={i} className={i <= score ? `on s${score}` : ''} />)}
    </span>
  );
}

function AnalysisCard({ t }: { t: TestLabState }) {
  const [open, setOpen] = useState<ParamKey | null>(null);
  const openCreative = useEditor((s) => s.openCreative);
  const a = t.analysis;
  const oppKeys = new Set(a?.opportunities.map((o) => o.param));
  return (
    <div className="analysis-card">
      <div className="analysis-control">
        <div className="analysis-thumb">
          <ScenePreview scene={t.original} />
          <span className="control-label">Control</span>
        </div>
        <div className="lab-actions">
          <button className="btn small" onClick={() => openCreative(t.original)} title="Open the control in the editor"><PenTool size={12} /> Open</button>
          <button className="btn small" onClick={() => exportOne(t, 'original')} disabled={!t.pngs.original}><Download size={12} /> Export</button>
        </div>
      </div>

      {!a ? (
        <div className="analysis-loading"><Loader2 size={16} className="spin" /> Scoring the control on 7 parameters...</div>
      ) : (
        <>
          <div className="analysis-scores">
            <div className="analysis-total" title={WEIGHTS_TIP}>
              <span className="big">{a.total}</span><span className="muted">/100</span>
              <Info size={13} className="muted" />
            </div>
            {a.flags.length > 0 && <div className="chip-row">{a.flags.map((f) => <span key={f} className="flag-chip"><AlertTriangle size={11} /> {f}</span>)}</div>}
            <div className="param-rows">
              {PARAM_KEYS.map((k) => (
                <div key={k} className={`param-row ${oppKeys.has(k) ? 'opp' : ''} ${open === k ? 'open' : ''}`} title={a.params[k].reason} onClick={() => setOpen(open === k ? null : k)}>
                  <span className="param-name">{PARAM_LABEL[k]}</span>
                  <ScoreBar score={a.params[k].score} />
                  <span className="param-score">{a.params[k].score}/5</span>
                  {open === k && <div className="param-detail">{a.params[k].reason}</div>}
                </div>
              ))}
            </div>
          </div>
          <div className="analysis-opps">
            <div className="opps-title">Top opportunities</div>
            {a.opportunities.map((o, i) => (
              <div key={o.param} className="opp-card">
                <div className="opp-head">
                  <span className="opp-num">{i + 1}</span>
                  <strong>{PARAM_LABEL[o.param]}</strong>
                  <span className="muted small">{a.params[o.param].score}/5</span>
                </div>
                <div className="opp-idea">{o.idea}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function VariantCard({ t, id }: { t: TestLabState; id: VariantId }) {
  const [expanded, setExpanded] = useState(false);
  const [showError, setShowError] = useState(false);
  const openCreative = useEditor((s) => s.openCreative);
  const busy = useEditor((s) => s.busy);
  const plan = t.plans.find((p) => p.id === id)!;
  const built = t.built[id];
  const scored = t.scores[id];
  const before = t.analysis?.params;
  const aspect = `${t.original.width} / ${t.original.height}`;

  return (
    <div className={`lab-card ${built?.error ? 'failed' : ''} ${scored?.rank === 1 && !t.noClearWinner ? 'winner' : ''}`}>
      <div className="lab-card-head">
        <span className="rank-badge">{scored?.rank ? `#${scored.rank}` : id.toUpperCase()}</span>
        <span className="tests-chip">Tests: {PARAM_LABEL[plan.param]}</span>
        <span className="grow" />
        {scored && (
          <span className="score-pair" title={WEIGHTS_TIP}>
            <span className="lab-score">{scored.total}</span>
            <span className={`delta-chip ${scored.delta > 0 ? 'up' : scored.delta < 0 ? 'down' : ''}`}>{scored.delta > 0 ? '+' : scored.delta < 0 ? '−' : '±'}{Math.abs(scored.delta)}</span>
          </span>
        )}
      </div>

      <div className="lab-thumb">
        {built?.scene ? (
          <ScenePreview scene={built.scene} />
        ) : (
          <div className={`lab-thumb-empty ${built?.error ? '' : 'shimmer'}`} style={{ aspectRatio: aspect }}>
            {built?.error ? <><AlertTriangle size={16} /> Not built</> : <><Loader2 size={16} className="spin" /> Building...</>}
          </div>
        )}
      </div>

      <div className="lab-line changed">{plan.changed}</div>
      <div className={`lab-text ${expanded ? '' : 'clamp'}`}>
        <div className="lab-line"><strong>Why:</strong> {plan.why}</div>
        <div className="lab-line hypothesis">{plan.hypothesis}</div>
      </div>

      {(scored?.flags.length || built?.notes.length) ? (
        <div className="chip-row">
          {scored?.flags.map((f) => <span key={f} className="flag-chip"><AlertTriangle size={11} /> {f}</span>)}
          {built?.notes.map((n) => <span key={n} className="note-chip">{n}</span>)}
        </div>
      ) : null}

      {built?.error && (
        <div className="lab-error">
          <div className="lab-error-row">
            <AlertTriangle size={13} />
            <span className="grow">This experiment couldn't be built as a clean one-change test.</span>
            <button className="btn small" disabled={busy} onClick={() => retryVariant(id)}><RotateCw size={12} /> Retry</button>
          </div>
          <button className="link-btn tiny" onClick={() => setShowError(!showError)}>{showError ? 'Hide details' : 'Show details'}</button>
          {showError && <div className="lab-error-detail">{built.error}</div>}
        </div>
      )}

      <button className="link-btn tiny" onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {expanded ? 'Less' : scored && before ? `Details · ${PARAM_LABEL[plan.param].toLowerCase()} ${before[plan.param].score} → ${scored.params[plan.param].score}` : 'Details'}
      </button>
      {expanded && scored && before && <MiniBars params={scored.params} before={before} tested={plan.param} />}

      {built?.scene && (
        <div className="lab-actions">
          <button className="btn small primary" onClick={() => openCreative(built.scene!)}><PenTool size={12} /> Open in editor</button>
          <button className="btn small" onClick={() => exportOne(t, id)} disabled={!t.pngs[id]}><Download size={12} /> Export</button>
        </div>
      )}
    </div>
  );
}

function MiniBars({ params, before, tested }: { params: ParamScores; before: ParamScores; tested: ParamKey }) {
  return (
    <div className="mini-bars">
      {PARAM_KEYS.map((k) => (
        <div key={k} className={`mini-row ${k === tested ? 'tested' : ''}`} title={params[k].reason}>
          <span>{PARAM_LABEL[k]}</span>
          <ScoreBar score={params[k].score} highlight={k === tested} />
          <span className="muted">{before[k].score !== params[k].score ? `${before[k].score} → ${params[k].score}` : params[k].score}</span>
        </div>
      ))}
    </div>
  );
}

function FeedView({ t, order }: { t: TestLabState; order: VariantId[] }) {
  const brand = useEditor((s) => s.kit.profile?.name ?? 'Brand');
  const items: { id: CreativeId; scene: Scene; label: string; scored?: ScoredCreative; plan?: VariantPlan }[] = useMemo(
    () => [
      { id: 'original' as CreativeId, scene: t.original, label: 'Control', scored: t.scores.original },
      ...order.flatMap((id) => {
        const b = t.built[id];
        return b?.scene ? [{ id: id as CreativeId, scene: b.scene, label: t.scores[id]?.rank ? `#${t.scores[id]!.rank}` : id.toUpperCase(), scored: t.scores[id], plan: b.plan }] : [];
      }),
    ],
    [t, order],
  );
  return (
    <div className="feed-wrap">
      {items.map((it) => (
        <div key={it.id} className="feed-phone">
          <div className="feed-meta">
            <span className="rank-badge">{it.label}</span>
            {it.plan && <span className="tests-chip">{PARAM_LABEL[it.plan.param]}</span>}
            <span className="grow" />
            {it.scored && <span className="lab-score">{it.scored.total}</span>}
          </div>
          <div className="feed-post">
            <div className="feed-post-head"><span className="feed-avatar" /> <strong>{brand}</strong> <span className="muted">Sponsored</span></div>
            <ScenePreview scene={it.scene} width={375} />
            <div className="feed-post-foot">♡ 💬 ↗</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Export

function download(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
}

function tagsFor(t: TestLabState, id: CreativeId) {
  const { kit } = useEditor.getState();
  const scene = id === 'original' ? t.original : t.built[id as VariantId]?.scene;
  if (!scene) return null;
  return buildTags(id, scene, kit, { plan: t.plans.find((p) => p.id === id), analysis: t.analysis, scored: t.scores[id] });
}

function exportOne(t: TestLabState, id: CreativeId) {
  const png = t.pngs[id];
  const tags = tagsFor(t, id);
  if (png) download(png, `${id}.png`);
  if (tags) download(URL.createObjectURL(new Blob([JSON.stringify(tags, null, 2)], { type: 'application/json' })), `${id}.tags.json`);
}

async function exportAll(t: TestLabState) {
  const zip = new JSZip();
  const ids: CreativeId[] = ['original', ...t.ranking];
  for (const id of ids) {
    const png = t.pngs[id];
    if (png) zip.file(`${id}.png`, png.split(',', 2)[1], { base64: true });
    const tags = tagsFor(t, id);
    if (tags) zip.file(`${id}.tags.json`, JSON.stringify(tags, null, 2));
  }
  const original = t.scores.original;
  const lines = [
    '# Creative Strategist test plan',
    '',
    `Control: ${original?.total ?? t.analysis?.total ?? '?'}/100`,
    '',
    ...t.ranking.flatMap((id) => {
      const p = t.plans.find((x) => x.id === id)!;
      const s = t.scores[id]!;
      return [
        `## #${s.rank} ${id.toUpperCase()} — tests ${PARAM_LABEL[p.param]}`,
        `- Changed: ${p.changed}`,
        `- Why: ${p.why}`,
        `- Hypothesis: ${p.hypothesis}`,
        `- Predicted: ${s.total}/100 (${s.delta >= 0 ? '+' : ''}${s.delta} vs control)${s.flags.length ? `; flags: ${s.flags.join(', ')}` : ''}`,
        '',
      ];
    }),
    t.noClearWinner ? 'No clear winner; differences are within scoring noise.\n' : '',
    '_Predicted from creative best practices. Validate with a live A/B test._',
  ];
  zip.file('test-plan.md', lines.join('\n'));
  const blob = await zip.generateAsync({ type: 'blob' });
  download(URL.createObjectURL(blob), 'creative-test.zip');
}
