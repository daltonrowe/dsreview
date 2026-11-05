// Browser-side helpers for design-project pages. Loaded two ways:
//   - Playwright: page.addInitScript({ path }) (tools/lib/render.mjs)
//   - Viewer:     injected into the same-origin iframe (tools/viewer/view.html)
// Exposes window.__dcv.
(function () {
  if (window.__dcv) return;

  const fiberOf = el => { const k = Object.keys(el).find(k => k.startsWith('__reactFiber$')); return k ? el[k] : null; };

  // ---------- color normalisation ----------
  function hex2(n) { return Math.round(n).toString(16).padStart(2, '0'); }
  function normColor(c) {
    if (!c) return c;
    const m = c.match(/^rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\)$/);
    if (!m) return c;
    let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    const h = `#${hex2(m[1])}${hex2(m[2])}${hex2(m[3])}`;
    return a >= 1 ? h : `${h} / ${Math.round(a * 100)}%`;
  }
  const transparent = c => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);

  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\s+/g, ' ').trim();
  }
  function textish(el) {
    if (ownText(el)) return true;
    return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName) && !!(el.value || el.placeholder || el.innerText);
  }
  const px = v => parseFloat(v) || 0;

  // ---------- presets: what to collect for each token type ----------
  // value(el, cs) -> string|null (null = skip). declared: CSS properties to look up
  // the authored expression for (first hit wins). inherited: walk ancestors for the declaration.
  const PRESETS = {
    radius: {
      title: 'Corner radius',
      declared: ['border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
      value(el, cs) {
        const c = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
        if (c.every(v => px(v) === 0)) return null;
        // huge radii are all "pill"
        const r = el.getBoundingClientRect();
        const norm = c.map(v => (v.endsWith('px') && px(v) >= Math.min(r.width, r.height) / 2 && px(v) > 24 ? 'pill' : v));
        return norm.every(v => v === norm[0]) ? norm[0] : norm.join(' ');
      },
      sort: 'numeric',
    },
    'text-color': {
      title: 'Text color', declared: ['color'], inherited: true, swatch: 'color',
      value(el, cs) { return textish(el) ? normColor(cs.color) : null; },
    },
    background: {
      title: 'Background color', declared: ['background-color', 'background'], swatch: 'color',
      value(el, cs) { return transparent(cs.backgroundColor) ? null : normColor(cs.backgroundColor); },
    },
    overlay: {
      title: 'Overlays (translucent colors)', declared: ['background-color', 'background'], swatch: 'color',
      value(el, cs) {
        if (transparent(cs.backgroundColor)) return null;
        const n = normColor(cs.backgroundColor);
        return n.includes(' / ') ? n : null; // only partially transparent fills
      },
    },
    gradient: {
      title: 'Gradients', declared: ['background-image', 'background'], swatch: 'image',
      value(el, cs) { return /gradient\(/.test(cs.backgroundImage) ? cs.backgroundImage.replace(/rgba?\([^)]*\)/g, m => normColor(m)) : null; },
    },
    'border-color': {
      title: 'Border color', swatch: 'color',
      declared: ['border-color', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
      value(el, cs) {
        const sides = ['Top', 'Right', 'Bottom', 'Left'].filter(s => px(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none' && !transparent(cs[`border${s}Color`]));
        if (!sides.length) return null;
        const cols = [...new Set(sides.map(s => normColor(cs[`border${s}Color`])))];
        return cols.join(', ');
      },
    },
    border: {
      title: 'Borders', swatch: 'border',
      declared: ['border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-width', 'border-style'],
      value(el, cs) {
        const sides = ['Top', 'Right', 'Bottom', 'Left']
          .map(s => ({ s: s.toLowerCase(), w: cs[`border${s}Width`], st: cs[`border${s}Style`], c: cs[`border${s}Color`] }))
          .filter(x => px(x.w) > 0 && x.st !== 'none' && !transparent(x.c));
        if (!sides.length) return null;
        const desc = x => `${x.w} ${x.st} ${normColor(x.c)}`;
        const groups = new Map();
        for (const x of sides) { const d = desc(x); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(x.s); }
        if (sides.length === 4 && groups.size === 1) return [...groups.keys()][0];
        return [...groups.entries()].map(([d, ss]) => `${ss.join(', ')}: ${d}`).join('; ');
      },
    },
    'border-width': {
      title: 'Border width',
      declared: ['border-width', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left'],
      value(el, cs) {
        const w = ['Top', 'Right', 'Bottom', 'Left'].map(s => (cs[`border${s}Style`] === 'none' ? '0px' : cs[`border${s}Width`]));
        if (w.every(v => px(v) === 0)) return null;
        return w.every(v => v === w[0]) ? w[0] : w.join(' ');
      },
      sort: 'numeric',
    },
    shadow: {
      title: 'Shadows', declared: ['box-shadow'],
      value(el, cs) { return cs.boxShadow === 'none' ? null : cs.boxShadow.replace(/rgba?\([^)]*\)/g, m => normColor(m)); },
    },
    'font-size': {
      title: 'Font size', declared: ['font-size', 'font'], inherited: true, sort: 'numeric',
      value(el, cs) { return textish(el) ? cs.fontSize : null; },
    },
    'size-weight': {
      title: 'Type sizes × weights', declared: ['font-size', 'font', 'font-weight'], inherited: true, sort: 'numeric', swatch: 'type',
      value(el, cs) { return textish(el) ? `${cs.fontSize} / ${cs.fontWeight}` : null; },
    },
    'font-weight': {
      title: 'Font weight', declared: ['font-weight', 'font'], inherited: true, sort: 'numeric',
      value(el, cs) { return textish(el) ? cs.fontWeight : null; },
    },
    'line-height': {
      title: 'Line height', declared: ['line-height', 'font'], inherited: true, sort: 'numeric',
      value(el, cs) { return textish(el) ? cs.lineHeight : null; },
    },
    'letter-spacing': {
      title: 'Letter spacing', declared: ['letter-spacing'], inherited: true, sort: 'numeric',
      value(el, cs) { return textish(el) && cs.letterSpacing !== 'normal' && px(cs.letterSpacing) !== 0 ? cs.letterSpacing : null; },
    },
    'font-family': {
      title: 'Font family', declared: ['font-family', 'font'], inherited: true,
      value(el, cs) { return textish(el) ? cs.fontFamily.split(',')[0].replace(/["']/g, '').trim() : null; },
    },
    typography: {
      title: 'Type styles (size / weight / line-height · family)', declared: ['font-size', 'font', 'font-weight', 'line-height'], inherited: true, sort: 'numeric', swatch: 'type',
      value(el, cs) {
        if (!textish(el)) return null;
        const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
        const lh = cs.lineHeight === 'normal' ? 'normal' : cs.lineHeight;
        return `${cs.fontSize} / ${cs.fontWeight} / ${lh}${cs.letterSpacing !== 'normal' && px(cs.letterSpacing) ? ` / ${cs.letterSpacing}` : ''} · ${fam}${cs.fontStyle === 'italic' ? ' italic' : ''}`;
      },
    },
    // Multi-valued: one record per distinct length on the element, with the properties using it.
    spacing: {
      title: 'Spacing values', sort: 'numeric', multi: true,
      value(el, cs) {
        const out = new Map();
        const add = (v, p) => {
          if (!/px$/.test(v)) return;
          const n = parseFloat(v);
          if (!(n > 0) || n > 400) return;
          const k = Math.round(n * 100) / 100 + 'px';
          if (!out.has(k)) out.set(k, []);
          out.get(k).push(p);
        };
        // auto margins (centering) compute to px; skip the sides declared auto
        const autoSides = new Set();
        for (const p of ['margin', 'margin-inline', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom']) {
          const d = declaredOn(el, [p]);
          if (!d || !/auto/.test(d.value)) continue;
          if (p === 'margin') { const parts = d.value.trim().split(/\s+/); const sides = ['top', 'right', 'bottom', 'left']; const map = parts.length === 1 ? [0, 0, 0, 0] : parts.length === 2 ? [0, 1, 0, 1] : parts.length === 3 ? [0, 1, 2, 1] : [0, 1, 2, 3]; sides.forEach((s, i) => { if (parts[map[i]] === 'auto') autoSides.add(s); }); }
          else if (p === 'margin-inline') { autoSides.add('left'); autoSides.add('right'); }
          else autoSides.add(p.slice(7));
        }
        for (const s of ['top', 'right', 'bottom', 'left']) {
          add(cs.getPropertyValue('padding-' + s), 'padding-' + s);
          if (!autoSides.has(s)) add(cs.getPropertyValue('margin-' + s), 'margin-' + s);
        }
        if (/flex|grid/.test(cs.display)) { add(cs.rowGap, 'row-gap'); add(cs.columnGap, 'column-gap'); }
        return [...out].map(([value, props]) => ({ value, props }));
      },
      declaredFor: props => [...new Set(props.flatMap(p => { const base = p.split('-')[0]; return p.endsWith('gap') ? ['gap', p] : [base, `${base}-${/left|right/.test(p) ? 'inline' : 'block'}`, p]; }))],
    },
    gap: {
      title: 'Gap', declared: ['gap', 'row-gap', 'column-gap'], sort: 'numeric',
      value(el, cs) {
        if (!/flex|grid/.test(cs.display)) return null;
        const r = cs.rowGap, c = cs.columnGap;
        if (px(r) === 0 && px(c) === 0) return null;
        return r === c || r === 'normal' ? c : c === 'normal' ? r : `${r} ${c}`;
      },
    },
    padding: {
      title: 'Padding', sort: 'numeric',
      declared: ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-inline', 'padding-block'],
      value(el, cs) {
        const p = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft];
        if (p.every(v => px(v) === 0)) return null;
        if (p[0] === p[2] && p[1] === p[3]) return p[0] === p[1] ? p[0] : `${p[0]} ${p[1]}`;
        return p.join(' ');
      },
    },
    opacity: {
      title: 'Opacity', declared: ['opacity'], sort: 'numeric',
      value(el, cs) { return cs.opacity === '1' ? null : cs.opacity; },
    },
  };

  // ---------- authored (declared) value lookup ----------
  const ruleCache = new Map();
  function rulesFor(prop) {
    if (ruleCache.has(prop)) return ruleCache.get(prop);
    const out = [];
    const walk = rules => {
      for (const r of rules) {
        if (r.style && r.selectorText) {
          const v = r.style.getPropertyValue(prop);
          if (v) out.push({ sel: r.selectorText, v: v.trim(), imp: r.style.getPropertyPriority(prop) === 'important' });
        } else if (r.cssRules && (!r.media || matchMedia(r.media.mediaText).matches)) walk(r.cssRules);
      }
    };
    for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch { /* cross-origin */ } }
    ruleCache.set(prop, out);
    return out;
  }
  function declaredOn(el, props) {
    for (const p of props) {
      const inline = el.style && el.style.getPropertyValue(p);
      if (inline) return { prop: p, value: inline.trim(), from: 'inline' };
    }
    for (const p of props) {
      const rules = rulesFor(p);
      let hit = null;
      for (const r of rules) { try { if (el.matches(r.sel) && (!hit || r.imp || !hit.imp)) hit = r; } catch { } }
      if (hit) return { prop: p, value: hit.v, from: hit.sel };
    }
    return null;
  }
  function declared(el, preset) {
    let cur = el, hops = 0;
    while (cur && cur.nodeType === 1) {
      const d = declaredOn(cur, preset.declared || []);
      if (d) {
        if (hops) { d.inheritedFrom = describeEl(cur); }
        return d;
      }
      if (!preset.inherited) return null;
      cur = cur.parentElement; hops++;
    }
    return null;
  }

  function describeEl(el) {
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const lab = el.dataset && el.dataset.screenLabel ? `[${el.dataset.screenLabel}]` : '';
    return `${el.tagName.toLowerCase()}${cls}${lab}`;
  }

  const api = {
    PRESETS,
    presetList() { return Object.entries(PRESETS).map(([id, p]) => ({ id, title: p.title })); },

    vis(el) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      if (r.bottom <= 0) return false;
      // slide-out drawers parked mostly off-screen count as hidden
      const onX = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      if (onX < r.width * 0.5) return false;
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
      return true;
    },

    // ---- dc runtime access ----
    hosts(fromEl) {
      const hosts = [];
      const start = fromEl || [...document.querySelectorAll('#dc-root *')].find(e => fiberOf(e));
      for (let f = start && fiberOf(start); f; f = f.return) if (f.stateNode && f.stateNode.logic && !hosts.includes(f.stateNode)) hosts.push(f.stateNode);
      return hosts; // innermost first
    },
    root() { const h = this.hosts(); return h[h.length - 1]; },
    owner(el) { const h = this.hosts(el)[0]; return h ? h.__name : (window.__dcRootName && __dcRootName()); },
    setState(patch) { const h = this.root(); if (!h) throw new Error('no DC logic instance found'); h.logic.setState(patch); },
    getState() {
      const h = this.root(); if (!h) return null;
      const out = {};
      for (const [k, v] of Object.entries(h.logic.state)) {
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
        else out[k] = Array.isArray(v) ? `[${v.length} items]` : typeof v === 'object' ? '{…}' : typeof v;
      }
      return out;
    },
    propsMeta() { const r = window.__dcRootName && __dcRootName(); return (r && __dcRegistry[r] && __dcRegistry[r].propsMeta) || null; },
    setProps(p) { __dcSetProps(__dcRootName(), p); },
    ready() { return typeof window.__dcRootName === 'function' && document.querySelector('#dc-root') && document.querySelector('#dc-root').childElementCount > 0; },

    // ---- element addressing: owner + tpl + nth (among elements with same owner/tpl) ----
    address(el) {
      const tpl = el.getAttribute('data-dc-tpl');
      if (tpl == null) return null;
      const owner = this.owner(el);
      const same = [...document.querySelectorAll(`[data-dc-tpl="${tpl}"]`)].filter(e => this.owner(e) === owner);
      return { owner, tpl: Number(tpl), nth: same.indexOf(el) };
    },
    find(owner, tpl, nth) {
      const same = [...document.querySelectorAll(`[data-dc-tpl="${tpl}"]`)].filter(e => !owner || this.owner(e) === owner);
      return same[nth || 0] || same.find(e => this.vis(e)) || same[0] || null;
    },

    // ---- highlight overlay ----
    // mode: 'border' (dashed outline around it), 'highlight' (tinted fill over its box), 'none'
    highlight(el, { scroll = true, color = '#ff2bd6', mode = 'border' } = {}) {
      this.unhighlight();
      if (!el) return null;
      if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (mode === 'none') return r;
      const box = document.createElement('div');
      box.id = '__dcv-hl';
      const base = { position: 'fixed', pointerEvents: 'none', zIndex: 2147483647 };
      if (mode === 'highlight') {
        Object.assign(box.style, base, {
          left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px',
          background: 'rgba(255, 43, 214, 0.28)', borderRadius: getComputedStyle(el).borderRadius,
        });
      } else {
        Object.assign(box.style, base, {
          left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px',
          outline: `2px dashed ${color}`, outlineOffset: '0', borderRadius: '4px',
        });
      }
      document.body.appendChild(box);
      return r;
    },
    unhighlight() { const b = document.getElementById('__dcv-hl'); if (b) b.remove(); },

    // ---- component candidates ----
    // One record per (owner, tpl, signature) for styled/interactive elements. The signature is the
    // element's own look (kind, size class, radius, fill, border, shadow, text style, icon), so
    // identical-looking elements across pages cluster into one suggested component.
    componentCandidates() {
      const out = new Map();
      const counters = new Map();
      for (const el of document.querySelectorAll('#dc-root [data-dc-tpl]')) {
        const tpl = el.getAttribute('data-dc-tpl'), owner = this.owner(el), ck = owner + '|' + tpl;
        const nth = counters.get(ck) || 0; counters.set(ck, nth + 1);
        if (!this.vis(el)) continue;
        const cs = getComputedStyle(el), r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || (r.width > innerWidth * 0.7 && r.height > 300)) continue;
        const tag = el.tagName.toLowerCase();
        const bg = transparent(cs.backgroundColor) ? null : normColor(cs.backgroundColor);
        const grad = /gradient\(/.test(cs.backgroundImage);
        const bw = ['Top', 'Right', 'Bottom', 'Left'].filter(s => px(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none' && !transparent(cs[`border${s}Color`]));
        const border = bw.length === 4 ? `${cs.borderTopWidth} ${normColor(cs.borderTopColor)}` : bw.length ? 'partial' : null;
        const shadow = cs.boxShadow !== 'none';
        const rad = px(cs.borderTopLeftRadius);
        const radius = rad >= Math.min(r.width, r.height) / 2 - 1 && rad > 0 ? (Math.abs(r.width - r.height) < 2 ? 'circle' : 'pill') : rad ? `${Math.round(rad)}px` : '0';
        const interactive = ['button', 'a', 'input', 'select', 'textarea', 'label'].includes(tag) || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab' || el.hasAttribute('onclick') || cs.cursor === 'pointer';
        const styled = bg || grad || border || shadow;
        if (!styled && !['input', 'select', 'textarea'].includes(tag)) continue;
        if (!interactive && !styled) continue;
        const text = (el.innerText || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim();
        const hasIcon = !!el.querySelector(':scope > svg, :scope > img, :scope > * > svg, :scope > i');
        const hasImg = tag === 'img' || !!el.querySelector(':scope > img');
        // category
        let cat;
        if (['input', 'select', 'textarea'].includes(tag) || (el.querySelector(':scope > input, :scope > textarea') && r.height <= 64)) cat = 'Input';
        else if (tag === 'img' && (radius === 'circle') && r.width <= 64) cat = 'Avatar';
        else if (el.getAttribute('role') === 'tab') cat = 'Tab';
        else if (interactive && !text && hasIcon && r.width <= 56 && r.height <= 56) cat = 'Icon button';
        else if (interactive && text && r.height <= 36 && radius === 'pill' && !grad && (!bg || /#f|#e/.test(bg))) cat = 'Chip';
        else if (interactive && text && r.height <= 64 && r.width <= 420) cat = 'Button';
        else if (!interactive && text && r.height <= 26 && r.width <= 160 && (bg || grad)) cat = 'Badge';
        else if (r.height >= 60 && r.width >= 120 && (bg || border || shadow) && rad > 0) cat = interactive ? 'Card (clickable)' : 'Card';
        else if (interactive && r.height <= 64) cat = 'Control';
        else continue;
        const h = cat.startsWith('Card') ? null : Math.round(r.height / 2) * 2;
        const font = text && !cat.startsWith('Card') ? `${cs.fontSize}/${cs.fontWeight}` : null;
        // exact look (a variant) and a coarse family key (the suggested component)
        const exact = [cat, h, radius, bg, grad ? 'gradient' : null, border, shadow ? 'shadow' : null, font, hasIcon && cat !== 'Icon button' ? 'icon' : null].join('|');
        const fillKind = grad ? 'gradient' : !bg ? 'none' : (() => {
          const m = bg.match(/^#(..)(..)(..)/); const [R, G, B] = m.slice(1).map(x => parseInt(x, 16));
          const sat = Math.max(R, G, B) - Math.min(R, G, B);
          return sat < 24 ? 'neutral' : (R + G + B) / 3 > 200 ? 'tint' : 'brand';
        })();
        const radBucket = radius === 'pill' || radius === 'circle' ? radius : rad === 0 ? 'square' : rad <= 6 ? 'small' : rad <= 12 ? 'medium' : rad <= 20 ? 'large' : 'xl';
        const hB = h == null ? null : Math.round(h / 4) * 4;
        const fs = text && !cat.startsWith('Card') ? Math.round(px(cs.fontSize) / 2) * 2 : null;
        const fw = fs ? (Number(cs.fontWeight) >= 700 ? 'bold' : Number(cs.fontWeight) >= 500 ? 'medium' : 'regular') : null;
        const sig = [cat, hB, radBucket, fillKind, border ? 'border' : null, shadow ? 'shadow' : null, fs && `${fs}px ${fw}`].join('|');
        const key = ck + '|' + sig;
        const hit = out.get(key);
        if (hit) { hit.instances++; continue; }
        const lab = el.closest('[data-screen-label]');
        out.set(key, {
          sig, exact, cat, owner, tpl: Number(tpl), nth, instances: 1,
          family: { height: hB, radius: radBucket, fill: fillKind, border: !!border, shadow, text: fs ? `${fs}px ${fw}` : null },
          spec: { height: h, radius, bg, gradient: grad, border, shadow, font, icon: hasIcon, image: hasImg, width: Math.round(r.width) },
          text: text.slice(0, 40), component: lab ? lab.dataset.screenLabel : null, tag,
        });
      }
      return [...out.values()];
    },

    // ---- survey collection ----
    // Returns one record per (owner, tpl, value) visible in the current state.
    collect(presetId) {
      const preset = PRESETS[presetId];
      if (!preset) throw new Error('unknown preset ' + presetId + '. Known: ' + Object.keys(PRESETS).join(', '));
      const seen = new Map();
      const counters = new Map(); // owner|tpl -> running nth
      for (const el of document.querySelectorAll('#dc-root [data-dc-tpl]')) {
        const tpl = el.getAttribute('data-dc-tpl');
        const owner = this.owner(el);
        const ck = owner + '|' + tpl;
        const nth = counters.get(ck) || 0;
        counters.set(ck, nth + 1);
        if (el.closest('#__dcv-hl')) continue;
        if (!this.vis(el)) continue;
        const cs = getComputedStyle(el);
        let raw;
        try { raw = preset.value(el, cs); } catch { raw = null; }
        if (raw == null) continue;
        const recs = preset.multi ? raw : [{ value: raw, props: null }];
        for (const { value, props } of recs) {
        const key = ck + '|' + value;
        const hit = seen.get(key);
        if (hit) { hit.instances++; continue; }
        const d = declared(el, props && preset.declaredFor ? { ...preset, declared: preset.declaredFor(props) } : preset);
        const lab = el.closest('[data-screen-label]');
        const r = el.getBoundingClientRect();
        seen.set(key, {
          value, props, owner, tpl: Number(tpl), nth, instances: 1,
          declared: d ? d.value : null, declaredProp: d ? d.prop : null, declaredFrom: d ? d.from : null, inheritedFrom: d ? d.inheritedFrom || null : null,
          tokens: d ? [...new Set((d.value.match(/--[\w-]+/g) || []))] : [],
          component: lab ? lab.dataset.screenLabel : null,
          tag: el.tagName.toLowerCase(),
          text: (ownText(el) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').slice(0, 80),
          size: [Math.round(r.width), Math.round(r.height)],
        });
        }
      }
      return [...seen.values()];
    },
  };
  window.__dcv = api;
})();
