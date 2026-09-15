/** Minimal highlighter for code generated in the browser (JS/TS and JSON). */

const TOKEN =
  /(\/\/[^\n]*)|("(?:\\.|[^"\\\n])*")(?=\s*:)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\b(\d[\d_]*(?:\.\d+)?)\b|\b(const|let|var|new|await|async|return|import|from|export|default|function|if|else|require|true|false|null|undefined)\b|([A-Za-z_$][\w$]*)(?=\s*:(?!:))|([A-Za-z_$][\w$]*)(?=\s*\()/g;

const CLASSES = ['', 'tok-comment', 'tok-prop', 'tok-string', 'tok-number', 'tok-keyword', 'tok-prop', 'tok-fn'];

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function highlight(code: string): string {
  let out = '';
  let last = 0;
  for (const match of code.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    out += escapeHtml(code.slice(last, index));
    const group = match.findIndex((value, i) => i > 0 && value !== undefined);
    out += `<span class="${CLASSES[group]}">${escapeHtml(match[0])}</span>`;
    last = index + match[0].length;
  }
  return out + escapeHtml(code.slice(last));
}
