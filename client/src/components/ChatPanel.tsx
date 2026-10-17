import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, ImagePlus, Loader2, Sparkles, Square, X, AlertTriangle, Crosshair, Eye, FlaskConical } from 'lucide-react';
import { useEditor, type ChatMessage } from '../store.ts';

const SUGGESTIONS_EMPTY = [
  'Diwali sale post, 30% off, festive mood',
  'Launch post for our new invoicing feature, bold on colour',
  'Hiring ad: we are looking for designers',
];
const SUGGESTIONS_EDIT = ['Make the headline bigger', 'Make it more minimal', 'Swap the photo for something outdoors'];

export function ChatPanel() {
  const { messages, busy, sendMessage, stop, scene, selectedId, select, kit, selfReview, setSelfReview, reviewNow } = useEditor();
  const [text, setText] = useState('');
  const [reference, setReference] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const selected = scene.layers.find((l) => l.id === selectedId);
  const referenceUrl = useMemo(() => (reference ? URL.createObjectURL(reference) : null), [reference]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const submit = (value = text) => {
    const msg = value.trim() || (reference ? 'Create 4 different images like this' : '');
    if (!msg || busy) return;
    sendMessage(msg, reference ?? undefined);
    setText('');
    setReference(null);
  };

  const suggestions = scene.layers.length ? SUGGESTIONS_EDIT : SUGGESTIONS_EMPTY;

  return (
    <aside className="chat">
      <div className="chat-head">
        <Sparkles size={16} />
        <span>Copilot</span>
        {kit.profile ? <span className="pill">{kit.profile.name}</span> : <span className="pill warn">No brand kit</span>}
        <label className="toggle" title="After creating a design, render it, have a vision model critique it, and apply one round of fixes">
          <input type="checkbox" checked={selfReview} onChange={(e) => setSelfReview(e.target.checked)} />
          Self-review
        </label>
        <button className="btn small" disabled={busy || !scene.layers.length} onClick={reviewNow} title="Critique the current design and apply fixes">
          <Eye size={13} /> Review
        </button>
      </div>

      <div className="chat-log">
        {!messages.length && (
          <div className="chat-empty">
            <div className="chat-empty-title">What should we design?</div>
            <p className="muted small">
              Describe a post to create it from scratch, ask for edits to the current design, or ask for variations (e.g. "make 3 variations"), optionally with a reference image.
            </p>
          </div>
        )}
        {messages.map((m) => <Message key={m.id} message={m} />)}
        <div ref={endRef} />
      </div>

      {!busy && (
        <div className="suggestions">
          {(reference ? ['Create 4 different images like this', 'Make one like this for our brand'] : suggestions).map((s) => (
            <button key={s} className="chip" onClick={() => submit(s)}>{s}</button>
          ))}
        </div>
      )}

      <div className="composer">
        {(selected || reference) && (
          <div className="composer-context">
            {selected && (
              <span className="ctx-chip">
                <Crosshair size={12} /> Only editing: {selected.name}
                <button onClick={() => select(null)}><X size={11} /></button>
              </span>
            )}
            {reference && (
              <span className="ctx-chip">
                <img src={referenceUrl ?? ''} alt="" /> {reference.name}
                <button onClick={() => setReference(null)}><X size={11} /></button>
              </span>
            )}
          </div>
        )}
        <textarea
          className="composer-input"
          placeholder={reference ? 'Create 4 different images like this' : selected ? `Change "${selected.name}"...` : 'Ask the copilot...'}
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-actions">
          <button className="icon-btn" title="Attach a reference image" onClick={() => fileRef.current?.click()}>
            <ImagePlus size={16} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              setReference(e.target.files?.[0] ?? null);
              e.target.value = '';
            }}
          />
          <span className="grow" />
          {busy ? (
            <button className="send-btn stop" onClick={stop} title="Stop"><Square size={14} /></button>
          ) : (
            <button className="send-btn" onClick={() => submit()} disabled={!text.trim() && !reference} title="Send">
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function Message({ message: m }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  if (m.role === 'user') {
    return (
      <div className="msg user">
        {m.attachment && <img className="msg-attachment" src={m.attachment.url} alt={m.attachment.name} />}
        {m.layerName && <div className="msg-ctx"><Crosshair size={11} /> {m.layerName}</div>}
        <div>{m.text}</div>
      </div>
    );
  }
  const streaming = m.status === 'streaming';
  const shown = streaming || expanded ? m.steps : m.steps.slice(-3);
  return (
    <div className="msg assistant">
      {m.steps.length > 0 && (
        <div className="steps">
          {!streaming && m.steps.length > 3 && (
            <button className="link-btn tiny" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Hide steps' : `Show all ${m.steps.length} steps`}
            </button>
          )}
          {shown.map((s, i) => {
            const last = streaming && i === shown.length - 1;
            return (
              <div key={i} className={`step ${last ? 'active' : ''}`}>
                {last ? <Loader2 size={12} className="spin" /> : <Check size={12} />}
                <span>{s}</span>
              </div>
            );
          })}
        </div>
      )}
      {streaming && !m.steps.length && (
        <div className="step active"><Loader2 size={12} className="spin" /> Thinking...</div>
      )}
      {m.review && (
        <div className={`review-badge ${m.review.score >= 8 ? 'good' : m.review.score >= 6 ? 'ok' : 'bad'}`} title={m.review.verdict}>
          <Eye size={12} /> Self-review {m.review.score}/10
        </div>
      )}
      {m.text && (
        <div className={`msg-text ${m.status === 'error' ? 'error' : ''}`}>
          {m.status === 'error' && <AlertTriangle size={13} />} {m.text}
        </div>
      )}
      {m.offer && <StrategistOffer message={m} />}
    </div>
  );
}

function StrategistOffer({ message: m }: { message: ChatMessage }) {
  const answerOffer = useEditor((s) => s.answerOffer);
  const busy = useEditor((s) => s.busy);
  const offer = m.offer!;
  if (offer.status === 'accepted') return <div className="offer-result"><FlaskConical size={12} /> Opening the Creative Strategist...</div>;
  if (offer.status === 'declined') return <div className="offer-result muted">No problem. You can run it any time from the Creative Strategist button above the canvas.</div>;
  return (
    <div className="offer">
      {offer.fromVariants && <div className="muted small">It will analyse your top-rated variant.</div>}
      <div className="offer-actions">
        <button className="btn small primary" disabled={busy} onClick={() => answerOffer(m.id, true)}><FlaskConical size={12} /> Yes</button>
        <button className="btn small" onClick={() => answerOffer(m.id, false)}>No</button>
      </div>
    </div>
  );
}
