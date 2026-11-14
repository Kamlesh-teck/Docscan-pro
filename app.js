import { $, $$, prefs, toast, confirmDialog, promptDialog, showLoading, hideLoading, blobToCanvas, canvasToBlob, makeThumb, sleep } from './core.js';
import { db, session, addPageToDocument } from './store.js';
import { setNavigator, navigate } from './nav.js';
import { getScanner } from './camera.js';
import { openCrop } from './crop.js';
import { openEnhance } from './editor.js';
import { renderHome, renderDocuments, renderTools, renderSettings, renderViewer, renderPdfScreen, bindScreenActions } from './screens.js';

// ===================== BOOT =====================
prefs.load();

// register SW
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// load SortableJS lazily for page reordering
import('./core.js').then(({ loadScript }) => loadScript('https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js')).catch(() => {});

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

// Bottom nav
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
      originalBlob: blob,
      baseBlob: cropped.blob,
      processedBlob: cropped.blob,
      thumbBlob,
      width: cropped.width,
      height: cropped.height,
      filterState: null
    };

    // save to draft or append to existing doc
    let page;
    if (appendToDocId) {
      page = await addPageToDocument(appendToDocId, pageData);
    } else {
      page = await session.addPage(pageData, mode);
    }

    const enhanced = await openEnhance(page, { mode: 'edit' });
    if (enhanced) {
      toast('Page added', 'success');
    }
    if (appendToDocId) {
      doNavigate('viewer', { docId: appendToDocId });
    } else {
      resumeCamera();
    }
  };

  window.__appendDocId = appendToDocId;
  doNavigate('camera');
  await scanner.start(mode);
}

async function resumeCamera() {
  const scanner = getScanner();
  if (window.__appendDocId) {
    doNavigate('viewer', { docId: window.__appendDocId });
    window.__appendDocId = null;
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
  }
});

$('#camera-zoom').addEventListener('input', e => getScanner().setZoom(e.target.value));

// update page count badge
setInterval(() => {
  const n = session.pageIds.length;
  const badge = $('#camera-count');
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
  $('#camera-done').classList.toggle('hidden', n === 0);
}, 800);

// ===================== IMPORT IMAGES =====================
$('#file-images').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  showLoading('Importing images…');
  try {
    let firstPage = null;
    for (let i = 0; i < files.length; i++) {
      setLoadingText(`Processing image ${i + 1} of ${files.length}…`);
      const cropped = await openCrop(files[i], { aspect: 'free' });
      if (!cropped) continue;
      const thumbBlob = await makeThumb(cropped.blob, 420);
      const pageData = {
        originalBlob: files[i], baseBlob: cropped.blob, processedBlob: cropped.blob,
        thumbBlob, width: cropped.width, height: cropped.height, filterState: null
      };
      let page;
      if (window.__appendDocId) page = await addPageToDocument(window.__appendDocId, pageData);
      else page = await session.addPage(pageData, 'document');
      const enhanced = await openEnhance(page, { mode: 'edit' });
      if (enhanced && !firstPage) firstPage = enhanced;
    }
    hideLoading();
    if (window.__appendDocId) {
      doNavigate('viewer', { docId: window.__appendDocId });
      window.__appendDocId = null;
    } else if (session.docId) {
      const id = await session.finish();
      if (id) doNavigate('viewer', { docId: id });
    }
  } catch (err) { hideLoading(); toast('Import failed: ' + err.message, 'error'); }
});

// ===================== IMPORT PDF =====================
$('#file-pdf').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
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
      if (window.__appendDocId) await addPageToDocument(window.__appendDocId, pageData);
      else await session.addPage(pageData, 'document');
    }
    if (window.__appendDocId) { doNavigate('viewer', { docId: window.__appendDocId }); window.__appendDocId = null; }
    else { const id = await session.finish('Imported PDF ' + new Date().toLocaleDateString()); if (id) doNavigate('viewer', { docId: id }); }
    toast('PDF imported', 'success');
  } catch (err) { hideLoading(); toast('PDF import failed: ' + err.message, 'error'); }
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