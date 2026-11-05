// Live collaboration: presence pill + decision toasts, over server-sent events (/api/live).
// Each browser gets a stable id and a friendly random name (localStorage). Pages call
// startLive() once; subscribe with onDecision((event, { mine }) => …) to apply changes made
// elsewhere. `mine` is true for your own change from another tab: apply it, but don't toast.

const ADJ = ['Amber', 'Teal', 'Coral', 'Indigo', 'Sage', 'Plum', 'Ochre', 'Slate', 'Rose', 'Mint', 'Navy', 'Olive', 'Peach', 'Cobalt', 'Saffron', 'Lilac'];
const ANIMAL = ['Fox', 'Otter', 'Heron', 'Lynx', 'Panda', 'Wren', 'Koala', 'Moose', 'Gecko', 'Badger', 'Falcon', 'Hare', 'Seal', 'Ibis', 'Yak', 'Robin'];

function store(key, make) {
  try { let v = localStorage.getItem(key); if (!v) { v = make(); localStorage.setItem(key, v); } return v; }
  catch { return make(); }
}
const pick = a => a[Math.floor(Math.random() * a.length)];
export const me = {
  client: store('dcv-client', () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2))),
  name: store('dcv-name', () => `${pick(ADJ)} ${pick(ANIMAL)}`),
  tab: String(Math.random()).slice(2, 12), // this page load only
};
// Headers that identify who saved a change (sent with every API call, see common.js).
export const liveHeaders = () => ({ 'x-client-id': me.client, 'x-client-name': encodeURIComponent(me.name), 'x-client-tab': me.tab });

const listeners = new Set();
export const onDecision = fn => listeners.add(fn);

let pill, toastEl, toastTimer, editor, started = false;

function ensureUi() {
  if (pill) return;
  const css = document.createElement('style');
  css.textContent = `
    .live-pill { position: fixed; right: 16px; bottom: 16px; z-index: 300; display: none; align-items: center; gap: 7px;
      padding: 6px 12px 6px 10px; border-radius: 999px; background: #ffd84d; color: #3a2e00; font: 600 12.5px/1 var(--sans, system-ui);
      box-shadow: 0 2px 10px rgba(0,0,0,.18); cursor: pointer; user-select: none; border: 0; }
    .live-pill:hover { background: #ffcf26; }
    .live-pill:focus-visible { outline: 2px solid #2f6bff; outline-offset: 2px; }
    .live-name { position: fixed; right: 16px; bottom: 54px; z-index: 301; display: none; align-items: center; gap: 6px; padding: 8px;
      border-radius: 10px; background: var(--panel, #fff); border: 1px solid var(--line-2, #d2d2cc); box-shadow: 0 6px 24px rgba(0,0,0,.18);
      font: 12.5px var(--sans, system-ui); color: var(--text, #1c1c1a); }
    .live-name.open { display: flex; }
    .live-name label { color: var(--muted, #6b6b66); }
    .live-name input { width: 170px; font: inherit; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--line-2, #d2d2cc); background: var(--bg, #fff); color: inherit; }
    .live-name button { font: inherit; font-weight: 600; padding: 5px 10px; border-radius: 6px; border: 0; background: #ffd84d; color: #3a2e00; cursor: pointer; }
    .live-pill.show { display: inline-flex; }
    .live-pill i { width: 7px; height: 7px; border-radius: 50%; background: #1f9d55; box-shadow: 0 0 0 2px rgba(31,157,85,.25); }
    .live-pill.bounce { animation: live-bounce .6s cubic-bezier(.28,.84,.42,1); }
    @keyframes live-bounce { 0%,100% { transform: translateY(0) } 30% { transform: translateY(-10px) } 55% { transform: translateY(0) } 75% { transform: translateY(-4px) } }
    .live-toast { position: fixed; right: 16px; bottom: 54px; z-index: 300; max-width: 320px; padding: 7px 12px; border-radius: 8px;
      background: var(--text, #1c1c1a); color: var(--bg, #fff); font: 12.5px/1.35 var(--sans, system-ui); box-shadow: 0 4px 16px rgba(0,0,0,.2);
      opacity: 0; transform: translateY(4px); transition: opacity .2s, transform .2s; pointer-events: none; }
    .live-toast.show { opacity: 1; transform: translateY(0); }`;
  document.head.appendChild(css);
  pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'live-pill';
  pill.addEventListener('animationend', () => pill.classList.remove('bounce'));
  pill.addEventListener('click', e => { e.stopPropagation(); editor.classList.contains('open') ? closeEditor() : openEditor(); });
  toastEl = document.createElement('div');
  toastEl.className = 'live-toast';
  // name editor, opened by clicking the pill
  editor = document.createElement('form');
  editor.className = 'live-name';
  editor.innerHTML = `<label for="live-name-in">Your name</label><input id="live-name-in" maxlength="40" autocomplete="off"><button type="submit">Save</button>`;
  editor.addEventListener('submit', e => { e.preventDefault(); rename(editor.querySelector('input').value); });
  editor.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeEditor(); } });
  editor.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => closeEditor());
  document.body.append(toastEl, editor, pill);
}

function openEditor() {
  const input = editor.querySelector('input');
  input.value = me.name;
  editor.classList.add('open');
  toastEl.classList.remove('show');
  input.focus();
  input.select();
}
function closeEditor() { editor?.classList.remove('open'); }

async function rename(raw) {
  const name = String(raw).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
  closeEditor();
  if (!name || name === me.name) return;
  me.name = name;
  try { localStorage.setItem('dcv-name', name); } catch { }
  try {
    await fetch('/api/live/name', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-client-id': me.client }, body: JSON.stringify({ name }) });
  } catch { }
}

function renderPresence({ online, people }) {
  ensureUi();
  // another tab of this browser renamed us: adopt it
  const self = people.find(p => p.client === me.client);
  if (self && self.name !== me.name) me.name = self.name;
  pill.innerHTML = `<i></i>${online} online`;
  pill.title = people.map(p => (p.client === me.client ? `${p.name} (you)` : p.name)).join('\n') + '\n\nClick to change your name';
  pill.classList.toggle('show', online > 1);
}

export function liveToast(msg) {
  ensureUi();
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
  if (pill.classList.contains('show')) { pill.classList.remove('bounce'); void pill.offsetWidth; pill.classList.add('bounce'); }
}

export function startLive() {
  // pages embedded in a popover share the parent's connection
  if (started || window.parent !== window) return;
  started = true;
  const es = new EventSource(`/api/live?client=${encodeURIComponent(me.client)}&name=${encodeURIComponent(me.name)}`);
  es.addEventListener('presence', e => renderPresence(JSON.parse(e.data)));
  es.addEventListener('decision', e => {
    const d = JSON.parse(e.data);
    if (d.by?.tab === me.tab) return; // made in this tab, already applied
    const mine = d.by?.client === me.client;
    for (const fn of listeners) { try { fn(d, { mine }); } catch (err) { console.error(err); } }
  });
}

// Default toast text for a decision event; pages can pass refs (e.g. "S3.4") for precision.
export function describeDecision(d, refs) {
  const verb = { keep: 'kept', round: 'rounded', exclude: 'excluded' }[d.decision] || (d.decision === null ? 'cleared' : 'updated');
  const what = refs?.length === 1 ? refs[0] : `${d.ids.length} usage${d.ids.length === 1 ? '' : 's'}`;
  const to = d.decision === 'round' && d.ids.length === 1 ? ` → ${d.decisions[d.ids[0]]?.round?.to}` : '';
  return `${d.by?.name || 'Someone'} ${verb} ${what}${to} in ${d.title}`;
}
