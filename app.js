'use strict';
/* =====================================================================
   Invoices PWA — offline invoicing (IndexedDB + pdf-lib + pdf.js)
   To publish an update: bump APP_VERSION here AND VERSION in sw.js.
   ===================================================================== */
const APP_VERSION = '1.0.1';

/* ---------------------------------------------------------------------
   CORE: pure logic (money, VAT, dates, numbering, PDF text extraction)
   --------------------------------------------------------------------- */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const Core = {
  /** Rand/decimal text -> integer cents. Accepts "1,400.50", "1 400,50", "R700". */
  toCents(v) {
    if (typeof v === 'number') return Math.round(v * 100 + (v >= 0 ? 1e-7 : -1e-7));
    const c = Core.parseMoney(v);
    return c == null ? 0 : c;
  },
  parseMoney(s) {
    if (s == null) return null;
    let t = String(s).replace(/[\s ]/g, '').replace(/[^\d.,\-]/g, '');
    if (!/\d/.test(t)) return null;
    const neg = t.startsWith('-');
    t = t.replace(/-/g, '');
    if (/,\d{1,2}$/.test(t) && !/\.\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); // decimal comma
    else t = t.replace(/,/g, '');
    const parts = t.split('.');
    if (parts.length > 2) t = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
    const n = parseFloat(t);
    if (!isFinite(n)) return null;
    const c = Math.round(n * 100 + 1e-7);
    return neg ? -c : c;
  },
  /** cents -> "R1,400.00" */
  money(cents, sym) {
    sym = sym == null ? 'R' : sym;
    const neg = cents < 0;
    const s = (Math.abs(Math.round(cents || 0)) / 100).toFixed(2);
    const [i, d] = s.split('.');
    return (neg ? '-' : '') + sym + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + d;
  },
  num(v) { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; },
  qtyText(q) { const n = Core.num(q); return String(Math.round(n * 1000) / 1000); },
  /** line amount in cents after its % discount */
  lineTotal(l) {
    const qty = Core.num(l.qty), price = Math.round(l.price || 0), disc = Math.min(100, Math.max(0, Core.num(l.disc)));
    const gross = Math.round(qty * price + 1e-7);
    const d = Math.round(gross * disc / 100 + 1e-7);
    return gross - d;
  },
  totals(lines, vatOn, rate) {
    const subtotal = (lines || []).reduce((a, l) => a + Core.lineTotal(l), 0);
    const vat = vatOn ? Math.round(subtotal * Core.num(rate) / 100 + 1e-7) : 0;
    return { subtotal, vat, total: subtotal + vat };
  },
  pad2(n) { return String(n).padStart(2, '0'); },
  todayISO() { const d = new Date(); return d.getFullYear() + '-' + Core.pad2(d.getMonth() + 1) + '-' + Core.pad2(d.getDate()); },
  addDays(iso, n) {
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y || !m || !d) return iso;
    const dt = new Date(Date.UTC(y, m - 1, d + (parseInt(n, 10) || 0)));
    return dt.getUTCFullYear() + '-' + Core.pad2(dt.getUTCMonth() + 1) + '-' + Core.pad2(dt.getUTCDate());
  },
  /** "2026-08-13" -> "Aug 13, 2026" (same style as the sample invoice) */
  fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    return MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1];
  },
  norm(s) { return String(s || '').trim().toLowerCase(); },
  /** Next free invoice number: last used + 1, skipping any number already taken. Keeps zero padding. */
  nextNumber(settings, invoices) {
    const last = String(settings.lastNumber == null ? '0' : settings.lastNumber).trim() || '0';
    const pad = /^0\d/.test(last) ? last.length : 0;
    const prefix = settings.prefix || '';
    const fmt = (n) => prefix + (pad ? String(n).padStart(pad, '0') : String(n));
    const used = new Set((invoices || []).map((i) => Core.norm(i.number)));
    let n = (parseInt(last, 10) || 0) + 1;
    while (used.has(Core.norm(fmt(n)))) n++;
    return fmt(n);
  },
  /** If number = current prefix + digits and is higher than "last used", raise "last used". */
  bumpLast(settings, number) {
    const prefix = settings.prefix || '';
    const num = String(number || '').trim();
    if (!num.toLowerCase().startsWith(prefix.toLowerCase())) return false;
    const rest = num.slice(prefix.length);
    if (!/^\d+$/.test(rest)) return false;
    if (parseInt(rest, 10) > (parseInt(settings.lastNumber, 10) || 0)) { settings.lastNumber = rest; return true; }
    return false;
  },
  trailingInt(s) { const m = /(\d+)\D*$/.exec(String(s || '')); return m ? parseInt(m[1], 10) : null; },
  isDuplicate(number, invoices, exceptId) {
    const n = Core.norm(number);
    return (invoices || []).some((i) => i.id !== exceptId && Core.norm(i.number) === n);
  },
  /** Find the first date anywhere in a string. Day-first for numeric dates (SA style). */
  parseDateLoose(s) {
    s = String(s || '');
    const mon = (t) => { const i = MONTHS.findIndex((m) => t.slice(0, 3).toLowerCase() === m.toLowerCase()); return i < 0 ? 0 : i + 1; };
    const ok = (y, m, d) => (y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31) ? y + '-' + Core.pad2(m) + '-' + Core.pad2(d) : null;
    let m;
    if ((m = /(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(s))) return ok(+m[1], +m[2], +m[3]);
    if ((m = /(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/.exec(s))) return ok(+m[3], +m[2], +m[1]);
    if ((m = /(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([A-Za-z]{3,9})\.?,?[\s\-]+(\d{4})/.exec(s)) && mon(m[2])) return ok(+m[3], mon(m[2]), +m[1]);
    if ((m = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s)) && mon(m[1])) return ok(+m[3], mon(m[1]), +m[2]);
    return null;
  },
  /**
   * Guess invoice number, date, customer and total from PDF text items.
   * items: [{str, x, y(top-down, pages stacked), h}]
   */
  extract(items) {
    items = (items || []).filter((i) => i.str && i.str.trim()).map((i) => ({ ...i, str: i.str.trim() }));
    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const ln = lines.length && Math.abs(lines[lines.length - 1].y - it.y) <= 3 ? lines[lines.length - 1] : null;
      if (ln) ln.items.push(it); else lines.push({ y: it.y, items: [it] });
    }
    lines.forEach((l) => { l.items.sort((a, b) => a.x - b.x); l.text = l.items.map((i) => i.str).join(' '); });

    const LABEL = /^(bill(ed)?\s*to|ship\s*to|invoice|tax invoice|issued|date|due|total|sub\s*-?total|amount|balance|vat|tax|qty|quantity|price|item|description|page|from|payment|po\b|order|ref(erence)?\b|account|bank|phone|tel|email|terms)/i;
    const MONEY_RE = /[-(]?(?:[R$€£]\s?)?\d[\d ,. ]*\d/g;
    const nearValue = (label, test, preferBelow) => {
      const right = items.filter((i) => i !== label && Math.abs(i.y - label.y) <= 6 && i.x > label.x + 1).sort((a, b) => a.x - b.x);
      const below = items.filter((i) => i !== label && i.y > label.y + 2 && i.y < label.y + 40 && Math.abs(i.x - label.x) < 60)
        .sort((a, b) => (a.y - b.y) || (Math.abs(a.x - label.x) - Math.abs(b.x - label.x)));
      const order = preferBelow ? [below, right] : [right, below];
      for (const group of order) for (const i of group) { if (test(i.str)) return i.str; if (preferBelow && group === below) break; }
      return '';
    };
    const out = { number: '', date: '', customer: '', total: null };

    // --- invoice number
    const isNum = (s) => {
      const t = s.replace(/^#\s*/, '');
      return /\d/.test(t) && /^[A-Z0-9][A-Z0-9\-\/._]*$/i.test(t) && t.length <= 24 && !Core.parseDateLoose(t);
    };
    const numLabel = /^(?:tax\s+)?(?:invoice|inv)\s*(?:number|no\.?|num\.?|#)\s*:?\s*(.*)$/i;
    for (const it of items) {
      const m = numLabel.exec(it.str);
      if (!m) continue;
      if (m[1] && isNum(m[1])) { out.number = m[1].replace(/^#\s*/, ''); break; }
      const v = nearValue(it, isNum, false);
      if (v) { out.number = v.replace(/^#\s*/, ''); break; }
    }
    if (!out.number) {
      for (const l of lines) {
        const m = /(?:invoice|inv)\s*(?:number|no\.?|num\.?|#)?\s*[:#]?\s*([A-Z]{0,6}[-\/]?\d[A-Z0-9\-\/]*)/i.exec(l.text);
        if (m && isNum(m[1])) { out.number = m[1]; break; }
      }
    }

    // --- invoice date
    const dateLabel = /(?:^|[^a-z])(invoice\s*date|date\s*issued|issue\s*date|issued\s*on|issued|date\s*of\s*issue|date)\b\s*:?\s*(.*)$/i;
    for (const l of lines) {
      const m = dateLabel.exec(l.text);
      if (!m) continue;
      const before = l.text.slice(0, m.index + m[0].indexOf(m[1])).toLowerCase();
      if (/due\s*$/.test(before) || /^due/i.test(m[1])) continue;
      const d = Core.parseDateLoose(m[2]);
      if (d) { out.date = d; break; }
    }
    if (!out.date) {
      for (const it of items) {
        if (!/^(invoice\s*date|date\s*issued|issue\s*date|issued|date)\s*:?$/i.test(it.str)) continue;
        const v = nearValue(it, (s) => !!Core.parseDateLoose(s), false);
        if (v) { out.date = Core.parseDateLoose(v); break; }
      }
    }
    if (!out.date) for (const l of lines) { if (/due/i.test(l.text)) continue; const d = Core.parseDateLoose(l.text); if (d) { out.date = d; break; } }

    // --- customer
    const custLabel = /^(?:bill(?:ed)?\s*to|invoice\s*to|sold\s*to|customer|client)\s*:?\s*(.*)$/i;
    const isName = (s) => s.length > 1 && /[A-Za-z]{2,}/.test(s) && !LABEL.test(s) && !/@/.test(s);
    for (const it of items) {
      const m = custLabel.exec(it.str);
      if (!m) continue;
      if (m[1] && isName(m[1])) { out.customer = m[1]; break; }
      const v = nearValue(it, isName, true);
      if (v) { out.customer = v; break; }
    }

    // --- total (most specific label wins, last occurrence)
    const totalLabels = [/amount\s*due/i, /balance\s*due/i, /total\s*due/i, /amount\s*payable/i, /grand\s*total/i, /total\s*(?:incl|inc)/i, /\btotal\b/i];
    for (const re of totalLabels) {
      for (let k = lines.length - 1; k >= 0; k--) {
        const t = lines[k].text;
        const m = re.exec(t);
        if (!m) continue;
        if (re.source === '\\btotal\\b' && (/sub\s*-?\s*total/i.test(t) || /total\s*(vat|tax)/i.test(t))) continue;
        const after = t.slice(m.index + m[0].length);
        const vals = (after.match(MONEY_RE) || []).map(Core.parseMoney).filter((v) => v != null);
        if (vals.length) { out.total = vals[vals.length - 1]; break; }
      }
      if (out.total != null) break;
    }
    return out;
  }
};

if (typeof window === 'undefined') { module.exports = Core; }
else { window.Core = Core; boot(); }

function boot() {
/* Android app wrapper (APK) exposes window.AndroidApp; in a browser it's undefined */
const NATIVE = window.AndroidApp || null;
if (NATIVE) document.documentElement.classList.add('native-app');
/* ---------------------------------------------------------------------
   DATABASE (IndexedDB)
   --------------------------------------------------------------------- */
const STORES = ['settings', 'customers', 'items', 'invoices', 'files'];
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('invoice-app', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        for (const s of ['customers', 'items', 'invoices', 'files']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async run(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, mode);
      const st = tx.objectStore(store);
      let out;
      const req = fn(st);
      if (req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => res(out);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  },
  get(store, key) { return this.run(store, 'readonly', (s) => s.get(key)); },
  all(store) { return this.run(store, 'readonly', (s) => s.getAll()); },
  put(store, val) { return this.run(store, 'readwrite', (s) => s.put(val)); },
  del(store, key) { return this.run(store, 'readwrite', (s) => s.delete(key)); },
  clear(store) { return this.run(store, 'readwrite', (s) => s.clear()); }
};

const DEFAULT_SETTINGS = {
  key: 'main',
  company: { name: '', regNo: '', vatNo: '', address: '', postal: '', phone: '', email: '', website: '' },
  logo: null,
  bank: { name: '', holder: '', account: '', branch: '', type: '', reference: '' },
  vatEnabled: true, vatRate: 15, currency: 'R', terms: 30,
  notes: '', footer: 'Thank you for your business.',
  prefix: 'INV-', lastNumber: '0', theme: 'auto'
};
let S = null; // settings cache

async function loadSettings() {
  const s = await DB.get('settings', 'main');
  S = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), s || {});
  applyTheme();
  return S;
}
async function saveSettings() { await DB.put('settings', S); applyTheme(); }
function deepMerge(a, b) {
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') deepMerge(a[k], b[k]);
    else a[k] = b[k];
  }
  return a;
}
function applyTheme() {
  const t = S && S.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]').content = dark ? '#171E26' : '#1F4E79';
  $('#brandName').textContent = (S && S.company.name) || 'Invoices';
}

/* ---------------------------------------------------------------------
   UI HELPERS
   --------------------------------------------------------------------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
const money = (c, sym) => Core.money(c, sym == null ? (S ? S.currency : 'R') : sym);
const ICON = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 19h16"/></svg>',
  print: '<svg viewBox="0 0 24 24"><path d="M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 15V3m0 0L7 8m5-5l5 5M4 19h16"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>'
};

let toastTimer;
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2600);
}
function dialog(title, html, buttons) {
  return new Promise((resolve) => {
    $('#dialogTitle').textContent = title;
    $('#dialogText').innerHTML = html;
    const acts = $('#dialogActions');
    acts.innerHTML = '';
    buttons.forEach((b) => {
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'btn ' + (b.cls || ''); el.textContent = b.label;
      el.onclick = () => { $('#dialog').hidden = true; resolve(b.value); };
      acts.appendChild(el);
    });
    $('#dialog').hidden = false;
  });
}
const confirmBox = (title, text, okLabel, danger) =>
  dialog(title, '<p>' + text + '</p>', [{ label: 'Cancel', value: false }, { label: okLabel || 'OK', value: true, cls: danger ? 'danger' : 'primary' }]);
const alertBox = (title, html) => dialog(title, html, [{ label: 'OK', value: true, cls: 'primary' }]);

let sheetOnClose = null;
function openSheet(title, html, opts) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  $('#sheetBody').scrollTop = 0;
  $('.sheet').classList.toggle('full', !!(opts && opts.full));
  $('#sheet').hidden = false;
  sheetOnClose = (opts && opts.onClose) || null;
  return $('#sheetBody');
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheetBody').innerHTML = '';
  const f = sheetOnClose; sheetOnClose = null;
  if (f) f();
}
$('#sheetClose').onclick = closeSheet;
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

function field(label, name, value, type, extra) {
  type = type || 'text';
  if (type === 'textarea') return `<label class="field"><span>${esc(label)}</span><textarea name="${name}" ${extra || ''}>${esc(value)}</textarea></label>`;
  return `<label class="field"><span>${esc(label)}</span><input type="${type}" name="${name}" value="${esc(value)}" ${extra || ''}></label>`;
}
function formData(root) {
  const o = {};
  $$('input[name],textarea[name],select[name]', root).forEach((el) => { o[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
  return o;
}
function downloadBlob(blob, name) {
  if (NATIVE) {
    blob.arrayBuffer().then((buf) => NATIVE.saveFile(bufToB64(buf), name, blob.type || 'application/octet-stream'));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function safeName(s) { return String(s || 'invoice').replace(/[^\w.\-]+/g, '_'); }

/* ---------------------------------------------------------------------
   INVOICE STATUS / LOOKUPS
   --------------------------------------------------------------------- */
function statusOf(inv) {
  if (inv.state === 'draft') return 'draft';
  if (inv.status === 'paid') return 'paid';
  if (inv.status === 'overdue') return 'overdue';
  if (inv.due && inv.due < Core.todayISO()) return 'overdue';
  return 'unpaid';
}
const STATUS_LABEL = { draft: 'Draft', paid: 'Paid', unpaid: 'Unpaid', overdue: 'Overdue' };
function badge(inv) {
  const st = statusOf(inv);
  return `<span class="badge ${st}">${STATUS_LABEL[st]}</span>` + (inv.source === 'imported' ? ' <span class="badge imported">Imported</span>' : '');
}
function sortInvoices(list) {
  return list.sort((a, b) => (b.date || '').localeCompare(a.date || '') ||
    ((Core.trailingInt(b.number) || 0) - (Core.trailingInt(a.number) || 0)) || ((b.createdAt || 0) - (a.createdAt || 0)));
}
function invoiceRow(inv) {
  return `<button class="list-item" data-open="${inv.id}">
    <div class="main"><div class="t">${esc(inv.number)} · ${esc((inv.customer && inv.customer.name) || 'No customer')}</div>
    <div class="s">${esc(Core.fmtDate(inv.date))} ${badge(inv)}</div></div>
    <div class="amt">${money(inv.total, inv.currency)}</div></button>`;
}
function bindOpen(root) { $$('[data-open]', root).forEach((b) => { b.onclick = () => { location.hash = '#view/' + b.dataset.open; }; }); }

/* ---------------------------------------------------------------------
   ROUTER
   --------------------------------------------------------------------- */
const view = $('#view');
async function route() {
  const h = location.hash.replace(/^#/, '') || 'home';
  const [name, arg] = h.split('/');
  const tab = { home: 'home', invoices: 'invoices', view: 'invoices', edit: 'invoices', customers: 'customers', items: 'items', settings: 'settings' }[name] || 'home';
  $$('.bottomnav a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  if (!$('#sheet').hidden) closeSheet();
  window.scrollTo(0, 0);
  try {
    if (name === 'invoices') await renderInvoices();
    else if (name === 'customers') await renderCustomers();
    else if (name === 'items') await renderItems();
    else if (name === 'settings') await renderSettings();
    else if (name === 'edit') await renderEditor(arg);
    else if (name === 'view') await renderInvoiceView(arg);
    else await renderHome();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="card"><b>Something went wrong.</b><p class="muted small">${esc(e.message || e)}</p></div>`;
  }
}
window.addEventListener('hashchange', route);

/* ---------------------------------------------------------------------
   HOME
   --------------------------------------------------------------------- */
async function renderHome() {
  const invs = sortInvoices(await DB.all('invoices'));
  const month = Core.todayISO().slice(0, 7);
  let outstanding = 0, overdue = 0, paidMonth = 0;
  invs.forEach((i) => {
    const st = statusOf(i);
    if (st === 'unpaid' || st === 'overdue') outstanding += i.total || 0;
    if (st === 'overdue') overdue++;
    if (st === 'paid' && (i.paidAt || i.date || '').slice(0, 7) === month) paidMonth += i.total || 0;
  });
  const setup = !S.company.name;
  view.innerHTML = `
    ${setup ? `<div class="notice"><b>Welcome!</b> Start by adding your company, logo and banking details.<div class="spacer"></div><a class="btn primary block" href="#settings">Open Settings</a></div>` : ''}
    <button class="btn primary big block" id="hNew">${ICON.plus} New invoice</button>
    <div class="spacer"></div>
    <div class="stats">
      <div class="stat"><span>Outstanding</span><b>${money(outstanding)}</b></div>
      <div class="stat"><span>Overdue</span><b>${overdue}</b></div>
      <div class="stat"><span>Paid this month</span><b>${money(paidMonth)}</b></div>
    </div>
    <button class="btn block" id="hImport">${ICON.upload} Import old PDF invoices</button>
    <h3>Recent invoices</h3>
    <div class="list">${invs.slice(0, 6).map(invoiceRow).join('') || '<div class="empty">No invoices yet.</div>'}</div>
    ${invs.length > 6 ? '<div class="spacer"></div><a class="btn block" href="#invoices">See all invoices</a>' : ''}`;
  $('#hNew').onclick = () => { location.hash = '#edit/new'; };
  $('#hImport').onclick = () => $('#pickPdf').click();
  bindOpen(view);
}

/* ---------------------------------------------------------------------
   INVOICE LIST
   --------------------------------------------------------------------- */
let invFilter = 'all', invQuery = '';
async function renderInvoices() {
  const all = sortInvoices(await DB.all('invoices'));
  view.innerHTML = `
    <div class="title-row"><h1>Invoices</h1><button class="btn primary sm" id="iNew">${ICON.plus} New</button></div>
    <div class="search">${ICON.search}<input type="search" id="iq" placeholder="Search number, customer or date" value="${esc(invQuery)}"></div>
    <div class="chips">${['all', 'unpaid', 'overdue', 'paid', 'draft'].map((f) => `<button class="chip ${f === invFilter ? 'on' : ''}" data-f="${f}">${f === 'all' ? 'All' : STATUS_LABEL[f] + (f === 'draft' ? 's' : '')}</button>`).join('')}</div>
    <div class="list" id="iList"></div>
    <div class="spacer"></div>
    <button class="btn block" id="iImport">${ICON.upload} Import old PDF invoices</button>`;
  const draw = () => {
    const q = Core.norm(invQuery);
    const list = all.filter((i) => {
      if (invFilter !== 'all' && statusOf(i) !== invFilter) return false;
      if (!q) return true;
      const d = i.date || '';
      const hay = [i.number, i.customer && i.customer.name, d, Core.fmtDate(d), d.split('-').reverse().join('/'), i.po, i.ref].join(' ').toLowerCase();
      return hay.includes(q);
    });
    $('#iList').innerHTML = list.map(invoiceRow).join('') || '<div class="empty">No invoices found.</div>';
    bindOpen($('#iList'));
  };
  draw();
  $('#iq').oninput = (e) => { invQuery = e.target.value; draw(); };
  $$('.chip', view).forEach((c) => { c.onclick = () => { invFilter = c.dataset.f; $$('.chip', view).forEach((x) => x.classList.toggle('on', x === c)); draw(); }; });
  $('#iNew').onclick = () => { location.hash = '#edit/new'; };
  $('#iImport').onclick = () => $('#pickPdf').click();
}

/* ---------------------------------------------------------------------
   CUSTOMERS
   --------------------------------------------------------------------- */
let custQuery = '';
async function renderCustomers() {
  const all = (await DB.all('customers')).sort((a, b) => a.name.localeCompare(b.name));
  view.innerHTML = `
    <div class="title-row"><h1>Customers</h1><button class="btn primary sm" id="cNew">${ICON.plus} Add</button></div>
    <div class="search">${ICON.search}<input type="search" id="cq" placeholder="Search customers" value="${esc(custQuery)}"></div>
    <div class="list" id="cList"></div>`;
  const draw = () => {
    const q = Core.norm(custQuery);
    const list = all.filter((c) => !q || [c.name, c.contact, c.phone, c.email, c.vatNo].join(' ').toLowerCase().includes(q));
    $('#cList').innerHTML = list.map((c) => `<button class="list-item" data-id="${c.id}"><div class="main"><div class="t">${esc(c.name)}</div><div class="s">${esc([c.contact, c.phone, c.email].filter(Boolean).join(' · ') || ' ')}</div></div>${ICON.chev}</button>`).join('') ||
      `<div class="empty">${all.length ? 'No matches.' : 'No customers yet. Tap Add to create one.'}</div>`;
    $$('[data-id]', $('#cList')).forEach((b) => { b.onclick = () => customerForm(all.find((c) => c.id === b.dataset.id), () => route()); });
  };
  draw();
  $('#cq').oninput = (e) => { custQuery = e.target.value; draw(); };
  $('#cNew').onclick = () => customerForm(null, () => route());
}
function customerForm(c, onSaved) {
  const isNew = !c;
  c = c || { id: uid(), name: '', contact: '', phone: '', email: '', address: '', vatNo: '', notes: '' };
  const body = openSheet(isNew ? 'New customer' : 'Edit customer', `
    ${field('Company / customer name *', 'name', c.name)}
    ${field('Contact person', 'contact', c.contact)}
    <div class="grid2">${field('Phone', 'phone', c.phone, 'tel')}${field('Email', 'email', c.email, 'email')}</div>
    ${field('Physical address', 'address', c.address, 'textarea')}
    ${field('VAT number', 'vatNo', c.vatNo)}
    ${field('Notes', 'notes', c.notes, 'textarea')}
    <div class="btn-row"><button class="btn primary" id="fSave">Save</button>${isNew ? '' : `<button class="btn danger" id="fDel">${ICON.trash} Delete</button>`}</div>`);
  $('#fSave', body).onclick = async () => {
    const d = formData(body);
    if (!d.name) { toast('Customer name is required'); return; }
    Object.assign(c, d, { updatedAt: Date.now() });
    await DB.put('customers', c);
    closeSheet(); toast('Customer saved');
    if (onSaved) onSaved(c);
  };
  if (!isNew) $('#fDel', body).onclick = async () => {
    if (!(await confirmBox('Delete customer?', `Delete <b>${esc(c.name)}</b>? Existing invoices keep their copy of the details.`, 'Delete', true))) return;
    await DB.del('customers', c.id);
    closeSheet(); toast('Customer deleted');
    if (onSaved) onSaved(null);
  };
}

/* ---------------------------------------------------------------------
   EQUIPMENT / ITEMS
   --------------------------------------------------------------------- */
let itemQuery = '';
const UNITS = ['each', 'hour', 'day', 'week', 'month', 'metre', 'km', 'kg', 'litre', 'set', 'job'];
async function renderItems() {
  const all = (await DB.all('items')).sort((a, b) => (a.description || '').localeCompare(b.description || ''));
  view.innerHTML = `
    <div class="title-row"><h1>Equipment</h1><button class="btn primary sm" id="eNew">${ICON.plus} Add</button></div>
    <div class="search">${ICON.search}<input type="search" id="eq" placeholder="Search code or description" value="${esc(itemQuery)}"></div>
    <div class="list" id="eList"></div>`;
  const draw = () => {
    const q = Core.norm(itemQuery);
    const list = all.filter((i) => !q || [i.code, i.description, i.notes].join(' ').toLowerCase().includes(q));
    $('#eList').innerHTML = list.map((i) => `<button class="list-item" data-id="${i.id}"><div class="main"><div class="t">${esc(i.description)}</div><div class="s">${esc([i.code, 'per ' + (i.unit || 'each')].filter(Boolean).join(' · '))}</div></div><div class="amt">${money(i.price)}</div></button>`).join('') ||
      `<div class="empty">${all.length ? 'No matches.' : 'No equipment yet. Tap Add to create one.'}</div>`;
    $$('[data-id]', $('#eList')).forEach((b) => { b.onclick = () => itemForm(all.find((x) => x.id === b.dataset.id), () => route()); });
  };
  draw();
  $('#eq').oninput = (e) => { itemQuery = e.target.value; draw(); };
  $('#eNew').onclick = () => itemForm(null, () => route());
}
function itemForm(it, onSaved) {
  const isNew = !it;
  it = it || { id: uid(), code: '', description: '', unit: 'each', price: 0, notes: '' };
  const body = openSheet(isNew ? 'New item' : 'Edit item', `
    ${field('Item code', 'code', it.code)}
    ${field('Description *', 'description', it.description)}
    <div class="grid2">
      <label class="field"><span>Unit</span><input type="text" name="unit" list="unitList" value="${esc(it.unit)}"></label>
      ${field('Unit price excl. VAT (' + S.currency + ')', 'price', it.price ? (it.price / 100).toFixed(2) : '', 'text', 'inputmode="decimal"')}
    </div>
    <datalist id="unitList">${UNITS.map((u) => `<option value="${u}">`).join('')}</datalist>
    ${field('Notes (printed under the item on invoices)', 'notes', it.notes, 'textarea')}
    <div class="btn-row"><button class="btn primary" id="fSave">Save</button>${isNew ? '' : `<button class="btn danger" id="fDel">${ICON.trash} Delete</button>`}</div>`);
  $('#fSave', body).onclick = async () => {
    const d = formData(body);
    if (!d.description) { toast('Description is required'); return; }
    Object.assign(it, d, { price: Core.toCents(d.price), unit: d.unit || 'each', updatedAt: Date.now() });
    await DB.put('items', it);
    closeSheet(); toast('Item saved');
    if (onSaved) onSaved(it);
  };
  if (!isNew) $('#fDel', body).onclick = async () => {
    if (!(await confirmBox('Delete item?', `Delete <b>${esc(it.description)}</b>? Existing invoices are not changed.`, 'Delete', true))) return;
    await DB.del('items', it.id);
    closeSheet(); toast('Item deleted');
    if (onSaved) onSaved(null);
  };
}

/* ---------------------------------------------------------------------
   INVOICE EDITOR
   --------------------------------------------------------------------- */
let ed = null; // invoice being edited
async function renderEditor(id) {
  const invoices = await DB.all('invoices');
  let isNew = false;
  if (id === 'new' || !id) {
    isNew = true;
    const date = Core.todayISO();
    ed = {
      id: uid(), number: Core.nextNumber(S, invoices), state: 'draft', status: 'unpaid', source: 'app',
      date, due: Core.addDays(date, S.terms), customerId: null, customer: null, lines: [],
      po: '', ref: '', notes: S.notes || '', vatOn: !!S.vatEnabled, vatRate: Core.num(S.vatRate), currency: S.currency, createdAt: Date.now()
    };
    const pre = sessionStorage.getItem('dupInvoice');
    if (pre) { sessionStorage.removeItem('dupInvoice'); try { Object.assign(ed, JSON.parse(pre)); } catch (e) { /* ignore */ } }
  } else {
    const inv = invoices.find((i) => i.id === id);
    if (!inv) { view.innerHTML = '<div class="empty">Invoice not found.</div>'; return; }
    if (inv.source === 'imported') { location.replace('#view/' + id); return; }
    ed = JSON.parse(JSON.stringify(inv));
  }
  ed._dueTouched = !isNew;
  const final = ed.state === 'final';
  view.innerHTML = `
    <div class="title-row"><h1>${isNew ? 'New invoice' : (final ? 'Edit ' : 'Edit draft ') + esc(ed.number)}</h1></div>
    <div class="card">
      ${field('Invoice number', 'number', ed.number, 'text', final ? 'readonly' : '')}
      ${final ? '<p class="muted small" style="margin-top:-6px">Finalised invoices keep their number permanently.</p>' : ''}
      <div class="grid2">${field('Invoice date', 'date', ed.date, 'date')}${field('Due date', 'due', ed.due, 'date')}</div>
    </div>
    <div class="card">
      <label class="field"><span>Customer</span></label>
      <button class="picker-btn" id="pickCust"><span id="custLabel"></span>${ICON.chev}</button>
    </div>
    <h3>Items</h3>
    <div id="lines"></div>
    <div class="btn-row"><button class="btn" id="addItem">${ICON.plus} From equipment</button><button class="btn" id="addLine">${ICON.plus} Once-off line</button></div>
    <div class="spacer"></div>
    <div class="card">
      <div class="grid2">${field('Order / PO number', 'po', ed.po)}${field('Reference', 'ref', ed.ref)}</div>
      ${field('Notes (printed on invoice)', 'notes', ed.notes, 'textarea')}
      <label class="check"><input type="checkbox" id="vatOn" ${ed.vatOn ? 'checked' : ''}> Charge VAT (${esc(Core.num(ed.vatRate))}%)</label>
    </div>
    <div class="card totals" id="totals"></div>
    <div class="sticky-actions">
      ${final ? '<button class="btn primary" id="saveFinal">Save changes</button>' : '<button class="btn" id="saveDraft">Save draft</button><button class="btn primary" id="saveFinal">Finalise</button>'}
    </div>`;

  const setCust = () => {
    $('#custLabel').innerHTML = ed.customer ? `<b>${esc(ed.customer.name)}</b><br><span class="muted small">${esc([ed.customer.phone, ed.customer.email].filter(Boolean).join(' · '))}</span>` : '<span class="muted">Select customer</span>';
  };
  setCust();

  $$('input[name=number],input[name=date],input[name=due],input[name=po],input[name=ref],textarea[name=notes]', view).forEach((el) => {
    el.addEventListener('input', () => {
      ed[el.name] = el.value;
      if (el.name === 'due') ed._dueTouched = true;
      if (el.name === 'date' && !ed._dueTouched && el.value) { ed.due = Core.addDays(el.value, S.terms); $('input[name=due]').value = ed.due; }
    });
  });
  $('#vatOn').onchange = (e) => { ed.vatOn = e.target.checked; drawTotals(); };
  $('#pickCust').onclick = () => pickCustomer((c) => {
    ed.customerId = c.id;
    ed.customer = { name: c.name, contact: c.contact, phone: c.phone, email: c.email, address: c.address, vatNo: c.vatNo };
    setCust();
  });
  $('#addLine').onclick = () => { ed.lines.push(newLine()); drawLines(true); };
  $('#addItem').onclick = () => pickItem((it) => {
    ed.lines.push(newLine({ itemId: it.id, code: it.code, desc: it.description, note: it.notes || '', unit: it.unit, price: it.price }));
    drawLines(false);
  });
  $('#saveFinal').onclick = () => saveInvoice(true);
  if (!final) $('#saveDraft').onclick = () => saveInvoice(false);

  drawLines(false);
}
function newLine(o) { return Object.assign({ id: uid(), itemId: null, code: '', desc: '', note: '', unit: 'each', qty: 1, price: 0, disc: 0 }, o || {}); }
function drawLines(focusLast) {
  const box = $('#lines');
  if (!ed.lines.length) { box.innerHTML = '<div class="empty" style="padding:14px">No items yet. Add from your equipment list or add a once-off line.</div>'; drawTotals(); return; }
  box.innerHTML = ed.lines.map((l, i) => `
    <div class="line-card" data-i="${i}">
      <div class="line-head"><b>Line ${i + 1}${l.code ? ' · ' + esc(l.code) : ''}</b><button class="icon-btn" data-del="${i}" aria-label="Remove line">${ICON.trash}</button></div>
      <label class="field"><span>Description</span><input type="text" data-f="desc" value="${esc(l.desc)}"></label>
      <label class="field"><span>Details (optional)</span><input type="text" data-f="note" value="${esc(l.note)}"></label>
      <div class="grid3">
        <label class="field"><span>Qty${l.unit && l.unit !== 'each' ? ' (' + esc(l.unit) + ')' : ''}</span><input type="text" inputmode="decimal" data-f="qty" value="${esc(Core.qtyText(l.qty))}"></label>
        <label class="field"><span>Price</span><input type="text" inputmode="decimal" data-f="price" value="${(l.price / 100).toFixed(2)}"></label>
        <label class="field"><span>Disc %</span><input type="text" inputmode="decimal" data-f="disc" value="${l.disc ? esc(l.disc) : ''}" placeholder="0"></label>
      </div>
      <div class="line-amt"><span class="muted">Amount</span><span data-amt>${money(Core.lineTotal(l), ed.currency)}</span></div>
    </div>`).join('');
  $$('.line-card', box).forEach((card) => {
    const l = ed.lines[+card.dataset.i];
    $$('input[data-f]', card).forEach((inp) => {
      inp.addEventListener('input', () => {
        const f = inp.dataset.f;
        if (f === 'price') l.price = Core.toCents(inp.value);
        else if (f === 'qty') l.qty = Core.num(inp.value);
        else if (f === 'disc') l.disc = Math.min(100, Math.max(0, Core.num(inp.value)));
        else l[f] = inp.value;
        $('[data-amt]', card).textContent = money(Core.lineTotal(l), ed.currency);
        drawTotals();
      });
      if (inp.dataset.f !== 'desc' && inp.dataset.f !== 'note') inp.addEventListener('focus', () => inp.select());
    });
    $('[data-del]', card).onclick = async () => {
      if (!(await confirmBox('Remove line?', `Remove <b>${esc(l.desc || 'this line')}</b> from the invoice?`, 'Remove', true))) return;
      ed.lines.splice(+card.dataset.i, 1);
      drawLines(false);
    };
  });
  if (focusLast) { const last = $$('.line-card', box).pop(); if (last) { last.scrollIntoView({ block: 'center' }); $('input[data-f=desc]', last).focus(); } }
  drawTotals();
}
function drawTotals() {
  const t = Core.totals(ed.lines, ed.vatOn, ed.vatRate);
  $('#totals').innerHTML = `
    <div><span>Subtotal</span><b>${money(t.subtotal, ed.currency)}</b></div>
    ${ed.vatOn ? `<div><span>VAT (${esc(Core.num(ed.vatRate))}%)</span><b>${money(t.vat, ed.currency)}</b></div>` : ''}
    <div class="grand"><span>Total due</span><span>${money(t.total, ed.currency)}</span></div>`;
}
async function saveInvoice(finalise) {
  const invoices = await DB.all('invoices');
  ed.number = String(ed.number || '').trim();
  if (!ed.number) { toast('Invoice number is required'); return; }
  if (Core.isDuplicate(ed.number, invoices, ed.id)) {
    await alertBox('Duplicate number', `Invoice number <b>${esc(ed.number)}</b> is already used. The next free number is <b>${esc(Core.nextNumber(S, invoices.filter((i) => i.id !== ed.id)))}</b>.`);
    return;
  }
  if (!ed.date) { toast('Invoice date is required'); return; }
  ed.lines = ed.lines.filter((l) => (l.desc || '').trim() || l.price);
  if (finalise) {
    if (!ed.customer) { toast('Please select a customer'); return; }
    if (!ed.lines.length) { toast('Add at least one line item'); drawLines(false); return; }
    if (ed.state !== 'final') {
      const ok = await confirmBox('Finalise invoice?', `Invoice <b>${esc(ed.number)}</b> will be finalised and keep this number permanently.`, 'Finalise');
      if (!ok) return;
      ed.finalisedAt = Date.now();
    }
    ed.state = 'final';
    ed.company = snapshotCompany();
  }
  const t = Core.totals(ed.lines, ed.vatOn, ed.vatRate);
  Object.assign(ed, t, { updatedAt: Date.now() });
  delete ed._dueTouched;
  await DB.put('invoices', ed);
  if (ed.state === 'final' && Core.bumpLast(S, ed.number)) await saveSettings();
  toast(finalise ? 'Invoice finalised' : 'Draft saved');
  location.replace('#view/' + ed.id);
}
function snapshotCompany() {
  return { company: JSON.parse(JSON.stringify(S.company)), bank: JSON.parse(JSON.stringify(S.bank)), footer: S.footer };
}
async function pickCustomer(onPick) {
  const all = (await DB.all('customers')).sort((a, b) => a.name.localeCompare(b.name));
  const body = openSheet('Select customer', `
    <button class="btn primary block" id="qAdd">${ICON.plus} New customer</button><div class="spacer"></div>
    <div class="search">${ICON.search}<input type="search" id="pq" placeholder="Search customers"></div>
    <div class="list" id="pList"></div>`);
  const draw = (q) => {
    q = Core.norm(q);
    $('#pList', body).innerHTML = all.filter((c) => !q || [c.name, c.contact, c.phone].join(' ').toLowerCase().includes(q))
      .map((c) => `<button class="list-item" data-id="${c.id}"><div class="main"><div class="t">${esc(c.name)}</div><div class="s">${esc([c.contact, c.phone].filter(Boolean).join(' · ') || ' ')}</div></div></button>`).join('') ||
      '<div class="empty">No customers found.</div>';
    $$('[data-id]', body).forEach((b) => { b.onclick = () => { const c = all.find((x) => x.id === b.dataset.id); closeSheet(); onPick(c); }; });
  };
  draw('');
  $('#pq', body).oninput = (e) => draw(e.target.value);
  $('#qAdd', body).onclick = () => customerForm(null, (c) => { if (c) onPick(c); });
}
async function pickItem(onPick) {
  const all = (await DB.all('items')).sort((a, b) => (a.description || '').localeCompare(b.description || ''));
  const body = openSheet('Add from equipment', `
    <button class="btn block" id="qAddItem">${ICON.plus} New equipment item</button><div class="spacer"></div>
    <div class="search">${ICON.search}<input type="search" id="pq" placeholder="Search code or description"></div>
    <div class="list" id="pList"></div>`);
  const draw = (q) => {
    q = Core.norm(q);
    $('#pList', body).innerHTML = all.filter((i) => !q || [i.code, i.description].join(' ').toLowerCase().includes(q))
      .map((i) => `<button class="list-item" data-id="${i.id}"><div class="main"><div class="t">${esc(i.description)}</div><div class="s">${esc([i.code, 'per ' + (i.unit || 'each')].filter(Boolean).join(' · '))}</div></div><div class="amt">${money(i.price)}</div></button>`).join('') ||
      '<div class="empty">No equipment found.</div>';
    $$('[data-id]', body).forEach((b) => { b.onclick = () => { const it = all.find((x) => x.id === b.dataset.id); closeSheet(); onPick(it); toast('Added: ' + it.description); }; });
  };
  draw('');
  $('#pq', body).oninput = (e) => draw(e.target.value);
  $('#qAddItem', body).onclick = () => itemForm(null, (it) => { if (it) onPick(it); });
}

/* ---------------------------------------------------------------------
   INVOICE DETAIL
   --------------------------------------------------------------------- */
async function renderInvoiceView(id) {
  const inv = await DB.get('invoices', id);
  if (!inv) { view.innerHTML = '<div class="empty">Invoice not found.</div><a class="btn block" href="#invoices">Back to invoices</a>'; return; }
  const imported = inv.source === 'imported';
  const st = statusOf(inv);
  view.innerHTML = `
    <div class="card">
      <div class="inv-head">
        <div><div class="muted small">Invoice</div><h2>${esc(inv.number)}</h2><div style="margin-top:4px">${badge(inv)}</div></div>
        <div class="right"><div class="muted small">Total</div><div class="amount">${money(inv.total, inv.currency)}</div></div>
      </div>
      <dl class="kv">
        <dt>Customer</dt><dd>${esc((inv.customer && inv.customer.name) || '—')}</dd>
        <dt>Issued</dt><dd>${esc(Core.fmtDate(inv.date))}</dd>
        ${inv.due && !imported ? `<dt>Due</dt><dd>${esc(Core.fmtDate(inv.due))}</dd>` : ''}
        ${inv.po ? `<dt>PO number</dt><dd>${esc(inv.po)}</dd>` : ''}
        ${!imported && inv.lines ? `<dt>Items</dt><dd>${inv.lines.length}</dd>` : ''}
        ${imported ? `<dt>File</dt><dd>${esc(inv.fileName || 'PDF')}</dd>` : ''}
      </dl>
    </div>
    <div class="grid4">
      <button class="btn tile" id="aPrev">${ICON.eye}Preview</button>
      <button class="btn tile" id="aDown">${ICON.down}Download PDF</button>
      <button class="btn tile" id="aPrint">${ICON.print}Print</button>
      <button class="btn tile primary" id="aShare">${ICON.share}Share</button>
    </div>
    ${inv.state === 'draft' ? '<p class="muted small">Drafts print with a DRAFT watermark. Finalise to send.</p>' : `
    <h3>Payment status</h3>
    <div class="seg">${['unpaid', 'paid', 'overdue'].map((s) => `<button class="${s} ${s === st ? 'on' : ''}" data-st="${s}">${STATUS_LABEL[s]}</button>`).join('')}</div>`}
    <h3>Actions</h3>
    <div class="btn-row">
      <button class="btn" id="aEdit">${ICON.edit} ${imported ? 'Edit details' : 'Edit'}</button>
      ${imported ? '' : `<button class="btn" id="aDup">${ICON.copy} Duplicate</button>`}
      <button class="btn danger" id="aDel">${ICON.trash} Delete</button>
    </div>`;

  $('#aPrev').onclick = () => withPdf(inv, (bytes) => previewPdf(bytes, 'Invoice ' + inv.number));
  $('#aDown').onclick = () => withPdf(inv, (bytes, name) => { downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name); toast('PDF downloaded'); });
  $('#aPrint').onclick = () => withPdf(inv, (bytes, name) => printPdf(bytes, name));
  $('#aShare').onclick = () => withPdf(inv, (bytes, name) => sharePdf(bytes, name, inv));
  $$('[data-st]', view).forEach((b) => {
    b.onclick = async () => {
      inv.status = b.dataset.st;
      inv.paidAt = inv.status === 'paid' ? Core.todayISO() : null;
      inv.updatedAt = Date.now();
      await DB.put('invoices', inv);
      toast('Marked as ' + STATUS_LABEL[inv.status]);
      renderInvoiceView(id);
    };
  });
  $('#aEdit').onclick = () => { if (imported) importedDetailsForm(inv); else location.hash = '#edit/' + inv.id; };
  if (!imported) $('#aDup').onclick = () => {
    const copy = {
      customerId: inv.customerId, customer: inv.customer, po: '', ref: inv.ref || '', notes: inv.notes || '', vatOn: inv.vatOn, vatRate: inv.vatRate,
      lines: (inv.lines || []).map((l) => Object.assign({}, l, { id: uid() }))
    };
    sessionStorage.setItem('dupInvoice', JSON.stringify(copy));
    location.hash = '#edit/new';
    toast('Copied — new number assigned');
  };
  $('#aDel').onclick = async () => {
    const extra = inv.state === 'final' && !imported ? '<br><br>The number will not be reused.' : '';
    if (!(await confirmBox('Delete invoice?', `Delete invoice <b>${esc(inv.number)}</b>? This cannot be undone.${extra}`, 'Delete', true))) return;
    await DB.del('invoices', inv.id);
    if (inv.fileId) await DB.del('files', inv.fileId);
    toast('Invoice deleted');
    location.replace('#invoices');
  };
}
function importedDetailsForm(inv) {
  const body = openSheet('Imported invoice details', `
    ${field('Invoice number', 'number', inv.number)}
    ${field('Invoice date', 'date', inv.date, 'date')}
    ${field('Customer name', 'customer', (inv.customer && inv.customer.name) || '')}
    ${field('Total (' + (inv.currency || S.currency) + ')', 'total', (inv.total / 100).toFixed(2), 'text', 'inputmode="decimal"')}
    <button class="btn primary block" id="fSave">Save</button>`);
  $('#fSave', body).onclick = async () => {
    const d = formData(body);
    if (!d.number) { toast('Number is required'); return; }
    if (Core.isDuplicate(d.number, await DB.all('invoices'), inv.id)) { toast('That number is already used'); return; }
    inv.number = d.number; inv.date = d.date; inv.due = d.date;
    inv.customer = Object.assign({}, inv.customer, { name: d.customer });
    inv.total = inv.subtotal = Core.toCents(d.total);
    inv.updatedAt = Date.now();
    await DB.put('invoices', inv);
    closeSheet(); toast('Saved');
    renderInvoiceView(inv.id);
  };
}

/* ---------------------------------------------------------------------
   PDF: get bytes (generated or imported), preview, print, share
   --------------------------------------------------------------------- */
let busy = false;
async function withPdf(inv, fn) {
  if (busy) return;
  busy = true;
  try {
    let bytes;
    if (inv.source === 'imported') {
      const f = await DB.get('files', inv.fileId);
      if (!f) throw new Error('The original PDF file is missing.');
      bytes = new Uint8Array(f.data);
    } else {
      bytes = await buildInvoicePdf(inv, S);
    }
    await fn(bytes, 'Invoice-' + safeName(inv.number) + '.pdf');
  } catch (e) {
    console.error(e);
    alertBox('PDF problem', esc(e.message || String(e)));
  } finally { busy = false; }
}
async function sharePdf(bytes, name, inv) {
  if (NATIVE) { NATIVE.shareFile(bufToB64(bytes), name, 'application/pdf'); return; }
  const file = new File([bytes], name, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); }
    catch (e) { if (e.name !== 'AbortError') toast('Share failed: ' + e.message); }
  } else {
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
    toast('Sharing files is not supported in this browser — PDF downloaded instead', 4000);
  }
}

let pdfjsLib = null;
async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  const base = new URL('.', location.href).href;
  pdfjsLib = await import(base + 'pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
  return pdfjsLib;
}
async function renderPdfPages(bytes, scale) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const pdf = await task.promise;
  const canvases = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
    canvases.push(c);
  }
  task.destroy();
  return canvases;
}
async function previewPdf(bytes, title) {
  const body = openSheet(title, '<div class="empty">Loading preview…</div>', { full: true });
  const width = Math.min(window.innerWidth, 720);
  const scale = Math.min(3, Math.max(1.2, (width / 595) * (window.devicePixelRatio || 1)));
  const canvases = await renderPdfPages(bytes, scale);
  body.innerHTML = '<div class="pdf-pages"></div>';
  canvases.forEach((c) => $('.pdf-pages', body).appendChild(c));
}
async function printPdf(bytes, name) {
  if (NATIVE) { NATIVE.printPdf(bufToB64(bytes), (name || 'Invoice').replace(/\.pdf$/i, '')); return; }
  toast('Preparing to print…');
  const canvases = await renderPdfPages(bytes, 2.2);
  const area = $('#printArea');
  area.innerHTML = '';
  await Promise.all(canvases.map((c) => new Promise((res) => {
    const img = new Image();
    img.onload = res; img.onerror = res;
    img.src = c.toDataURL('image/jpeg', 0.92);
    area.appendChild(img);
  })));
  setTimeout(() => { window.print(); }, 250);
}
window.addEventListener('afterprint', () => { $('#printArea').innerHTML = ''; });

/* ---------------------------------------------------------------------
   PDF GENERATION (A4, matches the supplied sample layout)
   --------------------------------------------------------------------- */
async function buildInvoicePdf(inv, settings) {
  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
  const doc = await PDFDocument.create();
  const snap = inv.state === 'final' && inv.company ? inv.company : { company: settings.company, bank: settings.bank, footer: settings.footer };
  const co = snap.company || {}, bank = snap.bank || {};
  const cur = inv.currency || settings.currency || 'R';
  doc.setTitle('Invoice ' + inv.number);
  doc.setAuthor(co.name || '');
  doc.setCreator('Invoices PWA');
  doc.setProducer('Invoices PWA');
  const F = await doc.embedFont(StandardFonts.Helvetica);
  const B = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, L = 52, R = 546, IL = 60, IR = 538;
  const INK = rgb(0.11, 0.12, 0.14), GREY = rgb(0.42, 0.45, 0.5), SLATE = rgb(0.33, 0.38, 0.49);
  const LINE = rgb(0.89, 0.9, 0.92), HEAD = rgb(0.953, 0.957, 0.965), BAND = rgb(0.918, 0.953, 0.984);
  const okCache = new Map();
  const clean = (font, s) => {
    let out = '';
    for (const ch of String(s == null ? '' : s).replace(/\r/g, '').replace(/\t/g, ' ')) {
      if (ch === '\n') { out += ch; continue; }
      const k = font.name + ch;
      if (!okCache.has(k)) { try { font.encodeText(ch); okCache.set(k, true); } catch (e) { okCache.set(k, false); } }
      out += okCache.get(k) ? ch : '?';
    }
    return out;
  };
  const width = (s, font, size) => font.widthOfTextAtSize(clean(font, s), size);
  const wrap = (s, font, size, maxW) => {
    const out = [];
    String(s == null ? '' : s).split('\n').forEach((para) => {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(''); return; }
      let line = '';
      for (let w of words) {
        while (width(w, font, size) > maxW && w.length > 1) { // break very long words
          let cut = w.length - 1;
          while (cut > 1 && width(w.slice(0, cut), font, size) > maxW) cut--;
          if (line) { out.push(line); line = ''; }
          out.push(w.slice(0, cut)); w = w.slice(cut);
        }
        const t = line ? line + ' ' + w : w;
        if (width(t, font, size) <= maxW) line = t; else { out.push(line); line = w; }
      }
      if (line) out.push(line);
    });
    return out;
  };
  let page;
  const pages = [];
  const T = (s, x, y, size, font, color, align) => {
    const txt = clean(font, s);
    if (!txt) return;
    const w = font.widthOfTextAtSize(txt, size);
    const dx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    page.drawText(txt, { x: dx, y: H - y, size, font, color: color || INK });
  };
  const rrect = (x, yTop, w, h, r, opts) => {
    const p = `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
    page.drawSvgPath(p, Object.assign({ x, y: H - yTop }, opts));
  };
  const newPage = () => { page = doc.addPage([W, H]); pages.push(page); return page; };

  newPage();
  // ---- Header: title + company (left), logo (right)
  T('INVOICE', L, 80, 20, B);
  let y = 104;
  wrap(co.name || '', B, 12, 280).forEach((ln) => { T(ln, L, y, 12, B); y += 14; });
  y += 1;
  const coLines = [];
  String(co.address || '').split('\n').forEach((a) => a.trim() && coLines.push(a.trim()));
  if (co.postal && co.postal.trim() && co.postal.trim() !== (co.address || '').trim()) coLines.push('Postal: ' + co.postal.replace(/\n+/g, ', '));
  if (co.phone) coLines.push(co.phone);
  if (co.email) coLines.push(co.email);
  if (co.website) coLines.push(co.website);
  if (co.regNo) coLines.push('Reg no: ' + co.regNo);
  if (co.vatNo) coLines.push('VAT no: ' + co.vatNo);
  coLines.forEach((t) => wrap(t, F, 8, 260).forEach((ln) => { T(ln, L, y, 8, F, GREY); y += 10; }));
  let headBottom = y;
  if (settings.logo) {
    try {
      const img = settings.logo.startsWith('data:image/png') ? await doc.embedPng(settings.logo) : await doc.embedJpg(settings.logo);
      const maxW = 190, maxH = 110;
      const s = Math.min(maxW / img.width, maxH / img.height);
      const w = img.width * s, h = img.height * s;
      page.drawImage(img, { x: R - w, y: H - 58 - h, width: w, height: h });
      headBottom = Math.max(headBottom, 58 + h);
    } catch (e) { console.warn('Logo could not be embedded', e); }
  }

  // ---- Bill-to box
  const boxTop = Math.max(196, headBottom + 18);
  const c = inv.customer || {};
  const left = [];
  if (c.contact) left.push('Attn: ' + c.contact);
  if (c.phone) left.push(c.phone);
  if (c.email) left.push(c.email);
  String(c.address || '').split('\n').forEach((a) => a.trim() && left.push(a.trim()));
  if (c.vatNo) left.push('VAT no: ' + c.vatNo);
  const nameLines = wrap(c.name || '', B, 11, 250);
  const leftEnd = boxTop + 30 + (nameLines.length - 1) * 13 + 4 + left.reduce((a, t) => a + wrap(t, F, 8, 250).length, 0) * 10.5;
  const rows = [['INVOICE NUMBER', inv.number], ['ISSUED', Core.fmtDate(inv.date)]];
  if (inv.due) rows.push(['DUE', Core.fmtDate(inv.due)]);
  if (inv.po) rows.push(['PO NUMBER', inv.po]);
  if (inv.ref) rows.push(['REFERENCE', inv.ref]);
  const rightEnd = boxTop + 16 + (rows.length - 1) * 20.5;
  const boxH = Math.max(74, Math.max(leftEnd, rightEnd) - boxTop + 14);
  rrect(L, boxTop, R - L, boxH, 5, { borderColor: LINE, borderWidth: 0.8 });
  T('BILL TO', IL, boxTop + 15, 6.5, B);
  let ly = boxTop + 30;
  nameLines.forEach((ln) => { T(ln, IL, ly, 11, B); ly += 13; });
  ly += 1;
  left.forEach((t) => wrap(t, F, 8, 250).forEach((ln) => { T(ln, IL, ly, 8, F, GREY); ly += 10.5; }));
  rows.forEach(([k, v], i) => {
    const ry = boxTop + 16 + i * 20.5;
    T(k, 415, ry - 1, 6.5, B, INK, 'right');
    T(v, IR, ry, 8, F, INK, 'right');
  });

  // ---- Items table
  const lines = inv.lines || [];
  const hasDisc = lines.some((l) => Core.num(l.disc) > 0);
  const col = hasDisc ? { price: 318, qty: 384, disc: 446, descW: 225 } : { price: 360, qty: 435, descW: 255 };
  const drawHead = (top) => {
    rrect(L, top, R - L, 16, 3, { color: HEAD });
    T('ITEM', IL, top + 10.5, 6.5, B);
    T('PRICE', col.price, top + 10.5, 6.5, B, INK, 'center');
    T('QUANTITY', col.qty, top + 10.5, 6.5, B, INK, 'center');
    if (hasDisc) T('DISCOUNT', col.disc, top + 10.5, 6.5, B, INK, 'center');
    T('AMOUNT', IR, top + 10.5, 6.5, B, INK, 'right');
    return top + 16 + 14;
  };
  const LIMIT = 780;
  const contPage = () => {
    newPage();
    T('INVOICE ' + inv.number + ' (continued)', L, 60, 9, B, GREY);
    return 76;
  };
  y = drawHead(boxTop + boxH + 20);
  lines.forEach((l) => {
    const dl = wrap(l.desc || '', F, 9, col.descW);
    const nl = l.note ? wrap(l.note, F, 8, col.descW) : [];
    const h = dl.length * 11 + nl.length * 12;
    if (y + h > LIMIT) y = drawHead(contPage());
    const unit = l.unit && l.unit !== 'each' ? ' ' + l.unit : '';
    T(money(l.price, cur), col.price, y, 9, F, INK, 'center');
    T(Core.qtyText(l.qty) + unit, col.qty, y, 9, F, INK, 'center');
    if (hasDisc) T(Core.num(l.disc) > 0 ? Core.qtyText(l.disc) + '%' : '', col.disc, y, 9, F, INK, 'center');
    T(money(Core.lineTotal(l), cur), IR, y, 9, F, INK, 'right');
    dl.forEach((ln) => { T(ln, IL, y, 9, F); y += 11; });
    y += 1;
    nl.forEach((ln) => { T(ln, IL, y, 8, F, SLATE); y += 12; });
    y += 13;
  });

  // ---- Totals
  const totals = Core.totals(lines, inv.vatOn, inv.vatRate);
  const tRows = [['Subtotal', totals.subtotal]];
  if (inv.vatOn) tRows.push(['VAT (' + Core.qtyText(inv.vatRate) + '%)', totals.vat]);
  tRows.push(['Total', totals.total]);
  const bankLines = [];
  if (bank.name) bankLines.push(bank.name);
  if (bank.holder) bankLines.push(bank.holder);
  if (bank.account) bankLines.push('Acc: ' + bank.account);
  if (bank.branch) bankLines.push('Branch code: ' + bank.branch);
  if (bank.type) bankLines.push('Account type: ' + bank.type);
  bankLines.push('Reference: ' + (bank.reference ? bank.reference.replace(/\{number\}/gi, inv.number) : inv.number));
  const noteLines = inv.notes ? wrap(inv.notes, F, 8, R - L) : [];
  const needed = 16 + tRows.length * 15.5 + 34 + 40 + bankLines.length * 15.5 + (noteLines.length ? 22 + noteLines.length * 11 : 0);
  if (y + Math.min(needed, 240) > LIMIT) y = contPage();
  y += 8;
  page.drawLine({ start: { x: 299, y: H - y }, end: { x: R, y: H - y }, thickness: 0.6, color: LINE });
  y += 12;
  tRows.forEach(([k, v]) => { T(k, 305, y, 7.5, F); T(money(v, cur), IR, y, 7.5, F, INK, 'right'); y += 15.5; });
  y += 18;
  T('Amount due', 334, y, 12, B);
  T(money(totals.total, cur), IR, y, 12, B, INK, 'right');
  if (inv.status === 'paid' && inv.state === 'final') { y += 15; T('PAID - thank you', IR, y, 8, B, rgb(0.08, 0.5, 0.24), 'right'); }

  // ---- Payment instruction
  y += 32;
  if (y + 15 + bankLines.length * 15.5 > LIMIT) y = contPage();
  T('Payment instruction', L, y, 8, F);
  y += 15.5;
  bankLines.forEach((t) => { T(t, L, y, 8, F); y += 15.5; });

  // ---- Notes
  if (noteLines.length) {
    y += 10;
    if (y + 12 > LIMIT) y = contPage();
    T('Notes', L, y, 8, B); y += 13;
    noteLines.forEach((ln) => { if (y > LIMIT) y = contPage(); T(ln, L, y, 8, F, GREY); y += 11; });
  }

  // ---- Footer band + page numbers + draft watermark on every page
  const footer = snap.footer || '';
  pages.forEach((p, i) => {
    page = p;
    rrect(19, 801, W - 38, 27, 3, { color: BAND });
    const ft = wrap(footer, F, 7.5, 440)[0] || '';
    T(ft, 30, 817.5, 7.5, F);
    T('Page ' + (i + 1) + ' of ' + pages.length, W - 30, 817.5, 7, F, GREY, 'right');
    if (inv.state === 'draft') {
      p.drawText('DRAFT', { x: 130, y: 260, size: 120, font: B, color: rgb(0.6, 0.6, 0.6), opacity: 0.12, rotate: degrees(35) });
    }
  });
  return doc.save();
}

/* ---------------------------------------------------------------------
   IMPORT OLD PDF INVOICES
   --------------------------------------------------------------------- */
$('#pickPdf').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  toast('Reading ' + files.length + ' PDF' + (files.length > 1 ? 's' : '') + '…', 6000);
  const results = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let info = {};
    try { info = await extractPdfInfo(bytes); } catch (err) { console.warn(err); info = { error: true }; }
    results.push({ key: uid(), name: f.name, bytes, include: true, status: 'unpaid', ...info });
  }
  openImportReview(results);
});
async function extractPdfInfo(bytes) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const pdf = await task.promise;
  const items = [];
  for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    tc.items.forEach((it) => {
      if (!it.str || !it.str.trim()) return;
      items.push({ str: it.str, x: it.transform[4], y: (p - 1) * 10000 + (vp.height - it.transform[5]), h: Math.abs(it.transform[3]) || 10 });
    });
  }
  task.destroy();
  return Core.extract(items);
}
window.__extractPdfInfo = extractPdfInfo; // used by self-test
async function openImportReview(results) {
  const existing = await DB.all('invoices');
  $('#toast').hidden = true;
  const body = openSheet('Confirm imported invoices', `
    <p class="muted small">Check each invoice — other apps lay out PDFs differently, so correct anything that was read wrongly.</p>
    <div id="impList">${results.map((r) => `
      <div class="card import-card" data-k="${r.key}">
        <label class="check"><input type="checkbox" data-f="include" checked> <span>${esc(r.name)}</span></label>
        ${r.error ? '<p class="err-text">Could not read text from this PDF — please fill in the details.</p>' : ''}
        <div class="grid2">
          <label class="field"><span>Invoice number</span><input type="text" data-f="number" value="${esc(r.number || '')}"></label>
          <label class="field"><span>Invoice date</span><input type="date" data-f="date" value="${esc(r.date || '')}"></label>
        </div>
        <label class="field"><span>Customer</span><input type="text" data-f="customer" value="${esc(r.customer || '')}"></label>
        <div class="grid2">
          <label class="field"><span>Total (${esc(S.currency)})</span><input type="text" inputmode="decimal" data-f="total" value="${r.total != null ? (r.total / 100).toFixed(2) : ''}"></label>
          <label class="field"><span>Status</span><select data-f="status"><option value="unpaid">Unpaid</option><option value="paid">Paid</option><option value="overdue">Overdue</option></select></label>
        </div>
        <div class="err-text" data-err></div>
      </div>`).join('')}</div>
    <button class="btn primary block" id="impSave">Save imported invoices</button>`, { full: true });

  $('#impSave', body).onclick = async () => {
    let bad = false;
    const seen = new Set();
    const chosen = [];
    results.forEach((r) => {
      const card = $(`[data-k="${r.key}"]`, body);
      const v = (f) => { const el = $(`[data-f="${f}"]`, card); return el.type === 'checkbox' ? el.checked : el.value.trim(); };
      const err = $('[data-err]', card);
      err.textContent = '';
      card.classList.remove('err');
      if (!v('include')) return;
      const number = v('number');
      let msg = '';
      if (!number) msg = 'Invoice number is required.';
      else if (Core.isDuplicate(number, existing) || seen.has(Core.norm(number))) msg = 'This invoice number already exists.';
      else if (!v('date')) msg = 'Invoice date is required.';
      if (msg) { err.textContent = msg; card.classList.add('err'); bad = true; return; }
      seen.add(Core.norm(number));
      chosen.push({ r, number, date: v('date'), customer: v('customer'), total: Core.toCents(v('total')), status: v('status') });
    });
    if (bad) { toast('Please fix the highlighted invoices'); return; }
    if (!chosen.length) { closeSheet(); return; }
    const customers = await DB.all('customers');
    for (const c of chosen) {
      const fileId = uid();
      await DB.put('files', { id: fileId, name: c.r.name, data: c.r.bytes.buffer.slice(c.r.bytes.byteOffset, c.r.bytes.byteOffset + c.r.bytes.byteLength) });
      const match = customers.find((x) => Core.norm(x.name) === Core.norm(c.customer));
      await DB.put('invoices', {
        id: uid(), source: 'imported', state: 'final', status: c.status, paidAt: c.status === 'paid' ? c.date : null,
        number: c.number, date: c.date, due: c.date, customerId: match ? match.id : null,
        customer: match ? { name: match.name, phone: match.phone, email: match.email } : { name: c.customer },
        subtotal: c.total, vat: 0, total: c.total, currency: S.currency, fileId, fileName: c.r.name, createdAt: Date.now(), updatedAt: Date.now()
      });
    }
    closeSheet();
    toast(chosen.length + ' invoice' + (chosen.length > 1 ? 's' : '') + ' imported');
    const highest = Math.max(...chosen.map((c) => Core.trailingInt(c.number) || 0));
    const last = parseInt(S.lastNumber, 10) || 0;
    if (highest > last) {
      const nextPreview = Core.nextNumber(Object.assign({}, S, { lastNumber: String(highest) }), await DB.all('invoices'));
      const ok = await confirmBox('Continue numbering?', `The highest imported invoice number is <b>${highest}</b>. Set “Last invoice number used” to <b>${highest}</b>?<br><br>Your next invoice will be <b>${esc(nextPreview)}</b>. (You can change the prefix in Settings.)`, 'Yes, update');
      if (ok) { S.lastNumber = String(highest); await saveSettings(); toast('Next invoice: ' + nextPreview); }
    }
    route();
  };
}

/* ---------------------------------------------------------------------
   SETTINGS
   --------------------------------------------------------------------- */
async function renderSettings() {
  const invoices = await DB.all('invoices');
  const g = (path) => path.split('.').reduce((o, k) => (o == null ? '' : o[k]), S);
  const f = (label, path, type, extra) => field(label, path, g(path) == null ? '' : g(path), type, (extra || '') + ' data-path="' + path + '"');
  view.innerHTML = `
    <h1>Settings</h1>
    <h3>Company details</h3>
    <div class="card">
      ${f('Company name', 'company.name')}
      <div class="grid2">${f('Registration number', 'company.regNo')}${f('VAT number', 'company.vatNo')}</div>
      ${f('Physical address', 'company.address', 'textarea')}
      ${f('Postal address', 'company.postal', 'textarea')}
      <div class="grid2">${f('Phone', 'company.phone', 'tel')}${f('Email', 'company.email', 'email')}</div>
      ${f('Website', 'company.website', 'url')}
    </div>
    <h3>Logo</h3>
    <div class="card">
      <div class="logo-box">${S.logo ? `<img src="${S.logo}" alt="Logo">` : '<span class="muted">No logo</span>'}</div>
      <div class="btn-row"><button class="btn" id="logoPick">${ICON.upload} ${S.logo ? 'Change logo' : 'Upload logo'}</button>${S.logo ? `<button class="btn danger" id="logoDel">${ICON.trash} Remove</button>` : ''}</div>
    </div>
    <h3>Banking details</h3>
    <div class="card">
      ${f('Bank name', 'bank.name')}
      ${f('Account holder', 'bank.holder')}
      <div class="grid2">${f('Account number', 'bank.account', 'text', 'inputmode="numeric"')}${f('Branch code', 'bank.branch', 'text', 'inputmode="numeric"')}</div>
      ${f('Account type', 'bank.type')}
      ${f('Payment reference instructions (use {number} for the invoice no.)', 'bank.reference')}
    </div>
    <h3>Tax, currency &amp; terms</h3>
    <div class="card">
      <label class="check"><input type="checkbox" data-path="vatEnabled" ${S.vatEnabled ? 'checked' : ''}> Charge VAT on new invoices</label>
      <div class="grid3">${f('VAT rate %', 'vatRate', 'text', 'inputmode="decimal"')}${f('Currency symbol', 'currency')}${f('Payment terms (days)', 'terms', 'text', 'inputmode="numeric"')}</div>
      ${f('Default invoice notes', 'notes', 'textarea')}
      ${f('Footer text (bottom of every page)', 'footer')}
    </div>
    <h3>Invoice numbering</h3>
    <div class="card">
      <div class="grid2">${f('Prefix', 'prefix')}${f('Last invoice number used', 'lastNumber', 'text', 'inputmode="numeric"')}</div>
      <p class="small">Next invoice will be: <b id="nextNo"></b></p>
    </div>
    <h3>Appearance</h3>
    <div class="card">
      <label class="field"><span>Theme</span><select data-path="theme">
        ${['auto', 'light', 'dark'].map((t) => `<option value="${t}" ${S.theme === t ? 'selected' : ''}>${t === 'auto' ? 'Match phone' : t[0].toUpperCase() + t.slice(1)}</option>`).join('')}
      </select></label>
    </div>
    <h3>Backup &amp; restore</h3>
    <div class="card">
      <p class="small muted" style="margin-top:0">Saves everything (company, logo, customers, equipment, invoices, imported PDFs, settings) to one file. Keep a copy off your phone.</p>
      <div class="btn-row"><button class="btn primary" id="bExport">${ICON.down} Export backup</button><button class="btn" id="bImport">${ICON.upload} Restore backup</button></div>
    </div>
    <h3>App</h3>
    <div class="card">
      <dl class="kv" style="margin-top:0"><dt>Version</dt><dd>v${APP_VERSION}</dd><dt>Data stored</dt><dd>On this phone only</dd>${NATIVE ? '<dt>Installed as</dt><dd>Android app</dd>' : ''}</dl>
      <div class="spacer"></div>
      <div class="btn-row"><button class="btn" id="sUpdate">Check for updates</button><button class="btn danger" id="sWipe">${ICON.trash} Erase all data</button></div>
    </div>`;

  const showNext = () => { $('#nextNo').textContent = Core.nextNumber(S, invoices); };
  showNext();
  $$('[data-path]', view).forEach((el) => {
    const save = async () => {
      const path = el.dataset.path;
      let val = el.type === 'checkbox' ? el.checked : el.value.trim();
      if (path === 'vatRate') { val = Core.num(val); el.value = val; }
      if (path === 'terms') { val = Math.max(0, parseInt(val, 10) || 0); el.value = val; }
      if (path === 'lastNumber') {
        if (!/^\d*$/.test(val)) { toast('Use digits only, e.g. 1047'); el.value = S.lastNumber; return; }
        val = val || '0';
        const maxUsed = Math.max(0, ...invoices.filter((i) => i.state === 'final' && Core.norm(i.number).startsWith(Core.norm(S.prefix)))
          .map((i) => Core.trailingInt(i.number) || 0));
        if (parseInt(val, 10) < maxUsed) toast(`Note: ${S.prefix}${maxUsed} already exists — used numbers will be skipped`, 4000);
      }
      const keys = path.split('.');
      let o = S;
      keys.slice(0, -1).forEach((k) => { o = o[k]; });
      o[keys[keys.length - 1]] = val;
      await saveSettings();
      showNext();
      toast('Saved', 1200);
    };
    el.addEventListener('change', save);
    if (el.dataset.path === 'prefix' || el.dataset.path === 'lastNumber') el.addEventListener('input', () => {
      const tmp = Object.assign({}, S, { [el.dataset.path]: el.value.trim() });
      $('#nextNo').textContent = Core.nextNumber(tmp, invoices);
    });
  });
  $('#logoPick').onclick = () => $('#pickLogo').click();
  if (S.logo) $('#logoDel').onclick = async () => {
    if (!(await confirmBox('Remove logo?', 'The logo will be removed from your invoices.', 'Remove', true))) return;
    S.logo = null; await saveSettings(); renderSettings();
  };
  $('#bExport').onclick = exportBackup;
  $('#bImport').onclick = () => $('#pickBackup').click();
  $('#sUpdate').onclick = checkForUpdate;
  $('#sWipe').onclick = async () => {
    if (!(await confirmBox('Erase all data?', 'This deletes all invoices, customers, equipment and settings on this phone.', 'Continue', true))) return;
    if (!(await confirmBox('Are you sure?', 'Make sure you have a backup. This cannot be undone.', 'Erase everything', true))) return;
    for (const s of STORES) await DB.clear(s);
    await loadSettings();
    toast('All data erased');
    location.hash = '#home';
  };
}
$('#pickLogo').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    S.logo = await processLogo(file);
    await saveSettings();
    toast('Logo saved');
    if (location.hash === '#settings') renderSettings();
  } catch (err) { alertBox('Logo problem', 'That image could not be read. Please use a PNG or JPG.'); }
});
function processLogo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 900;
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * s));
      c.height = Math.max(1, Math.round(img.naturalHeight * s));
      const ctx = c.getContext('2d');
      const jpeg = /jpe?g/i.test(file.type);
      if (jpeg) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(jpeg ? c.toDataURL('image/jpeg', 0.9) : c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

/* ---------------------------------------------------------------------
   BACKUP / RESTORE
   --------------------------------------------------------------------- */
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}
async function exportBackup() {
  const data = {
    app: 'invoice-pwa', version: APP_VERSION, exportedAt: new Date().toISOString(),
    settings: S, customers: await DB.all('customers'), items: await DB.all('items'), invoices: await DB.all('invoices'),
    files: (await DB.all('files')).map((f) => ({ id: f.id, name: f.name, data: bufToB64(f.data) }))
  };
  const name = 'invoices-backup-' + Core.todayISO() + '.json';
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (NATIVE) {
    const choice = await dialog('Export backup', '<p>Save the backup to your Downloads folder, or share it (e.g. to Google Drive, email or WhatsApp yourself).</p>',
      [{ label: 'Download', value: 'dl' }, { label: 'Share', value: 'share', cls: 'primary' }]);
    const b64 = bufToB64(await blob.arrayBuffer());
    if (choice === 'share') NATIVE.shareFile(b64, name, 'application/json'); else NATIVE.saveFile(b64, name, 'application/json');
    return;
  }
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    const choice = await dialog('Export backup', '<p>Save the backup file to your phone, or share it (e.g. to Google Drive, email or WhatsApp yourself).</p>',
      [{ label: 'Download', value: 'dl' }, { label: 'Share', value: 'share', cls: 'primary' }]);
    if (choice === 'share') { try { await navigator.share({ files: [file], title: name }); } catch (e) { if (e.name !== 'AbortError') downloadBlob(blob, name); } return; }
  }
  downloadBlob(blob, name);
  toast('Backup saved: ' + name, 3500);
}
$('#pickBackup').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch (err) { alertBox('Restore failed', 'That file is not a valid backup.'); return; }
  if (!data || data.app !== 'invoice-pwa' || !data.settings) { alertBox('Restore failed', 'That file is not a backup from this app.'); return; }
  const n = (data.invoices || []).length;
  if (!(await confirmBox('Restore backup?', `This replaces ALL data on this phone with the backup from <b>${esc((data.exportedAt || '').slice(0, 10))}</b> (${n} invoices, ${(data.customers || []).length} customers).`, 'Restore', true))) return;
  try {
    for (const s of STORES) await DB.clear(s);
    await DB.put('settings', Object.assign({}, data.settings, { key: 'main' }));
    for (const c of data.customers || []) await DB.put('customers', c);
    for (const i of data.items || []) await DB.put('items', i);
    for (const i of data.invoices || []) await DB.put('invoices', i);
    for (const f of data.files || []) await DB.put('files', { id: f.id, name: f.name, data: b64ToBuf(f.data) });
    await loadSettings();
    toast('Backup restored');
    location.hash = '#home';
    route();
  } catch (err) { console.error(err); alertBox('Restore failed', esc(err.message || String(err))); }
});

