// Browser-side helpers for design-project pages. Loaded two ways:
//   - Playwright: page.addInitScript({ path }) (tools/lib/render.mjs)
//   - Viewer:     injected into the same-origin iframe (tools/viewer/view.html)
// Exposes window.__dcv.
(function () {
  if (window.__dcv) return;

  const fiberOf = el => { const k = Object.keys(el).find(k => k.startsWith('__reactFiber$')); return k ? el[k] : null; };

  const api = {
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
    // mode: 'border' (dashed outline), 'highlight' (tinted fill over its box), 'find' (huge bouncing
    // arrow pointing at it plus a pulsing ring), 'none'. Called every frame by the viewer to follow
    // the element, so the overlay is updated in place (recreating it would restart the animations).
    highlight(el, { scroll = true, color = '#ff2bd6', mode = 'border' } = {}) {
      if (!el) { this.unhighlight(); return null; }
      if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (mode === 'none') { this.unhighlight(); return r; }
      let box = document.getElementById('__dcv-hl');
      if (box && box.dataset.mode !== mode) { box.remove(); box = null; }
      if (!box) {
        box = document.createElement('div');
        box.id = '__dcv-hl';
        box.dataset.mode = mode;
        Object.assign(box.style, { position: 'fixed', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none', zIndex: 2147483647 });
        if (mode === 'find') {
          box.innerHTML = `
            <style>
              @keyframes __dcv-bob { 0%,100% { transform: translate(-50%, 0) } 50% { transform: translate(-50%, -18px) } }
              @keyframes __dcv-bob-up { 0%,100% { transform: translate(-50%, 0) rotate(180deg) } 50% { transform: translate(-50%, 18px) rotate(180deg) } }
              @keyframes __dcv-ring { 0% { box-shadow: 0 0 0 0 ${color}cc, 0 0 0 4px ${color} } 100% { box-shadow: 0 0 0 28px ${color}00, 0 0 0 4px ${color} } }
            </style>
            <div data-ring style="position:fixed;border-radius:6px;animation:__dcv-ring 1.1s ease-out infinite"></div>
            <svg data-arrow width="96" height="132" viewBox="0 0 96 132" style="position:fixed;overflow:visible;filter:drop-shadow(0 6px 10px rgba(0,0,0,.45))">
              <path d="M30 4 h36 v72 h26 L48 128 L4 76 h26 Z" fill="${color}" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
            </svg>`;
        }
        document.body.appendChild(box);
      }
      if (mode === 'highlight') {
        Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px',
          background: 'rgba(255, 43, 214, 0.28)', borderRadius: getComputedStyle(el).borderRadius });
      } else if (mode === 'find') {
        const ring = box.querySelector('[data-ring]'), arrow = box.querySelector('[data-arrow]');
        Object.assign(ring.style, { left: r.left - 6 + 'px', top: r.top - 6 + 'px', width: r.width + 12 + 'px', height: r.height + 12 + 'px' });
        // above the element pointing down; below pointing up when there isn't room above
        const cx = Math.min(Math.max(r.left + r.width / 2, 52), innerWidth - 52);
        const above = r.top > 150;
        arrow.style.left = cx + 'px';
        arrow.style.top = (above ? r.top - 146 : r.bottom + 14) + 'px';
        const anim = above ? '__dcv-bob' : '__dcv-bob-up';
        if (arrow.dataset.anim !== anim) { arrow.dataset.anim = anim; arrow.style.animation = `${anim} .9s ease-in-out infinite`; }
      } else {
        Object.assign(box.style, { left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px',
          outline: `2px dashed ${color}`, outlineOffset: '0', borderRadius: '4px' });
      }
      return r;
    },
    unhighlight() { const b = document.getElementById('__dcv-hl'); if (b) b.remove(); },
  };
  window.__dcv = api;
})();
