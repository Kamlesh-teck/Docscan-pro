import { $, $$, prefs, toast, confirmDialog, promptDialog, showLoading, hideLoading, setLoadingText, blobToCanvas, canvasToBlob, makeThumb, sleep } from './core.js';
import { db, session, addPageToDocument } from './store.js';
import { setNavigator, navigate } from './nav.js';
import { getScanner } from './camera.js';
import { openCrop } from './crop.js';
import { openEnhance } from './editor.js';
import { renderHome, renderDocuments, renderTools, renderSettings, renderViewer, renderPdfScreen, bindScreenActions } from './screens.js';

// ===================== BOOT =====================
prefs.load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

import('./core.js')
  .then(({ loadScript }) => loadScript('https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js'))
  .catch(() => {});

// ===================== NAVIGATION =====================
const navScreens = ['home', 'documents', 'tools', 'settings'];
const fullscreenScreens = ['camera', 'crop', 'enhance', 'viewer', 'pdf'];

function setActiveNav(name) {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
}

function doNavigate(name, params = {}) {
  if (name === 'home') renderHome();
  if (name === 'documents') renderDocuments();
  if (name === 'tools') renderTools();
  if (name === 'settings') renderSettings();
  if (name === 'viewer' && params.docId) renderViewer(params.docId);
  if (name === 'pdf' && params.docId) renderPdfScreen(params.docId);

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = $(`#screen-${name}`);
  if (!target) return;
  target.classList.add('active');
  document.body.classList.toggle('nav-hidden', fullscreenScreens.includes(name));
  setActiveNav(navScreens.includes(name) ? name : '');
  window.scrollTo(0, 0);
}
setNavigator(doNavigate);

$('#bottom-nav').addEventListener('click', e => {
  const btn = e.target.closest('[data-nav]');
  if (!btn) return;
  const nav = btn.dataset.nav;
  if (nav === 'scan') startScanFlow('document');
  else doNavigate(nav);
});

// ===================== SCAN FLOW =====================
async function startScanFlow(mode = 'document', appendToDocId = null) {
  const scanner = getScanner();
  scanner.onCapture = async blob => {
    scanner.stop();
    const cropped = await openCrop(blob, { aspect: mode === 'id' ? 'custom' : 'free' });
    if (!cropped) { resumeCamera(); return; }

    const thumbBlob = await makeThumb(cropped.blob, 420);
    const pageData = {
      originalBlob: blob, baseBlob: cropped.blob, processedBlob: cropped.blob,
      thumbBlob, width: cropped.width, height: cropped.height, filterState: null
    };

    let page;
    if (appendToDocId) page = await addPageToDocument(appendToDocId, pageData);
    else page = await session.addPage(pageData, mode);

    const enhanced = await openEnhance(page, { mode: 'edit' });
    if (enhanced) toast('Page added', 'success');

    if (appendToDocId) doNavigate('viewer', { docId: appendToDocId });
    else resumeCamera();
  };

  window.__appendDocId = appendToDocId;
  doNavigate('camera');
  await scanner.start(mode);
}

async function resumeCamera() {
  const scanner = getScanner();
  if (window.__appendDocId) {
    const id = window.__appendDocId;
    window.__appendDocId = null;
    doNavigate('viewer', { docId: id });
    return;
  }
  doNavigate('camera');
  await scanner.start(scanner.mode || 'document');
}

// Camera controls
$('#screen-camera').addEventListener('click', async e => {
  const a = e.target.closest('[data-action]')?.dataset.action;
  const scanner = getScanner();
  if (a === 'camera-close') {
    scanner.stop();
    if (session.docId && session.pageIds.length) {
      const save = await confirmDialog('Save scanned pages?', 'You have unsaved pages in this scan session.', { danger: false, okText: 'Save' });
      if (save) {
        const name = await promptDialog('Document name', 'Scan ' + new Date().toLocaleDateString());
        const id = await session.finish(name);
        if (id) doNavigate('viewer', { docId: id });
      } else {
        await session.discard();
        doNavigate('home');
      }
    } else doNavigate('home');
    window.__appendDocId = null;
  }
  if (a === 'camera-shutter') scanner.capture();
  if (a === 'camera-switch') scanner.switchCamera();
  if (a === 'camera-flash') scanner.toggleTorch();
  if (a === 'camera-gallery') $('#file-images').click();
  if (a === 'camera-auto') {
    scanner.auto = !scanner.auto;
    $('#camera-auto-toggle').classList.toggle('on', scanner.auto);
  }
  if (a === 'camera-done') {
    scanner.stop();
    if (!session.docId) { doNavigate('home'); return; }
    const name = await promptDialog('Save document', 'Scan ' + new Date().toLocaleDateString());
    const id = await session.finish(name);
    if (id) doNavigate('viewer', { docId: id });
    window.__appendDocId = null;
  }
});

