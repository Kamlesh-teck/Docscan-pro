// ===================== DOM HELPERS =====================
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export const icon = (name, cls = '') => `<span class="material-symbols-rounded ${cls}">${name}</span>`;

// ===================== TOAST / MODALS =====================
export function toast(msg, type = 'info', duration = 2600) {
  const root = $('#toast-root');
  const t = el('div', { class: `toast ${type}` }, msg);
  root.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, duration);
}

export function confirmDialog(title, message, { danger = true, okText = 'Delete' } = {}) {
  return new Promise(resolve => {
    const overlay = el('div', { class: 'modal-overlay' });
    const modal = el('div', { class: 'modal' },
      el('h3', {}, title), el('p', {}, message),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn ghost', onclick: () => { overlay.remove(); resolve(false); } }, 'Cancel'),
        el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { overlay.remove(); resolve(true); } }, okText)
      )
    );
    overlay.append(modal); document.body.append(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
  });
}

export function promptDialog(title, defaultValue = '', { placeholder = '', okText = 'Save' } = {}) {
  return new Promise(resolve => {
    const overlay = el('div', { class: 'modal-overlay' });
    const input = el('input', { type: 'text', value: defaultValue, placeholder });
    const modal = el('div', { class: 'modal' },
      el('h3', {}, title), input,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn ghost', onclick: () => { overlay.remove(); resolve(null); } }, 'Cancel'),
        el('button', { class: 'btn', onclick: () => { const v = input.value.trim(); overlay.remove(); resolve(v || null); } }, okText)
      )
    );
    overlay.append(modal); document.body.append(overlay);
    requestAnimationFrame(() => { overlay.classList.add('show'); input.focus(); });
  });
}

let loadingCount = 0;
export function showLoading(text = 'Processing…') {
  loadingCount++;
  $('#loading-text').textContent = text;
  $('#loading-root').classList.remove('hidden');
}
export function hideLoading(force = false) {
  loadingCount = force ? 0 : Math.max(0, loadingCount - 1);
  if (loadingCount === 0) $('#loading-root').classList.add('hidden');
}
export function setLoadingText(text) { $('#loading-text').textContent = text; }

// ===================== MISC =====================
export const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));

export const clamp = (v, min = 0, max = 255) => v < min ? min : v > max ? max : v;

export function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

export function debounce(fn, ms = 120) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const tick = () => new Promise(r => setTimeout(r, 0));

// ===================== CANVAS / BLOB =====================
export function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas export failed')), type, quality);
  });
}

export async function blobToBitmap(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { return await createImageBitmap(blob); }
}

export async function blobToCanvas(blob, maxDim = 0) {
  const bmp = await blobToBitmap(blob);
  let w = bmp.width, h = bmp.height;
  if (maxDim && Math.max(w, h) > maxDim) {
    const s = maxDim / Math.max(w, h);
    w = Math.round(w * s); h = Math.round(h * s);
  }
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return c;
}

export async function makeThumb(blob, size = 420) {
  const c = await blobToCanvas(blob, size);
  return canvasToBlob(c, 'image/jpeg', 0.8);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function shareBlob(blob, filename, title = 'Document') {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return true; }
    catch (e) { if (e.name === 'AbortError') return true; }
  }
  downloadBlob(blob, filename);
  toast('Sharing not supported — file downloaded instead', 'info');
  return false;
}

// ===================== SCRIPT LOADER =====================
const scriptCache = new Map();
export function loadScript(src) {
  if (scriptCache.has(src)) return scriptCache.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.append(s);
  });
  scriptCache.set(src, p);
  return p;
}

// ===================== PREFERENCES =====================
const PREF_KEY = 'docscan.prefs.v1';
export const DEFAULT_PREFS = {
  theme: 'system',
  imageQuality: 0.92,
  maxProcessDim: 3500,
  pdfPageSize: 'a4',
  pdfOrientation: 'portrait',
  pdfQuality: 0.82,
  pdfPassword: '',
  imageFormat: 'jpeg',
  ocrLang: 'eng',
  autoCapture: true,
  autoEnhance: true,
  maxCaptureWidth: 4096
};

export const prefs = {
  data: { ...DEFAULT_PREFS },
  load() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (raw) this.data = { ...DEFAULT_PREFS, ...JSON.parse(raw) };
    } catch {}
    this.applyTheme();
    return this.data;
  },
  save(patch = {}) {
    this.data = { ...this.data, ...patch };
    localStorage.setItem(PREF_KEY, JSON.stringify(this.data));
    if ('theme' in patch) this.applyTheme();
    return this.data;
  },
  applyTheme() {
    let theme = this.data.theme;
    if (theme === 'system') {
      theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#0d1117' : '#1a73e8';
  }
};
