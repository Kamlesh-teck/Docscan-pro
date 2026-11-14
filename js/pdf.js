import { loadScript, showLoading, hideLoading, toast, downloadBlob, shareBlob, blobToCanvas, canvasToBlob, createCanvas } from './core.js';
import { prefs } from './core.js';

const JSPDF_URL = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

const PAGE_SIZES = {
  a4: [210, 297], a5: [148, 210], letter: [215.9, 279.4]
};

async function ensureJsPDF() {
  if (!window.jspdf) await loadScript(JSPDF_URL);
  return window.jspdf.jsPDF;
}

async function ensurePdfJs() {
  if (!window.pdfjsLib) {
    await loadScript(PDFJS_URL);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
  return window.pdfjsLib;
}

function imageToJpegDataUrl(canvas, quality) {
  return canvas.toDataURL('image/jpeg', quality);
}

export async function createPDF(pages, opts = {}) {
  const jsPDF = await ensureJsPDF();
  const pageSize = opts.pageSize || 'a4';
  const orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
  const quality = Math.min(0.95, Math.max(0.4, opts.quality ?? 0.82));
  const password = opts.password || '';
  const filename = (opts.filename || 'document').replace(/\.pdf$/i, '') + '.pdf';

  let doc;
  if (pageSize === 'original') {
    doc = new jsPDF({ unit: 'mm', format: [210, 297], orientation, compress: true });
  } else {
    const [w, h] = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
    doc = new jsPDF({
      unit: 'mm', format: [w, h], orientation, compress: true,
      ...(password ? { encryption: { userPassword: password, ownerPassword: password, userPermissions: ['print'] } } : {})
    });
  }
  if (password && doc.setEncryption) {
    try { doc.setEncryption(password, password, ['print']); } catch {}
  }

  let first = true;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const canvas = await blobToCanvas(p.blob, 3500);
    const dataUrl = imageToJpegDataUrl(canvas, quality);

    let pw, ph;
    if (pageSize === 'original') {
      pw = canvas.width * 0.264583;
      ph = canvas.height * 0.264583;
      if (orientation === 'landscape' && ph > pw) [pw, ph] = [ph, pw];
      if (first) doc = new jsPDF({ unit: 'mm', format: [pw, ph], compress: true, ...(password ? { encryption: { userPassword: password, ownerPassword: password } } : {}) });
      else doc.addPage([pw, ph], orientation);
    } else {
      const [w, h] = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
      pw = orientation === 'landscape' ? h : w;
      ph = orientation === 'landscape' ? w : h;
      if (!first) doc.addPage([w, h], orientation);
    }
    first = false;

    const margin = 5;
    const availW = pw - margin * 2, availH = ph - margin * 2;
    const imgRatio = canvas.width / canvas.height;
    let w = availW, h = w / imgRatio;
    if (h > availH) { h = availH; w = h * imgRatio; }
    const x = (pw - w) / 2, y = (ph - h) / 2;

    doc.addImage(dataUrl, 'JPEG', x, y, w, h, undefined, 'FAST');

    if (opts.pageNumbers) {
      doc.setFontSize(9);
      doc.setTextColor(120);
      doc.text(`${i + 1} / ${pages.length}`, pw - margin, ph - 2, { align: 'right' });
    }
  }

  if (opts.watermarkText) {
    const total = doc.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      doc.setPage(i);
      doc.saveGraphicsState();
      doc.setGState(new doc.GState({ opacity: 0.12 }));
      doc.setFontSize(46);
      doc.setTextColor(90);
      doc.text(opts.watermarkText, doc.internal.pageSize.getWidth() / 2, doc.internal.pageSize.getHeight() / 2, { align: 'center', angle: 45 });
      doc.restoreGraphicsState();
    }
  }

  const blob = doc.output('blob');
  return { blob, filename };
}

export async function pdfToImages(file, onProgress) {
  const pdfjsLib = await ensurePdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const results = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.94);
    results.push({ blob, width: canvas.width, height: canvas.height });
    onProgress?.(i, pdf.numPages);
  }
  return results;
}

export async function previewPdf(blob) {
  const url = URL.createObjectURL(blob);
  return url;
}

export async function downloadOrSharePdf(blob, filename, share = false) {
  if (share) return shareBlob(blob, filename, filename);
  downloadBlob(blob, filename);
}

export function printPdf(blob) {
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  if (!w) { downloadBlob(blob, 'document.pdf'); toast('Pop-up blocked — PDF downloaded', 'info'); return; }
  setTimeout(() => { try { w.print(); } catch {} }, 1200);
}