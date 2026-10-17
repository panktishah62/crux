import type { TextLayer } from './types.ts';

const CONDENSED = /condensed|narrow|oswald|anton|bebas|league gothic|antonio|fjalla|big shoulders/i;

type TextMetrics = Pick<TextLayer, 'text' | 'fontSize' | 'width' | 'lineHeight' | 'uppercase' | 'fontFamily'> & { fontWeight?: number };

/** Average glyph advance; bold display faces run wider than regular body text. */
function charWidth(l: TextMetrics): number {
  const base = CONDENSED.test(l.fontFamily ?? '') ? 0.45 : 0.54;
  const weight = 1 + (Math.max(0, (l.fontWeight ?? 400) - 400) / 400) * 0.14;
  return l.fontSize * base * weight * (l.uppercase ? 1.18 : 1);
}

/** Word-wrapped line widths in px, the way a textbox of `width` breaks them. */
export function wrapLines(l: TextMetrics): number[] {
  const cw = charWidth(l);
  const space = cw * 0.55;
  const lines: number[] = [];
  for (const para of l.text.split('\n')) {
    let line = 0;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const w = word.length * cw;
      if (line && line + space + w > l.width) {
        lines.push(line);
        line = w;
      } else line = line ? line + space + w : w;
    }
    lines.push(line);
  }
  return lines;
}

/** Rough text block height so layouts can stack without overlap (the client reports exact rendered heights). */
export function estimateTextHeight(l: TextMetrics): number {
  return Math.round(wrapLines(l).length * l.fontSize * (l.lineHeight ?? 1.15));
}

export function isDisplayRole(role?: string): boolean {
  return role === 'headline' || role === 'subheadline' || role === 'offer';
}
