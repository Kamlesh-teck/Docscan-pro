import {
  $, $$, el, icon, toast, confirmDialog, promptDialog, showLoading, hideLoading,
  formatDate, formatBytes, downloadBlob, shareBlob, uuid, blobToCanvas, canvasToBlob, createCanvas
} from './core.js';
import { db, session, duplicateDocument, reorderPages, updatePageAndDoc } from './store.js';
import { navigate } from './nav.js';
import { prefs } from './core.js';
import { openCrop } from './crop.js';
import { openEnhance } from './editor.js';
import { createPDF, pdfToImages, previewPdf, downloadOrSharePdf, printPdf } from './pdf.js';
import { recognizeText } from './ocr.js';
import { getScanner } from './camera.js';
import { loadScript } from './core.js';

// ===================== SHARED =====================
const thumbCache = new Map();
function thumbUrl(doc) {
  if (!doc?.coverThumb) return '';
  if (thumbCache.has(doc.id)) return thumbCache.get(doc.id);
  const url = URL.createObjectURL(doc.coverThumb);
  thumbCache.set(doc.id, url);
  return url;
}
function clearThumbCache() {
  for (const url of thumbCache.values()) URL.revokeObjectURL(url);
  thumbCache.clear();
}

function docCard(doc, view = 'grid') {
  const url = thumbUrl(doc);
  if (view === 'list') {
    return `<div class="doc-list-row" data-doc-id="${doc.id}">
      <img class="doc-thumb" src="${url}" alt="" loading="lazy">
      <div class="doc-info"><b>${escapeHtml(doc.name)}</b><small>${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'} · ${formatDate(doc.createdAt)}</small></div>
      <button class="icon-btn" data-doc-menu="${doc.id}">${icon('more_vert')}</button>
    </div>`;
  }
  return `<div class="doc-card" data-doc-id="${doc.id}">
    <img class="doc-thumb" src="${url}" alt="" loading="lazy">
    ${doc.favorite ? `<div class="doc-fav">${icon('star')}</div>` : ''}
    <button class="doc-menu" data-doc-menu="${doc.id}">${icon('more_vert')}</button>
    <div class="doc-info"><b>${escapeHtml(doc.name)}</b><small>${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'} · ${formatDate(doc.createdAt)}</small></div>
  </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===================== HOME =====================
export async function renderHome() {
  const docs = await db.getAllDocuments();
  const totalPages = docs.reduce((a, d) => a + (d.pageCount || 0), 0);
  const recent = docs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
  $('#home-body').innerHTML = `
    <div class="home-greeting">
      <h1>DocScan Pro</h1>
      <p>${docs.length} document${docs.length === 1 ? '' : 's'} · ${totalPages} scanned page${totalPages === 1 ? '' : 's'}</p>
    </div>
    <div class="scan-hero">
      <h2>Scan a document</h2>
      <p>Automatic edge detection, perspective correction and text enhancement.</p>
      <button class="btn" data-action="scan">${icon('document_scanner')} Start scanning</button>
    </div>
    <div class="quick-actions">
      <button class="quick-action" data-action="import-images">${icon('photo_library')}<b>Import images</b><small>From gallery</small></button>
      <button class="quick-action" data-action="import-pdf">${icon('picture_as_pdf')}<b>Import PDF</b><small>Convert to pages</small></button>
    </div>
    <div class="stat-row">
      <div class="stat"><b>${docs.length}</b><small>Documents</small></div>
      <div class="stat"><b>${totalPages}</b><small>Pages</small></div>
    </div>
    <div class="section-title">Recent scans <button data-action="go-documents">View all</button></div>
    <div class="doc-grid" id="home-recent">
      ${recent.length ? recent.map(d => docCard(d)).join('') : `<div class="empty" style="grid-column:1/-1">${icon('folder_open')}<div>No documents yet.<br>Tap Scan to create your first one.</div></div>`}
    </div>`;
  bindScreenActions($('#home-body'));
  $$('#home-recent .doc-card').forEach(card => card.addEventListener('click', e => {
    if (e.target.closest('[data-doc-menu]')) return;
    navigate('viewer', { docId: card.dataset.docId });
  }));
}

// ===================== DOCUMENTS =====================
let docsFilter = 'all', docsSort = 'date', docsView = 'grid', docsQuery = '';

export async function renderDocuments() {
  clearThumbCache();
  const [docs, folders] = await Promise.all([db.getAllDocuments(), db.getFolders()]);
  let list = docs.filter(d => !d.draft);
  if (docsFilter === 'recent') list = list.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
  else if (docsFilter === 'favorites') list = list.filter(d => d.favorite);
  if (docsQuery) list = list.filter(d => d.name.toLowerCase().includes(docsQuery.toLowerCase()));
  list.sort((a, b) => docsSort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt - a.updatedAt);

  $('#documents-body').innerHTML = `
    <div class="section-title" style="margin-top:4px">Documents <button data-action="new-folder">${icon('create_new_folder')} Folder</button></div>
    <div class="doc-toolbar">
      <div class="search-box">${icon('search')}<input id="doc-search" placeholder="Search documents" value="${escapeHtml(docsQuery)}"></div>
      <div class="view-toggle">
        <button data-view="grid" class="${docsView === 'grid' ? 'active' : ''}">${icon('grid_view')}</button>
        <button data-view="list" class="${docsView === 'list' ? 'active' : ''}">${icon('view_list')}</button>
      </div>
    </div>
    <div class="filter-chips">
      <button class="chip ${docsFilter === 'all' ? 'active' : ''}" data-filter="all">All</button>
      <button class="chip ${docsFilter === 'recent' ? 'active' : ''}" data-filter="recent">Recent</button>
      <button class="chip ${docsFilter === 'favorites' ? 'active' : ''}" data-filter="favorites">Favorites</button>
      <button class="chip ${docsSort === 'name' ? 'active' : ''}" data-sort="name">A–Z</button>
      ${folders.map(f => `<button class="chip" data-folder="${f.id}">${icon('folder')} ${escapeHtml(f.name)}</button>`).join('')}
    </div>
    <div id="documents-list" class="${docsView === 'grid' ? 'doc-grid' : ''}">
      ${list.length ? list.map(d => docCard(d, docsView)).join('') : `<div class="empty">${icon('folder_open')}<div>No documents found.</div></div>`}
    </div>`;
  bindScreenActions($('#documents-body'));

  $('#doc-search').addEventListener('input', e => {
    docsQuery = e.target.value;
    renderDocuments();
    setTimeout(() => { const i = $('#doc-search'); i?.focus(); i?.setSelectionRange(i.value.length, i.value.length); }, 0);
  });
  $$('[data-filter]').forEach(b => b.onclick = () => { docsFilter = b.dataset.filter; renderDocuments(); });
  $$('[data-sort]').forEach(b => b.onclick = () => { docsSort = docsSort === 'name' ? 'date' : 'name'; renderDocuments(); });
  $$('[data-view]').forEach(b => b.onclick = () => { docsView = b.dataset.view; renderDocuments(); });
  $$('#documents-list [data-doc-id]').forEach(card => card.addEventListener('click', e => {
    if (e.target.closest('[data-doc-menu]')) return;
    navigate('viewer', { docId: card.dataset.docId });
  }));
  $$('[data-doc-menu]').forEach(btn => btn.onclick = e => { e.stopPropagation(); openDocMenu(btn.dataset.docMenu); });
}

async function openDocMenu(docId) {
  const doc = await db.getDocument(docId);
  if (!doc) return;
  const action = await new Promise(resolve => {
    const overlay = el('div', { class: 'modal-overlay' });
    const close = v => { overlay.remove(); resolve(v); };
    const modal = el('div', { class: 'modal' },
      el('h3', {}, doc.name),
      el('div', { style: 'display:flex;flex-direction:column;gap:4px' },
        menuItem('edit', 'Rename', () => close('rename')),
        menuItem('content_copy', 'Duplicate', () => close('duplicate')),
        menuItem(doc.favorite ? 'star' : 'star_border', doc.favorite ? 'Remove favorite' : 'Add favorite', () => close('favorite')),
        menuItem('drive_file_move', 'Move to folder', () => close('move')),
        menuItem('delete', 'Delete', () => close('delete'), '#e53935')
      ),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancel'))
    );
    overlay.append(modal); document.body.append(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    function menuItem(ic, label, fn, color) {
      return el('button', { style: `display:flex;align-items:center;gap:12px;padding:13px 8px;font-size:14px;color:${color || 'inherit'}`, onclick: fn }, icon(ic), label);
    }
  });
  if (!action) return;
  if (action === 'rename') {
    const name = await promptDialog('Rename document', doc.name);
    if (name) await db.updateDocument(docId, { name, updatedAt: Date.now() });
  } else if (action === 'duplicate') {
    showLoading('Duplicating…'); await duplicateDocument(docId); hideLoading(); toast('Document duplicated', 'success');
  } else if (action === 'favorite') {
    await db.updateDocument(docId, { favorite: !doc.favorite });
  } else if (action === 'delete') {
    if (await confirmDialog('Delete document?', `“${doc.name}” and all its pages will be permanently deleted.`, { okText: 'Delete' })) {
      await db.deleteDocumentFull(docId);
      toast('Document deleted', 'success');
    }
  } else if (action === 'move') {
    const folders = await db.getFolders();
    if (!folders.length) { toast('Create a folder first', 'info'); return; }
    const fid = await new Promise(resolve => {
      const overlay = el('div', { class: 'modal-overlay' });
      const close = v => { overlay.remove(); resolve(v); };
      overlay.append(el('div', { class: 'modal' },
        el('h3', {}, 'Move to folder'),
        el('div', { style: 'display:flex;flex-direction:column;gap:4px' },
          folders.map(f => el('button', { style: 'display:flex;align-items:center;gap:10px;padding:13px 8px', onclick: () => close(f.id) }, icon('folder'), f.name)),
          el('button', { style: 'padding:13px 8px;color:var(--muted)', onclick: () => close(null) }, 'No folder')
        )
      ));
      document.body.append(overlay); requestAnimationFrame(() => overlay.classList.add('show'));
    });
    if (fid !== undefined) await db.updateDocument(docId, { folderId: fid });
  }
  renderHome(); renderDocuments();
}

// ===================== TOOLS =====================
export function renderTools() {
  $('#tools-body').innerHTML = `
    <div class="section-title" style="margin-top:4px">Scanning tools</div>
    <div class="tool-grid">
      ${tool('photo_library', 'Import images', 'import-images')}
      ${tool('picture_as_pdf', 'Import PDF', 'import-pdf')}
      ${tool('badge', 'Scan ID card', 'scan-id')}
      ${tool('receipt_long', 'Scan receipt', 'scan-receipt')}
      ${tool('business_center', 'Business card', 'scan-business')}
      ${tool('qr_code_scanner', 'QR / Barcode', 'scan-qr')}
      ${tool('auto_awesome_motion', 'Batch scan', 'scan-batch')}
      ${tool('create_new_folder', 'Create folder', 'new-folder')}
      ${tool('image', 'PDF to images', 'pdf-to-images')}
      ${tool('draw', 'Signature', 'tool-signature')}
      ${tool('branding_watermark', 'Watermark', 'tool-watermark')}
      ${tool('print', 'Print', 'tool-print')}
    </div>`;
  bindScreenActions($('#tools-body'));
}

function tool(ic, label, action) {
  return `<button class="tool-card" data-action="${action}">${icon(ic)}<small>${label}</small></button>`;
}

// ===================== SETTINGS =====================
export function renderSettings() {
  const p = prefs.data;
  $('#settings-body').innerHTML = `
    <div class="section-title" style="margin-top:4px">Settings</div>
    <div class="settings-group">
      <div class="settings-row">${icon('dark_mode')}<div class="label"><b>Theme</b><small>Light, dark or system</small></div>
        <select id="set-theme"><option value="system" ${p.theme === 'system' ? 'selected' : ''}>System</option><option value="light" ${p.theme === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${p.theme === 'dark' ? 'selected' : ''}>Dark</option></select>
      </div>
      <div class="settings-row">${icon('photo_size_select_large')}<div class="label"><b>Image quality</b><small>JPEG export quality</small></div>
        <input type="range" id="set-quality" min="60" max="100" value="${Math.round(p.imageQuality * 100)}">
      </div>
      <div class="settings-row">${icon('picture_as_pdf')}<div class="label"><b>Default PDF page size</b><small>A4, A5 or Letter</small></div>
        <select id="set-pdfsize"><option value="a4" ${p.pdfPageSize === 'a4' ? 'selected' : ''}>A4</option><option value="a5" ${p.pdfPageSize === 'a5' ? 'selected' : ''}>A5</option><option value="letter" ${p.pdfPageSize === 'letter' ? 'selected' : ''}>Letter</option></select>
      </div>
      <div class="settings-row">${icon('high_quality')}<div class="label"><b>PDF quality</b><small>Higher = larger file</small></div>
        <input type="range" id="set-pdfquality" min="40" max="95" value="${Math.round(p.pdfQuality * 100)}">
      </div>
      <div class="settings-row">${icon('translate')}<div class="label"><b>OCR language</b><small>English, Hindi, Gujarati</small></div>
        <select id="set-ocrlang"><option value="eng" ${p.ocrLang === 'eng' ? 'selected' : ''}>English</option><option value="hin" ${p.ocrLang === 'hin' ? 'selected' : ''}>Hindi</option><option value="guj" ${p.ocrLang === 'guj' ? 'selected' : ''}>Gujarati</option><option value="eng+hin+guj" ${p.ocrLang === 'eng+hin+guj' ? 'selected' : ''}>All three</option></select>
      </div>
      <div class="settings-row">${icon('auto_awesome')}<div class="label"><b>Auto capture</b><small>Capture when document is stable</small></div>
        <label class="switch"><input type="checkbox" id="set-autocapture" ${p.autoCapture ? 'checked' : ''}><span></span></label>
      </div>
      <div class="settings-row">${icon('tune')}<div class="label"><b>Auto enhance</b><small>Apply Auto preset after capture</small></div>
        <label class="switch"><input type="checkbox" id="set-autoenhance" ${p.autoEnhance ? 'checked' : ''}><span></span></label>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-row">${icon('storage')}<div class="label"><b>Storage</b><small id="storage-text">Calculating…</small></div></div>
      <div class="settings-row">${icon('cleaning_services')}<div class="label"><b>Clear cache</b><small>Removes cached CDN assets</small></div><button class="btn ghost small" data-action="clear-cache">Clear</button></div>
      <div class="settings-row">${icon('delete_forever')}<div class="label"><b>Delete all data</b><small>Documents, pages and folders</small></div><button class="btn danger small" data-action="delete-all">Delete</button></div>
    </div>
    <div class="settings-group">
      <div class="settings-row">${icon('info')}<div class="label"><b>About DocScan Pro</b><small>Version 1.0 · Offline-capable PWA</small></div></div>
      <div class="settings-row">${icon('privacy_tip')}<div class="label"><b>Privacy</b><small>All processing happens on your device. Nothing is uploaded.</small></div></div>
    </div>`;

  bindScreenActions($('#settings-body'));
  $('#set-theme').onchange = e => { prefs.save({ theme: e.target.value }); };
  $('#set-quality').oninput = e => prefs.save({ imageQuality: parseInt(e.target.value) / 100 });
  $('#set-pdfsize').onchange = e => prefs.save({ pdfPageSize: e.target.value });
  $('#set-pdfquality').oninput = e => prefs.save({ pdfQuality: parseInt(e.target.value) / 100 });
  $('#set-ocrlang').onchange = e => prefs.save({ ocrLang: e.target.value });
  $('#set-autocapture').onchange = e => prefs.save({ autoCapture: e.target.checked });
  $('#set-autoenhance').onchange = e => prefs.save({ autoEnhance: e.target.checked });

  db.estimate().then(({ usage, quota }) => {
    const t = $('#storage-text');
    if (t) t.textContent = `${formatBytes(usage)} used of ${formatBytes(quota)} available`;
  });
}

// ===================== VIEWER =====================
let viewerDocId = null;
let viewerPages = [];

export async function renderViewer(docId) {
  viewerDocId = docId;
  const doc = await db.getDocument(docId);
  if (!doc) { navigate('documents'); return; }
  viewerPages = await db.getPages(docId);
  $('#viewer-topbar').innerHTML = `
    <button class="icon-btn" data-action="viewer-back">${icon('arrow_back')}</button>
    <span class="topbar-title">${escapeHtml(doc.name)}</span>
    <div class="topbar-actions">
      <button class="icon-btn" data-action="viewer-fav">${icon(doc.favorite ? 'star' : 'star_border')}</button>
      <button class="icon-btn" data-action="viewer-menu">${icon('more_vert')}</button>
    </div>`;

  $('#viewer-body').innerHTML = `
    <div class="viewer-hero">
      <img class="cover" src="${thumbUrl(doc)}" alt="">
      <div class="meta">
        <h2>${escapeHtml(doc.name)}</h2>
        <p>${viewerPages.length} page${viewerPages.length === 1 ? '' : 's'} · ${formatDate(doc.createdAt)}</p>
      </div>
    </div>
    <div class="action-row">
      ${actionPill('add', 'Add page')}
      ${actionPill('document_scanner', 'OCR')}
      ${actionPill('picture_as_pdf', 'PDF')}
      ${actionPill('share', 'Share')}
      ${actionPill('print', 'Print')}
      ${actionPill('content_copy', 'Duplicate')}
    </div>
    <div class="section-title">Pages <span style="font-size:12px;color:var(--muted)">Drag to reorder</span></div>
    <div class="page-list" id="page-list">
      ${viewerPages.map((p, i) => `
        <div class="page-card" data-page-id="${p.id}">
          <span class="page-drag material-symbols-rounded">drag_indicator</span>
          <img class="page-thumb" src="${p.thumbBlob ? URL.createObjectURL(p.thumbBlob) : ''}" alt="" loading="lazy">
          <div class="page-info"><b>Page ${i + 1}</b><small>${p.width} × ${p.height}</small></div>
          <div class="page-actions">
            <button data-page-edit="${p.id}">${icon('edit')}</button>
            <button data-page-menu="${p.id}">${icon('more_vert')}</button>
          </div>
        </div>`).join('')}
    </div>`;

  bindViewerActions(doc);
  setupPageSorting();
}

function actionPill(ic, label) {
  return `<button class="action-pill" data-action="viewer-${label.toLowerCase().replace(/ /g, '-')}">${icon(ic)}${label}</button>`;
}

function bindViewerActions(doc) {
  $('#viewer-topbar').onclick = async e => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (a === 'viewer-back') navigate('documents');
    if (a === 'viewer-fav') {
      await db.updateDocument(doc.id, { favorite: !doc.favorite });
      renderViewer(doc.id);
    }
    if (a === 'viewer-menu') openViewerMenu(doc);
  };
  $('#viewer-body').onclick = async e => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (a === 'viewer-add-page') startCamera('document', doc.id);
    if (a === 'viewer-ocr') openOcrDialog(doc.id);
    if (a === 'viewer-pdf') navigate('pdf', { docId: doc.id });
    if (a === 'viewer-share') shareDocument(doc.id);
    if (a === 'viewer-print') printDocument(doc.id);
    if (a === 'viewer-duplicate') { showLoading('Duplicating…'); const d = await duplicateDocument(doc.id); hideLoading(); navigate('viewer', { docId: d.id }); }
    const edit = e.target.closest('[data-page-edit]');
    if (edit) editPage(edit.dataset.pageEdit);
    const menu = e.target.closest('[data-page-menu]');
    if (menu) openPageMenu(menu.dataset.pageMenu);
  };
}

function setupPageSorting() {
  const list = $('#page-list');
  if (!list || !window.Sortable) return;
  new window.Sortable(list, {
    handle: '.page-drag',
    animation: 180,
    onEnd: async () => {
      const ids = $$('#page-list .page-card').map(c => c.dataset.pageId);
      await reorderPages(viewerDocId, ids);
      toast('Pages reordered', 'success');
      renderViewer(viewerDocId);
    }
  });
}

async function editPage(pageId) {
  const page = await db.getPage(pageId);
  if (!page) return;
  const updated = await openEnhance(page, { mode: 'edit' });
  if (updated) renderViewer(viewerDocId);
}

async function openPageMenu(pageId) {
  const action = await new Promise(resolve => {
    const overlay = el('div', { class: 'modal-overlay' });
    const close = v => { overlay.remove(); resolve(v); };
    overlay.append(el('div', { class: 'modal' },
      el('h3', {}, 'Page actions'),
      el('div', { style: 'display:flex;flex-direction:column;gap:4px' },
        el('button', { style: 'display:flex;gap:12px;padding:13px 8px', onclick: () => close('edit') }, icon('edit'), 'Edit page'),
        el('button', { style: 'display:flex;gap:12px;padding:13px 8px', onclick: () => close('duplicate') }, icon('content_copy'), 'Duplicate page'),
        el('button', { style: 'display:flex;gap:12px;padding:13px 8px;color:#e53935', onclick: () => close('delete') }, icon('delete'), 'Delete page')
      ),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancel'))
    ));
    document.body.append(overlay); requestAnimationFrame(() => overlay.classList.add('show'));
  });
  if (action === 'edit') editPage(pageId);
  if (action === 'duplicate') {
    const p = await db.getPage(pageId);
    const pages = await db.getPages(viewerDocId);
    await db.putPage({ ...p, id: uuid(), index: pages.length, docId: viewerDocId });
    await db.updateDocument(viewerDocId, { pageCount: pages.length + 1, updatedAt: Date.now() });
    renderViewer(viewerDocId);
  }
  if (action === 'delete') {
    if (await confirmDialog('Delete page?', 'This page will be removed from the document.', { okText: 'Delete' })) {
      await db.deletePage(pageId);
      const pages = await db.getPages(viewerDocId);
      for (let i = 0; i < pages.length; i++) { pages[i].index = i; await db.putPage(pages[i]); }
      await db.updateDocument(viewerDocId, { pageCount: pages.length, updatedAt: Date.now(), coverThumb: pages[0]?.thumbBlob || null });
      renderViewer(viewerDocId);
    }
  }
}

async function openViewerMenu(doc) {
  const action = await new Promise(resolve => {
    const overlay = el('div', { class: 'modal-overlay' });
    const close = v => { overlay.remove(); resolve(v); };
    overlay.append(el('div', { class: 'modal' },
      el('h3', {}, 'Document actions'),
      el('div', { style: 'display:flex;flex-direction:column;gap:4px' },
        el('button', { style: 'display:flex;gap:12px;padding:13px 8px', onclick: () => close('rename') }, icon('edit'), 'Rename'),
        el('button', { style: 'display:flex;gap:12px;padding:13px 8px', onclick: () => close('duplicate') }, icon('content_copy'), 'Duplicate'),
        el('button', { style: 'display:flex;gap:12px;padding:13px 8px;color:#e53935', onclick: () => close('delete') }, icon('delete'), 'Delete document')
      ),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancel'))
    ));
    document.body.append(overlay); requestAnimationFrame(() => overlay.classList.add('show'));
  });
  if (action === 'rename') {
    const name = await promptDialog('Rename document', doc.name);
    if (name) { await db.updateDocument(doc.id, { name, updatedAt: Date.now() }); renderViewer(doc.id); }
  }
  if (action === 'duplicate') { const d = await duplicateDocument(doc.id); navigate('viewer', { docId: d.id }); }
  if (action === 'delete') {
    if (await confirmDialog('Delete document?', 'All pages will be deleted permanently.', { okText: 'Delete' })) {
      await db.deleteDocumentFull(doc.id); navigate('documents');
    }
  }
}

async function shareDocument(docId) {
  showLoading('Preparing PDF…');
  try {
    const doc = await db.getDocument(docId);
    const pages = await db.getPages(docId);
    const { blob, filename } = await createPDF(pages.map(p => ({ blob: p.processedBlob })), {
      pageSize: prefs.data.pdfPageSize, quality: prefs.data.pdfQuality, filename: doc.name
    });
    hideLoading();
    await shareBlob(blob, filename, doc.name);
  } catch (e) { hideLoading(); toast('Share failed: ' + e.message, 'error'); }
}

async function printDocument(docId) {
  showLoading('Preparing print…');
  try {
    const doc = await db.getDocument(docId);
    const pages = await db.getPages(docId);
    const { blob } = await createPDF(pages.map(p => ({ blob: p.processedBlob })), {
      pageSize: prefs.data.pdfPageSize, quality: prefs.data.pdfQuality, filename: doc.name
    });
    hideLoading(); printPdf(blob);
  } catch (e) { hideLoading(); toast('Print failed: ' + e.message, 'error'); }
}

// ===================== OCR DIALOG =====================
export async function openOcrDialog(docId) {
  const doc = await db.getDocument(docId);
  const pages = await db.getPages(docId);
  if (!pages.length) { toast('No pages to recognize', 'info'); return; }
  const lang = prefs.data.ocrLang;
  showLoading('Starting OCR engine…');
  try {
    const results = [];
    for (let i = 0; i < pages.length; i++) {
      setLoadingText(`Recognizing page ${i + 1} of ${pages.length}…`);
      const r = await recognizeText(pages[i].processedBlob, lang, m => {
        if (m.status === 'loading') setLoadingText(`Downloading OCR data… ${Math.round((m.progress || 0) * 100)}%`);
      });
      results.push(r.text);
    }
    hideLoading();
    const text = results.join('\n\n--- Page break ---\n\n');
    showOcrResult(doc, text);
  } catch (e) {
    hideLoading();
    toast('OCR failed: ' + e.message, 'error', 4000);
  }
}

function showOcrResult(doc, text) {
  const overlay = el('div', { class: 'modal-overlay show' });
  const modal = el('div', { class: 'modal', style: 'max-width:520px' });
  modal.append(
    el('h3', {}, 'Recognized text'),
    el('textarea', { class: 'ocr-area', id: 'ocr-text' }, text),
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px' },
      el('button', { class: 'btn ghost small', onclick: async () => { await navigator.clipboard.writeText($('#ocr-text').value); toast('Copied', 'success'); } }, 'Copy'),
      el('button', { class: 'btn ghost small', onclick: () => downloadBlob(new Blob([$('#ocr-text').value], { type: 'text/plain' }), (doc.name || 'ocr') + '.txt') }, 'Export TXT'),
      el('button', { class: 'btn small', onclick: async () => { await db.updateDocument(doc.id, { ocrText: $('#ocr-text').value }); toast('OCR text saved', 'success'); overlay.remove(); } }, 'Save to document'),
      el('button', { class: 'btn ghost small', onclick: () => overlay.remove() }, 'Close')
    )
  );
  overlay.append(modal); document.body.append(overlay);
}

// ===================== PDF SCREEN =====================
let pdfPages = [], pdfDoc = null;

export async function renderPdfScreen(docId) {
  pdfDoc = await db.getDocument(docId);
  pdfPages = await db.getPages(docId);
  $('#pdf-topbar').innerHTML = `
    <button class="icon-btn" data-action="pdf-back">${icon('arrow_back')}</button>
    <span class="topbar-title">Create PDF</span>
    <button class="icon-btn" data-action="pdf-generate">${icon('check')}</button>`;
  $('#pdf-body').innerHTML = `
    <div class="card">
      <div class="section-title" style="margin:0 0 10px">Pages <span style="font-size:12px;color:var(--muted)">Drag to reorder</span></div>
      <div class="page-list" id="pdf-page-list">
        ${pdfPages.map((p, i) => `<div class="page-card" data-page-id="${p.id}"><span class="page-drag material-symbols-rounded">drag_indicator</span><img class="page-thumb" src="${URL.createObjectURL(p.thumbBlob)}" alt=""><div class="page-info"><b>Page ${i + 1}</b><small>${p.width} × ${p.height}</small></div></div>`).join('')}
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="option-grid">
        <div class="option-field"><label>Page size</label><select id="pdf-size"><option value="a4">A4</option><option value="a5">A5</option><option value="letter">Letter</option><option value="original">Original</option></select></div>
        <div class="option-field"><label>Orientation</label><select id="pdf-orientation"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></div>
        <div class="option-field"><label>Quality</label><input type="range" id="pdf-quality" min="40" max="95" value="${Math.round(prefs.data.pdfQuality * 100)}"></div>
        <div class="option-field"><label>Password (optional)</label><input type="password" id="pdf-password" placeholder="Leave empty"></div>
      </div>
      <div class="option-field" style="margin-top:10px"><label>Filename</label><input type="text" id="pdf-filename" value="${escapeHtml(pdfDoc.name)}"></div>
      <div class="option-field" style="margin-top:10px"><label>Watermark text (optional)</label><input type="text" id="pdf-watermark" placeholder="e.g. CONFIDENTIAL"></div>
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center"><input type="checkbox" id="pdf-pagenumbers"><label for="pdf-pagenumbers" style="font-size:13px">Add page numbers</label></div>
    </div>
    <div style="display:flex;gap:10px;margin-top:14px">
      <button class="btn ghost block" data-action="pdf-preview">${icon('visibility')} Preview</button>
      <button class="btn block" data-action="pdf-generate">${icon('download')} Generate PDF</button>
    </div>
    <div id="pdf-preview-wrap"></div>`;

  $('#pdf-topbar').onclick = e => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (a === 'pdf-back') navigate('viewer', { docId });
    if (a === 'pdf-generate') generatePdf(docId, false);
  };
  $('#pdf-body').onclick = e => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (a === 'pdf-preview') generatePdf(docId, true);
    if (a === 'pdf-generate') generatePdf(docId, false);
  };
  if (window.Sortable) {
    new window.Sortable($('#pdf-page-list'), {
      handle: '.page-drag', animation: 180,
      onEnd: () => {
        pdfPages = $$('#pdf-page-list .page-card').map(c => pdfPages.find(p => p.id === c.dataset.pageId));
      }
    });
  }
}

async function generatePdf(docId, previewOnly) {
  const options = {
    pageSize: $('#pdf-size')?.value || 'a4',
    orientation: $('#pdf-orientation')?.value || 'portrait',
    quality: parseInt($('#pdf-quality')?.value || '82') / 100,
    password: $('#pdf-password')?.value || '',
    filename: $('#pdf-filename')?.value || 'document',
    watermarkText: $('#pdf-watermark')?.value || '',
    pageNumbers: $('#pdf-pagenumbers')?.checked || false
  };
  showLoading('Building PDF…');
  try {
    const { blob, filename } = await createPDF(pdfPages.map(p => ({ blob: p.processedBlob })), options);
    hideLoading();
    if (previewOnly) {
      const url = await previewPdf(blob);
      $('#pdf-preview-wrap').innerHTML = `<iframe class="pdf-preview-frame" src="${url}"></iframe>
        <div style="display:flex;gap:10px;margin-top:10px"><button class="btn ghost block" onclick="window.open('${url}','_blank')">Open</button>
        <button class="btn block" id="pdf-download-btn">Download</button></div>`;
      $('#pdf-download-btn').onclick = () => downloadOrSharePdf(blob, filename);
    } else {
      downloadOrSharePdf(blob, filename);
      toast('PDF saved', 'success');
    }
  } catch (e) {
    hideLoading();
    toast('PDF generation failed: ' + e.message, 'error', 4000);
  }
}

// ===================== SIGNATURE DIALOG =====================
export function openSignatureDialog() {
  return new Promise(resolve => {
    const overlay = el('div', { class: 'modal-overlay show' });
    const canvas = createCanvas(600, 240);
    canvas.style.cssText = 'width:100%;border-radius:12px;background:#fff;touch-action:none;border:1px solid var(--border)';
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
    let drawing = false;
    const pos = e => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
    };
    canvas.addEventListener('pointerdown', e => { drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', e => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
    canvas.addEventListener('pointerup', () => drawing = false);
    const modal = el('div', { class: 'modal' },
      el('h3', {}, 'Draw signature'),
      canvas,
      el('div', { class: 'modal-actions', style: 'margin-top:14px' },
        el('button', { class: 'btn ghost', onclick: () => { overlay.remove(); resolve(null); } }, 'Cancel'),
        el('button', { class: 'btn ghost', onclick: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); } }, 'Clear'),
        el('button', { class: 'btn', onclick: () => { const url = canvas.toDataURL('image/png'); overlay.remove(); resolve(url); } }, 'Insert')
      )
    );
    overlay.append(modal); document.body.append(overlay);
  });
}

// ===================== ACTION BINDING =====================
function bindScreenActions(root) {
  root.onclick = e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'scan' || action === 'scan-batch') startCamera(action === 'scan-batch' ? 'document' : 'document');
    if (action === 'import-images') $('#file-images').click();
    if (action === 'import-pdf') $('#file-pdf').click();
    if (action === 'scan-id') startCamera('id');
    if (action === 'scan-receipt') startCamera('receipt');
    if (action === 'scan-business') startCamera('business');
    if (action === 'scan-qr') startCamera('qr');
    if (action === 'new-folder') createFolder();
    if (action === 'go-documents') navigate('documents');
    if (action === 'clear-cache') clearCache();
    if (action === 'delete-all') deleteAllData();
    if (action === 'pdf-to-images') $('#file-pdf').click();
    if (action === 'tool-signature') toast('Open a page in the editor to add a signature', 'info');
    if (action === 'tool-watermark') toast('Open a page in the editor to add a watermark', 'info');
    if (action === 'tool-print') toast('Open a document and use Print', 'info');
  };
}

async function createFolder() {
  const name = await promptDialog('New folder', '', { placeholder: 'Folder name', okText: 'Create' });
  if (!name) return;
  await db.putFolder({ id: uuid(), name, createdAt: Date.now() });
  toast('Folder created', 'success');
  if ($('#screen-documents').classList.contains('active')) renderDocuments();
}

async function clearCache() {
  if (!(await confirmDialog('Clear cache?', 'Cached CDN assets will be removed. Documents are not affected.', { danger: false, okText: 'Clear' }))) return;
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  toast('Cache cleared', 'success');
}

async function deleteAllData() {
  if (!(await confirmDialog('Delete all data?', 'Every document, page and folder will be permanently deleted.', { okText: 'Delete all' }))) return;
  const docs = await db.getAllDocuments();
  for (const d of docs) await db.deleteDocumentFull(d.id);
  const folders = await db.getFolders();
  for (const f of folders) await db.deleteFolder(f.id);
  toast('All data deleted', 'success');
  renderHome(); renderDocuments();
}

async function startCamera(mode, appendToDocId = null) {
  const { getScanner } = await import('./camera.js');
  const { navigate } = await import('./nav.js');
  const scanner = getScanner();
  window.__appendDocId = appendToDocId;
  navigate('camera');
  await scanner.start(mode);
}

// Export for app.js
export { bindScreenActions, startCamera, thumbUrl, clearThumbCache };