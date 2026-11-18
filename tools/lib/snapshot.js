// Browser-side snapshot of what a page *looks like*, used to compare a design page with the live
// site. Loaded with page.addInitScript on both sides, so it must not depend on the design runtime
// (it uses window.__dcv only when present, to record where a design element comes from).
//
// window.__cmp.snapshot({ maxHeight }) -> { width, height, items: [...] }
//   One item per visible piece of text (or labelled control/image), with its text box, its
//   typography, and the nearest "visual" box around it (button, chip, card, input…).
// window.__cmp.hoverState(n) -> the hover-sensitive styles of item n (read before and after hovering).
(function () {
  if (window.__cmp) return;

  const px = v => parseFloat(v) || 0;
  const r1 = n => Math.round(n * 10) / 10;
  const box = r => ({ x: r1(r.left), y: r1(r.top), w: r1(r.width), h: r1(r.height) });

  function hex2(n) { return Math.round(n).toString(16).padStart(2, '0'); }
  // rgb()/rgba() -> "#rrggbb" or "#rrggbb / 40%"; null for fully transparent
  function color(c) {
    if (!c || c === 'transparent') return null;
    const m = c.match(/^rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\)$/);
    if (!m) return c;
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a === 0) return null;
    const h = `#${hex2(m[1])}${hex2(m[2])}${hex2(m[3])}`;
    return a >= 1 ? h : `${h} / ${Math.round(a * 100)}%`;
  }
  const colorsIn = s => (s || '').replace(/rgba?\([^)]*\)/g, m => color(m) || 'transparent');

  const visible = el => {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const ownText = el => clean([...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join(' '));
  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, label[for], [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [onclick], [tabindex]:not([tabindex="-1"])';
  const SKIP = 'script, style, noscript, template, head, title, svg *, #cmpwrapper, .profiler-results';

  // Hidden in ways checkVisibility misses: clipped away by an overflow/clip ancestor (collapsed
  // drawers, carousels), or covered by an opaque box painted above it.
  function hidden(el, r) {
    const area = Math.max(r.width * r.height, 1);
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.clip !== 'auto' && /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip)) return true; // sr-only
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible' && cs.clipPath === 'none' && cs.contain.indexOf('paint') < 0) continue;
      const q = a.getBoundingClientRect();
      const w = Math.min(r.right, q.right) - Math.max(r.left, q.left), h = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top);
      if (w <= 0 || h <= 0 || (w * h) / area < 0.5) return true;
    }
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const stack = document.elementsFromPoint(cx, cy);
    const i = stack.findIndex(x => x === el || el.contains(x));
    if (i <= 0) return false; // on top, or not hit-testable (pointer-events: none): trust the clip check
    for (const x of stack.slice(0, i)) {
      if (x.contains(el)) continue;
      const cs = getComputedStyle(x);
      const bg = color(cs.backgroundColor);
      if ((bg && !bg.includes(' / ')) || (cs.backgroundImage !== 'none' && !/gradient\(/.test(cs.backgroundImage)) || /gradient\(/.test(cs.backgroundImage) && x.getBoundingClientRect().height > r.height * 2) return true;
    }
    return false;
  }

  function hasVisibleText(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue.trim() || n.parentElement.closest(SKIP)) continue;
      const p = n.parentElement;
      if (visible(p) && !hidden(p, textRect(p))) return true;
    }
    return false;
  }

  // Text box: the union of this element's own text nodes (not the whole block).
  function textRect(el) {
    const range = document.createRange();
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
      range.selectNodeContents(n);
      for (const q of range.getClientRects()) {
        if (!q.width || !q.height) continue;
        l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
      }
    }
    return l === Infinity ? el.getBoundingClientRect() : new DOMRect(l, t, r - l, b - t);
  }

  // Does this element paint a visible box of its own?
  function painted(cs) {
    if (color(cs.backgroundColor) || cs.backgroundImage !== 'none') return true;
    if (cs.boxShadow !== 'none') { const s = shadows(cs); if (s.shadow || s.ring) return true; }
    return ['Top', 'Right', 'Bottom', 'Left'].some(s => px(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none' && color(cs[`border${s}Color`]));
  }

  // Split box-shadow into real shadows and "rings" (0 0 0 Npx spread-only layers, which draw a border).
  // Fully transparent layers (Tailwind's placeholders) are dropped.
  function shadows(cs) {
    if (cs.boxShadow === 'none') return { shadow: null, ring: null };
    const layers = cs.boxShadow.split(/,(?![^(]*\))/).map(s => s.trim());
    const keep = [], rings = [];
    for (const l of layers) {
      const col = l.match(/rgba?\([^)]*\)/)?.[0];
      const c = color(col);
      if (col && !c) continue;
      const nums = l.replace(/rgba?\([^)]*\)/, '').replace('inset', '').trim().split(/\s+/).map(px);
      if (nums.length >= 4 && nums[0] === 0 && nums[1] === 0 && nums[2] === 0 && nums[3] > 0) rings.push(`${r1(nums[3])}px ring ${c}`);
      else keep.push(colorsIn(l));
    }
    return { shadow: keep.length ? keep.join(', ') : null, ring: rings.length ? rings.join(', ') : null };
  }

  function radius(cs, r) {
    const c = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(v => {
      const n = px(v);
      return n >= Math.min(r.width, r.height) / 2 - 0.5 && n > 0 ? 'pill' : `${r1(n)}px`;
    });
    return c.every(v => v === c[0]) ? c[0] : c.join(' ');
  }
  function border(cs) {
    const sides = ['Top', 'Right', 'Bottom', 'Left'].filter(s => px(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none' && color(cs[`border${s}Color`]));
    if (!sides.length) return null;
    const one = s => `${r1(px(cs[`border${s}Width`]))}px ${cs[`border${s}Style`]} ${color(cs[`border${s}Color`])}`;
    const all = [...new Set(sides.map(one))];
    return sides.length === 4 && all.length === 1 ? all[0] : sides.map(s => `${s.toLowerCase()}: ${one(s)}`).join(', ');
  }

  // Nearest ancestor-or-self (a few levels up) that paints a box no bigger than a card.
  function containerOf(el, maxW, maxH) {
    let cur = el;
    for (let i = 0; cur && cur !== document.body && i < 6; i++, cur = cur.parentElement) {
      const r = cur.getBoundingClientRect();
      if (r.width > maxW || r.height > maxH) return null;
      if (painted(getComputedStyle(cur))) return cur;
    }
    return null;
  }

  function boxStyle(el) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const sh = shadows(cs);
    const svgs = [...el.querySelectorAll('svg, img')].filter(s => visible(s) && s.getBoundingClientRect().width <= 48);
    return {
      tag: el.tagName.toLowerCase(),
      box: box(r),
      background: color(cs.backgroundColor),
      backgroundImage: cs.backgroundImage === 'none' ? null : (/gradient\(/.test(cs.backgroundImage) ? colorsIn(cs.backgroundImage) : 'image'),
      border: border(cs) || sh.ring,
      radius: radius(cs, r),
      shadow: sh.shadow,
      padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(v => Math.round(px(v))).join(' '),
      icon: svgs.length ? { count: svgs.length, size: `${Math.round(svgs[0].getBoundingClientRect().width)}x${Math.round(svgs[0].getBoundingClientRect().height)}` } : null,
    };
  }

  function textStyle(el) {
    const cs = getComputedStyle(el);
    return {
      color: color(cs.color),
      fontSize: r1(px(cs.fontSize)),
      fontWeight: Number(cs.fontWeight),
      fontFamily: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      fontStyle: cs.fontStyle,
      lineHeight: cs.lineHeight === 'normal' ? 'normal' : r1(px(cs.lineHeight)),
      letterSpacing: cs.letterSpacing === 'normal' ? 0 : r1(px(cs.letterSpacing)),
      textTransform: cs.textTransform,
      textDecoration: cs.textDecorationLine,
      textAlign: cs.textAlign,
    };
  }

  // Context label: the design's [data-screen-label] region, else the nearest landmark/id/heading-ish class.
  function sectionOf(el) {
    const lab = el.closest('[data-screen-label]');
    if (lab) return lab.dataset.screenLabel;
    const land = el.closest('header, nav, main, footer, aside, form, [role=dialog], section[id], [id]');
    if (!land) return null;
    return land.id ? `${land.tagName.toLowerCase()}#${land.id}` : land.tagName.toLowerCase();
  }

  // Nearest block-level ancestor-or-self: inline runs of one paragraph share it.
  const blockIds = new Map();
  function blockOf(el) {
    let cur = el;
    while (cur && cur !== document.body && getComputedStyle(cur).display.startsWith('inline') && !['inline-block', 'inline-flex', 'inline-grid'].includes(getComputedStyle(cur).display)) cur = cur.parentElement;
    if (!blockIds.has(cur)) blockIds.set(cur, blockIds.size);
    return blockIds.get(cur);
  }

  // Every painted box that shapes the layout (masthead, rail buttons, cards, bars, inputs…), so the
  // page can be compared as a whole and not only text by text. Photos and media are content, not layout.
  function layoutBoxes(maxHeight) {
    const W = innerWidth, out = [], seen = new Set();
    for (const el of document.body.querySelectorAll('*')) {
      if (el.matches(SKIP) || el.closest('#cmpwrapper, .profiler-results')) continue;
      if (['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'svg'].includes(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (!painted(cs)) continue;
      if (cs.backgroundImage !== 'none' && !/gradient\(/.test(cs.backgroundImage) && !color(cs.backgroundColor)) continue; // a photo set as background
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 16 || r.top > maxHeight || r.bottom < 0 || r.left > W || r.right < 0) continue;
      if (r.width >= W - 2 && r.height >= Math.min(document.documentElement.scrollHeight, maxHeight) - 2) continue; // the page itself
      if (!visible(el) || hidden(el, r)) continue;
      const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
      if (seen.has(key)) continue; // nested wrappers painting the same rectangle
      seen.add(key);
      const lab = el.closest('[data-screen-label]');
      const lr = lab && lab.getBoundingClientRect();
      const own = lab && Math.abs(lr.left - r.left) < 3 && Math.abs(lr.top - r.top) < 3 && Math.abs(lr.width - r.width) < 3 && Math.abs(lr.height - r.height) < 3;
      const st = boxStyle(el);
      out.push({ b: out.length, tag: st.tag, box: st.box, background: st.background, backgroundImage: st.backgroundImage, border: st.border, radius: st.radius, shadow: st.shadow,
        label: own ? lab.dataset.screenLabel : (el.getAttribute('aria-label') || null), section: sectionOf(el), interactive: !!el.closest(INTERACTIVE) });
      if (out.length >= 800) break;
    }
    return out;
  }

  const items = [];
  const api = {
    // maxHeight: ignore anything below this y (page coordinates; the caller sizes the viewport so
    // the page doesn't scroll). Item element gets data-cmp="<n>" so the runner can hover it.
    snapshot({ maxHeight = 4000 } = {}) {
      items.length = 0;
      blockIds.clear();
      const W = innerWidth, out = [];
      const seen = new Set();
      const contIds = new Map(); // container element -> id (the n of the first item inside it)
      for (const el of document.body.querySelectorAll('*')) {
        if (el.matches(SKIP) || el.closest('#cmpwrapper, .profiler-results')) continue;
        const tag = el.tagName;
        const isField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
        if (isField && ['hidden', 'checkbox', 'radio'].includes(el.type)) continue;
        let text = isField ? clean(el.value || el.placeholder) : ownText(el);
        let kind = isField ? 'field' : 'text';
        let graphic = null;
        if (!text) {
          // controls without visible text (icon buttons) and images count when they have an accessible name
          if (!(el.matches(INTERACTIVE) || tag === 'IMG')) continue;
          if (tag !== 'IMG' && hasVisibleText(el)) continue; // its visible text speaks for it
          const name = clean(el.getAttribute('aria-label') || (tag === 'IMG' ? el.alt : '') || el.title || el.textContent);
          if (!name) continue;
          text = name; kind = tag === 'IMG' ? 'image' : 'control';
          // an icon button is drawn by its icon: measure that, not the hit area
          graphic = [...el.querySelectorAll('svg, img')].find(g => visible(g) && g.getBoundingClientRect().width <= 64) || null;
        }
        if (text.length > 160) text = text.slice(0, 157) + '…';
        if (!visible(el)) continue;
        const tr = kind === 'text' ? textRect(el) : (graphic || el).getBoundingClientRect();
        if (tr.bottom < 0 || tr.top > maxHeight || tr.right < 0 || tr.left > W || tr.width < 1 || tr.height < 1) continue;
        if (hidden(el, tr)) continue;
        const target = el.closest(INTERACTIVE);
        const cont = containerOf(el, Math.min(W * 0.6, 900), 360);
        const n = items.length;
        if (cont && !contIds.has(cont)) contIds.set(cont, n);
        items.push({ el, target: target || el, cont });
        el.setAttribute('data-cmp', n);
        const key = `${text}@${Math.round(tr.left)},${Math.round(tr.top)}`;
        if (seen.has(key)) continue; // same text drawn twice at the same spot (e.g. sr-only + visible)
        seen.add(key);
        out.push({
          n, kind, text,
          tag: tag.toLowerCase(),
          role: el.getAttribute('role') || (target && target.tagName.toLowerCase()) || null,
          href: target?.getAttribute?.('href') || null,
          interactive: !!target || getComputedStyle(el).cursor === 'pointer',
          cursor: getComputedStyle(target || el).cursor,
          textBox: box(tr),
          style: textStyle(el),
          container: cont ? { id: contIds.get(cont), ...boxStyle(cont) } : null,
          block: blockOf(el),
          section: sectionOf(el),
          where: window.__dcv && window.__dcv.address ? safe(() => window.__dcv.address(el)) : null,
        });
      }
      return { width: W, height: Math.min(document.documentElement.scrollHeight, maxHeight), items: out, boxes: layoutBoxes(maxHeight) };
    },
    // Hover-sensitive styles of item n: its text, its interactive target and its container.
    hoverState(n) {
      const it = items[n];
      if (!it) return null;
      const pick = el => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          color: color(cs.color), background: color(cs.backgroundColor),
          backgroundImage: cs.backgroundImage === 'none' ? null : colorsIn(cs.backgroundImage),
          border: border(cs), shadow: cs.boxShadow === 'none' ? null : colorsIn(cs.boxShadow),
          textDecoration: cs.textDecorationLine, opacity: cs.opacity, transform: cs.transform === 'none' ? null : cs.transform,
          outline: cs.outlineStyle === 'none' ? null : `${cs.outlineWidth} ${cs.outlineStyle} ${color(cs.outlineColor)}`,
        };
      };
      return { text: pick(it.el), target: it.target === it.el ? null : pick(it.target), container: it.cont && it.cont !== it.target && it.cont !== it.el ? pick(it.cont) : null };
    },
  };
  function safe(f) { try { return f(); } catch { return null; } }
  window.__cmp = api;
})();