/* ---------------------------------------------------------------------
   INSTALL / SHARE APP / UPDATE
   --------------------------------------------------------------------- */
let deferredPrompt = null, installedFlag = false;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function updateInstallBtn() { $('#btnInstall').hidden = !!NATIVE || isStandalone() || installedFlag; }
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; updateInstallBtn(); });
window.addEventListener('appinstalled', () => { deferredPrompt = null; installedFlag = true; updateInstallBtn(); toast('App installed'); });
$('#btnInstall').onclick = async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (choice && choice.outcome === 'accepted') { installedFlag = true; updateInstallBtn(); }
    return;
  }
  if (isIOS) {
    alertBox('Install on iPhone', `<ol style="padding-left:20px;margin:0">
      <li>Open this page in <b>Safari</b>.</li>
      <li>Tap the <b>Share</b> button (square with an arrow).</li>
      <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
      <li>Tap <b>Add</b>.</li></ol>`);
  } else {
    alertBox('Install the app', `<p>Open your browser menu (<b>⋮</b> in Chrome, <b>☰</b> in Samsung Internet) and tap <b>Install app</b> or <b>Add page to → Home screen</b>.</p>`);
  }
};
$('#btnShareApp').onclick = async () => {
  if (NATIVE) {
    const repo = NATIVE.repo();
    if (!repo) { toast('App link not available in this build'); return; }
    const [owner, name] = repo.split('/');
    NATIVE.shareText('Invoices app\n\nAndroid (APK): https://github.com/' + repo + '/releases/latest\n\niPhone / browser: https://' + owner.toLowerCase() + '.github.io/' + name + '/');
    return;
  }
  const url = location.href.split('#')[0].replace(/index\.html$/, '');
  if (navigator.share) {
    try { await navigator.share({ title: 'Invoices app', text: 'Offline invoicing app — open the link and tap Install.', url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('App link copied'); }
  catch (e) { alertBox('App link', `<p style="word-break:break-all">${esc(url)}</p>`); }
};

let swReg = null, updating = false;
if (!NATIVE && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    swReg = reg;
    if (reg.waiting && navigator.serviceWorker.controller) toast('An update is ready — tap Update', 4000);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller && !updating) toast('An update is ready — tap Update', 4000);
      });
    });
  }).catch((e) => console.warn('SW registration failed', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) location.reload(); });
}
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
async function checkNativeUpdate() {
  const repo = NATIVE.repo();
  if (!repo) { toast('Update checks are not set up in this build'); return; }
  if (!navigator.onLine) { toast("You're offline — connect to check for updates"); return; }
  toast('Checking for updates…', 10000);
  let rel;
  try {
    const r = await fetch('https://api.github.com/repos/' + repo + '/releases/latest', { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } });
    if (r.status === 404 || r.status === 403) {
      // private repo (or rate limited): let the user check the releases page while signed in to GitHub
      const go = await confirmBox('Check for updates', `You have v${esc(APP_VERSION)}. Open the GitHub releases page to see if a newer version is available?<br><br>If there is, download the .apk, open it and tap <b>Update</b>. Your data is kept.`, 'Open');
      if (go) NATIVE.openUrl('https://github.com/' + repo + '/releases/latest');
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    rel = await r.json();
  } catch (e) { toast("Couldn't reach GitHub to check for updates"); return; }
  const latest = String(rel.tag_name || '').replace(/^v/i, '');
  if (!latest || cmpVer(latest, APP_VERSION) <= 0) { toast(`You're on the latest version (v${APP_VERSION})`); return; }
  const apk = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
  const ok = await confirmBox('Update available', `Version <b>v${esc(latest)}</b> is available (you have v${esc(APP_VERSION)}).<br><br>Tap Download, then open the downloaded file and tap <b>Update</b>. Your invoices and settings are kept.`, 'Download');
  if (ok) NATIVE.openUrl(apk ? apk.browser_download_url : rel.html_url);
}
async function checkForUpdate() {
  if (NATIVE) return checkNativeUpdate();
  if (!swReg) { toast('Updates need the app to be opened from its web link once'); return; }
  if (!navigator.onLine) { toast("You're offline — connect to check for updates"); return; }
  toast('Checking for updates…', 10000);
  try { await swReg.update(); } catch (e) { toast("Couldn't reach the update server"); return; }
  let sw = swReg.waiting || swReg.installing;
  if (!sw) { toast(`You're on the latest version (v${APP_VERSION})`); return; }
  if (!swReg.waiting) {
    await new Promise((res) => {
      const done = () => { if (sw.state === 'installed' || sw.state === 'redundant' || sw.state === 'activated') res(); };
      sw.addEventListener('statechange', done); done();
      setTimeout(res, 20000);
    });
  }
  if (swReg.waiting) {
    updating = true;
    toast('Updating…');
    swReg.waiting.postMessage('SKIP_WAITING');
    setTimeout(() => location.reload(), 4000);
  } else {
    toast(`You're on the latest version (v${APP_VERSION})`);
  }
}
$('#btnUpdate').onclick = checkForUpdate;

/* ---------------------------------------------------------------------
   START
   --------------------------------------------------------------------- */
(async () => {
  updateInstallBtn();
  try {
    await DB.open();
    await loadSettings();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) {
    view.innerHTML = `<div class="card"><b>Storage unavailable.</b><p class="muted small">This browser blocked on-device storage (private mode?). ${esc(e.message || '')}</p></div>`;
    return;
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  route();
})();

// exposed for automated tests
window.__app = { DB, buildInvoicePdf, getSettings: () => S, loadSettings };
}
