// Map dc runtime template ids (data-dc-tpl="N") back to source lines.
// The runtime numbers template elements in document order, so the Nth opening
// tag inside <x-dc> (ignoring <style>/<script>/<sc-raw> bodies and comments) is tpl N.
import fs from 'node:fs';

const cache = new Map();

export function tplIndex(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.index;
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf('<x-dc>');
  const end = text.lastIndexOf('</x-dc>');
  const index = []; // tpl -> { line, tag }
  if (start >= 0) {
    // precompute line starts
    const lineAt = makeLineLookup(text);
    const re = /<!--[\s\S]*?-->|<(style|script|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<([a-zA-Z][\w:-]*)/g;
    re.lastIndex = start + '<x-dc>'.length;
    let m;
    while ((m = re.exec(text)) && m.index < end) {
      if (m[0].startsWith('<!--')) continue;
      if (m[1]) {
        // style/script/textarea is itself one element; its body has no elements
        if (m[1] === 'script' && /data-dc-script/.test(m[0].slice(0, 200))) continue; // logic block, not template
        index.push({ line: lineAt(m.index), col: m.index - text.lastIndexOf('\n', m.index - 1), offset: m.index, tag: m[1] });
        continue;
      }
      index.push({ line: lineAt(m.index), col: m.index - text.lastIndexOf('\n', m.index - 1), offset: m.index, tag: m[2].toLowerCase() });
    }
  }
  cache.set(file, { mtime: st.mtimeMs, index, text });
  return index;
}

function makeLineLookup(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return pos => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

export function tplLine(file, tpl) {
  const e = tplIndex(file)[Number(tpl)];
  return e ? e.line : null;
}

// { line, col, snippet } for a tpl id; snippet = the element's opening tag.
export function tplSource(file, tpl) {
  tplIndex(file);
  const { index, text } = cache.get(file);
  const e = index[Number(tpl)];
  if (!e) return null;
  // find end of opening tag, respecting quotes
  let i = e.offset, q = null;
  for (; i < text.length && i < e.offset + 4000; i++) {
    const c = text[i];
    if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
  }
  return { line: e.line, col: e.col, snippet: text.slice(e.offset, i + 1) };
}
