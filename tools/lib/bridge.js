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
        let value;
        try { value = preset.value(el, cs); } catch { value = null; }
        if (value == null) continue;
        const key = ck + '|' + value;
        const hit = seen.get(key);
        if (hit) { hit.instances++; continue; }
        const d = declared(el, preset);
        const lab = el.closest('[data-screen-label]');
        const r = el.getBoundingClientRect();
        seen.set(key, {
          value, owner, tpl: Number(tpl), nth, instances: 1,
          declared: d ? d.value : null, declaredProp: d ? d.prop : null, declaredFrom: d ? d.from : null, inheritedFrom: d ? d.inheritedFrom || null : null,
          tokens: d ? [...new Set((d.value.match(/--[\w-]+/g) || []))] : [],
          component: lab ? lab.dataset.screenLabel : null,
          tag: el.tagName.toLowerCase(),
          text: (ownText(el) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').slice(0, 80),
          size: [Math.round(r.width), Math.round(r.height)],
        });
      }
      return [...seen.values()];
    },
  };
  window.__dcv = api;
})();