$('#camera-zoom')?.addEventListener('input', e => getScanner().setZoom(e.target.value));

setInterval(() => {
  const n = session.pageIds.length;
  const badge = $('#camera-count');
  if (!badge) return;
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
  $('#camera-done')?.classList.toggle('hidden', n === 0);
}, 800);

// ===================== ✅ FIXED: IMPORT IMAGES =====================
$('#file-images').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;

  // Snapshot the current "append target" (if user came from viewer → Add Page)
  const appendDocId = window.__appendDocId || null;
  window.__appendDocId = null;

  let addedCount = 0;
  let lastError = null;

  try {
    for (let i = 0; i < files.length; i++) {
      // ---- Step 1: INTERACTIVE CROP (no loading overlay!) ----
      let cropped = null;
      try {
        cropped = await openCrop(files[i], { aspect: 'free' });
      } catch (err) {
        console.error('Crop failed for file', i, err);
        lastError = err;
        continue;
      }
      if (!cropped) {
        // user cancelled this image
        continue;
      }

      // ---- Step 2: brief thumbnail processing (WITH loading) ----
      let thumbBlob = null;
      showLoading(`Processing ${i + 1}/${files.length}…`);
      try {
        thumbBlob = await makeThumb(cropped.blob, 420);
      } catch (err) {
        console.warn('Thumbnail failed', err);
      } finally {
        hideLoading();
      }

      const pageData = {
        originalBlob: files[i],
        baseBlob: cropped.blob,
        processedBlob: cropped.blob,
        thumbBlob,
        width: cropped.width,
        height: cropped.height,
        filterState: null
      };

      // ---- Step 3: save page to DB ----
      let page;
      try {
        if (appendDocId) page = await addPageToDocument(appendDocId, pageData);
        else page = await session.addPage(pageData, 'document');
      } catch (err) {
        console.error('Save failed', err);
        lastError = err;
        continue;
      }

      // ---- Step 4: INTERACTIVE ENHANCE (no loading overlay!) ----
      try {
        await openEnhance(page, { mode: 'edit' });
      } catch (err) {
        console.error('Enhance failed', err);
        // page still saved with raw crop as processed — continue
      }

      addedCount++;
    }

    // ---- Wrap up: route to viewer or home ----
    if (appendDocId) {
      doNavigate('viewer', { docId: appendDocId });
    } else if (session.docId && session.pageIds.length > 0) {
      const id = await session.finish();
      if (id) doNavigate('viewer', { docId: id });
    } else {
      doNavigate('home');
    }

    if (addedCount > 0) {
      toast(`${addedCount} page${addedCount === 1 ? '' : 's'} imported`, 'success');
    } else if (lastError) {
      toast('Import failed: ' + lastError.message, 'error');
    }
  } catch (err) {
    hideLoading(true);
    console.error(err);
    toast('Import failed: ' + err.message, 'error');
    doNavigate('home');
  }
});

// ===================== IMPORT PDF =====================
$('#file-pdf').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const appendDocId = window.__appendDocId || null;
  window.__appendDocId = null;

  showLoading('Reading PDF…');
  try {
    const { pdfToImages } = await import('./pdf.js');
    const pages = await pdfToImages(file, (i, n) => setLoadingText(`Rendering page ${i} of ${n}…`));
    hideLoading();

    for (const p of pages) {
      const thumbBlob = await makeThumb(p.blob, 420);
      const pageData = {
        originalBlob: p.blob, baseBlob: p.blob, processedBlob: p.blob,
        thumbBlob, width: p.width, height: p.height, filterState: null
      };
      if (appendDocId) await addPageToDocument(appendDocId, pageData);
      else await session.addPage(pageData, 'document');
    }

    if (appendDocId) {
      doNavigate('viewer', { docId: appendDocId });
    } else {
      const id = await session.finish('Imported PDF ' + new Date().toLocaleDateString());
      if (id) doNavigate('viewer', { docId: id });
    }
    toast('PDF imported', 'success');
  } catch (err) {
    hideLoading(true);
    console.error(err);
    toast('PDF import failed: ' + err.message, 'error');
  }
});

// ===================== GLOBAL ERROR HANDLING =====================
window.addEventListener('error', e => {
  console.error(e.error || e.message);
  hideLoading(true);
  toast('Something went wrong. Please try again.', 'error', 4000);
});
window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  hideLoading(true);
  toast(e.reason?.message || 'Unexpected error', 'error', 4000);
});

// ===================== START =====================
doNavigate('home');
