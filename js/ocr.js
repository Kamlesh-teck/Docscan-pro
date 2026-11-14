import { loadScript, tick } from './core.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
let worker = null, currentLang = null;

async function ensureTesseract() {
  if (!window.Tesseract) await loadScript(TESSERACT_URL);
  return window.Tesseract;
}

export async function recognizeText(blob, lang = 'eng', onProgress) {
  const Tesseract = await ensureTesseract();
  if (!worker || currentLang !== lang) {
    if (worker) { try { await worker.terminate(); } catch {} }
    worker = await Tesseract.createWorker(lang, 1, {
      logger: m => {
        if (m.status === 'recognizing text') onProgress?.({ status: 'recognizing', progress: m.progress });
        else if (m.status.includes('loading') || m.status.includes('downloading')) onProgress?.({ status: 'loading', progress: m.progress || 0 });
      }
    });
    currentLang = lang;
  }
  const { data } = await worker.recognize(blob);
  return { text: data.text || '', confidence: data.confidence || 0 };
}

export async function terminateOCR() {
  if (worker) { try { await worker.terminate(); } catch {} worker = null; currentLang = null; }
}