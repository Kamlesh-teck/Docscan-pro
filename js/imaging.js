import { createCanvas, clamp, tick, loadScript } from './core.js';

// ===================== OPENCV =====================
const OPENCV_URL = 'https://docs.opencv.org/4.10.0/opencv.js';
let cvPromise = null;

export function initOpenCV() {
  if (cvPromise) return cvPromise;
  cvPromise = (async () => {
    if (window.cv?.Mat) return window.cv;
    try { await loadScript(OPENCV_URL); } catch { return null; }
    let cv = window.cv;
    if (cv && typeof cv.then === 'function') { cv = await cv; window.cv = cv; }
    if (cv?.Mat) return cv;
    if (!cv) return null;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenCV timeout')), 30000);
      cv.onRuntimeInitialized = () => { clearTimeout(timer); resolve(); };
    });
    return cv;
  })().catch(() => null);
  return cvPromise;
}

export async function opencvReady() { return !!(await initOpenCV()); }

// ===================== CORNER ORDERING =====================
export function orderCorners(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = bySum[0], br = bySum[3];
  const byDiff = [...pts].sort((a, b) => (a.x - a.y) - (b.x - b.y));
  const bl = byDiff[0], tr = byDiff[3];
  return [tl, tr, br, bl];
}

// ===================== EDGE DETECTION =====================
export async function detectCorners(srcCanvas) {
  const cv = await initOpenCV();
  if (!cv) return null;
  let src, gray, blurred, edges, kernel, contours, hierarchy;
  try {
    src = cv.imread(srcCanvas);
    const maxDim = 900;
    const scale = Math.min(1, maxDim / Math.max(src.cols, src.rows));
    let work = src;
    if (scale < 1) {
      work = new cv.Mat();
      cv.resize(src, work, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)));
    }
    gray = new cv.Mat();
    cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY);
    blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    edges = new cv.Mat();
    cv.Canny(blurred, edges, 50, 150);
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let best = null, bestArea = 0;
    const imgArea = work.cols * work.rows;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const peri = cv.arcLength(c, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = Math.abs(cv.contourArea(approx));
        if (area > bestArea && area > imgArea * 0.12) {
          bestArea = area;
          if (best) best.delete();
          best = approx.clone();
        }
      }
      approx.delete(); c.delete();
    }
    if (!best) return null;
    const pts = [];
    for (let i = 0; i < 4; i++) {
      pts.push({ x: best.data32S[i * 2] / scale, y: best.data32S[i * 2 + 1] / scale });
    }
    return orderCorners(pts);
  } catch (e) {
    return null;
  } finally {
    [src, gray, blurred, edges, kernel, contours, hierarchy].forEach(m => { try { m?.delete?.(); } catch {} });
  }
}

// ===================== PERSPECTIVE WARP =====================
export async function warpPerspective(srcCanvas, corners, outW, outH) {
  const cv = await initOpenCV();
  if (cv) {
    let src, srcTri, dstTri, M, dst;
    try {
      src = cv.imread(srcCanvas);
      srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        corners[0].x, corners[0].y, corners[1].x, corners[1].y,
        corners[2].x, corners[2].y, corners[3].x, corners[3].y
      ]);
      dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
      M = cv.getPerspectiveTransform(srcTri, dstTri);
      dst = new cv.Mat();
      cv.warpPerspective(src, dst, M, new cv.Size(outW, outH),
        cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
      const out = createCanvas(outW, outH);
      cv.imshow(out, dst);
      return out;
    } catch { /* fall through to JS */ }
    finally { [src, srcTri, dstTri, M, dst].forEach(m => { try { m?.delete?.(); } catch {} }); }
  }
  return perspectiveWarpJS(srcCanvas, corners, outW, outH);
}

// ---- pure JS fallback ----
function solve8(A, b) {
  const n = 8;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const pv = M[col][col];
    if (Math.abs(pv) < 1e-12) return null;
    for (let c = col; c <= n; c++) M[col][c] /= pv;
    for (let r = 0; r < n; r++) if (r !== col) {
      const f = M[r][col]; if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map(r => r[n]);
}

function homography(dstPts, srcPts) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = dstPts[i], { x: u, y: v } = srcPts[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve8(A, b);
  return h ? [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] : null;
}

export async function perspectiveWarpJS(srcCanvas, corners, outW, outH) {
  const sw = srcCanvas.width, sh = srcCanvas.height;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const sData = srcCtx.getImageData(0, 0, sw, sh).data;
  const dstPts = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
  const H = homography(dstPts, corners);
  if (!H) return null;
  const out = createCanvas(outW, outH);
  const outCtx = out.getContext('2d');
  const outData = outCtx.createImageData(outW, outH);
  const d = outData.data;
  for (let y = 0; y < outH; y++) {
    const hy1 = H[1] * y + H[2], hy4 = H[4] * y + H[5], hy7 = H[7] * y + H[8];
    for (let x = 0; x < outW; x++) {
      const den = H[6] * x + hy7;
      const u = (H[0] * x + hy1) / den;
      const v = (H[3] * x + hy4) / den;
      const x0 = Math.floor(u), y0 = Math.floor(v);
      const dx = u - x0, dy = v - y0;
      const o = (y * outW + x) * 4;
      if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) {
        d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = 255; continue;
      }
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4;
      const i01 = ((y0 + 1) * sw + x0) * 4, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        const top = sData[i00 + c] * (1 - dx) + sData[i10 + c] * dx;
        const bot = sData[i01 + c] * (1 - dx) + sData[i11 + c] * dx;
        d[o + c] = top * (1 - dy) + bot * dy;
      }
      d[o + 3] = 255;
    }
    if (y % 180 === 0) await tick();
  }
  outCtx.putImageData(outData, 0, 0);
  return out;
}

// ===================== FILTER PRESETS =====================
export const PRESETS = {
  original: { label: 'Original', mode: 'color', autoLevels: false, brightness: 0, contrast: 0, exposure: 0, saturation: 0, sharpness: 0, shadow: 0, whiten: 0, noise: 0, text: 0 },
  auto: { label: 'Auto Enhance', mode: 'color', autoLevels: true, brightness: 0, contrast: 12, exposure: 4, saturation: 8, sharpness: 18, shadow: 25, whiten: 15, noise: 8, text: 15 },
  document: { label: 'Document', mode: 'color', autoLevels: true, brightness: 4, contrast: 22, exposure: 6, saturation: 0, sharpness: 22, shadow: 60, whiten: 60, noise: 12, text: 30 },
  magic: { label: 'Magic Color', mode: 'color', autoLevels: true, brightness: 2, contrast: 20, exposure: 8, saturation: 30, sharpness: 26, shadow: 30, whiten: 20, noise: 8, text: 12 },
  bw: { label: 'Black & White', mode: 'bw', autoLevels: false, brightness: 0, contrast: 0, exposure: 0, saturation: 0, sharpness: 15, shadow: 0, whiten: 0, noise: 0, text: 10 },
  gray: { label: 'Grayscale', mode: 'gray', autoLevels: true, brightness: 0, contrast: 10, exposure: 0, saturation: 0, sharpness: 15, shadow: 15, whiten: 10, noise: 8, text: 10 },
  highContrast: { label: 'High Contrast', mode: 'color', autoLevels: true, brightness: 0, contrast: 48, exposure: 0, saturation: 5, sharpness: 20, shadow: 20, whiten: 10, noise: 8, text: 20 },
  color: { label: 'Color Boost', mode: 'color', autoLevels: true, brightness: 0, contrast: 14, exposure: 4, saturation: 28, sharpness: 16, shadow: 20, whiten: 10, noise: 6, text: 8 }
};

export function defaultFilterState() { return { ...PRESETS.original }; }

export function applyPreset(name) {
  const p = PRESETS[name] || PRESETS.original;
  return { ...p };
}

// ===================== PIXEL PIPELINE =====================
function autoLevels(data) {
  const hist = new Uint32Array(256);
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    hist[(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0]++;
  }
  const total = len / 4, clip = total * 0.008;
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > clip) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > clip) { hi = i; break; } }
  if (hi <= lo + 8) return;
  const scale = 255 / (hi - lo);
  for (let i = 0; i < len; i += 4) {
    data[i] = clamp((data[i] - lo) * scale);
    data[i + 1] = clamp((data[i + 1] - lo) * scale);
    data[i + 2] = clamp((data[i + 2] - lo) * scale);
  }
}

function removeShadows(data, w, h, amount) {
  const bw = Math.max(1, Math.floor(w / 8)), bh = Math.max(1, Math.floor(h / 8));
  const bg = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let sum = 0, count = 0;
      for (let yy = 0; yy < 8; yy++) {
        const py = Math.min(h - 1, y * 8 + yy);
        for (let xx = 0; xx < 8; xx++) {
          const px = Math.min(w - 1, x * 8 + xx);
          const o = (py * w + px) * 4;
          sum += data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
          count++;
        }
      }
      bg[y * bw + x] = sum / count;
    }
  }
  const blur = new Float32Array(bw * bh);
  const r = 3;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let s = 0, c = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(bh - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(bw - 1, Math.max(0, x + dx));
          s += bg[yy * bw + xx]; c++;
        }
      }
      blur[y * bw + x] = s / c;
    }
  }
  const a = amount / 100;
  for (let y = 0; y < h; y++) {
    const gy = y / 8, y0 = Math.min(bh - 1, Math.floor(gy)), y1 = Math.min(bh - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = x / 8, x0 = Math.min(bw - 1, Math.floor(gx)), x1 = Math.min(bw - 1, x0 + 1), fx = gx - x0;
      const b = (blur[y0 * bw + x0] * (1 - fx) + blur[y0 * bw + x1] * fx) * (1 - fy) +
                (blur[y1 * bw + x0] * (1 - fx) + blur[y1 * bw + x1] * fx) * fy;
      if (b < 1) continue;
      const factor = Math.min(3.5, 255 / b);
      const blend = 1 + (factor - 1) * a;
      const o = (y * w + x) * 4;
      data[o] = clamp(data[o] * blend);
      data[o + 1] = clamp(data[o + 1] * blend);
      data[o + 2] = clamp(data[o + 2] * blend);
    }
  }
}

function whiten(data, amount) {
  const a = amount / 100;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = data[i + c];
      if (v > 150) {
        const t = Math.min(1, (v - 150) / 105);
        data[i + c] = clamp(v + (255 - v) * a * t);
      }
    }
  }
}

function applyLevels(data, brightness, contrast, exposure) {
  const bAdd = brightness * 2.55;
  const cF = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const eF = Math.pow(2, exposure / 50);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp((data[i] * eF + bAdd - 128) * cF + 128);
    data[i + 1] = clamp((data[i + 1] * eF + bAdd - 128) * cF + 128);
    data[i + 2] = clamp((data[i + 2] * eF + bAdd - 128) * cF + 128);
  }
}

function applySaturation(data, saturation) {
  const s = 1 + saturation / 100;
  for (let i = 0; i < data.length; i += 4) {
    const g = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    data[i] = clamp(g + (data[i] - g) * s);
    data[i + 1] = clamp(g + (data[i + 1] - g) * s);
    data[i + 2] = clamp(g + (data[i + 2] - g) * s);
  }
}

function toGrayscale(data) {
  for (let i = 0; i < data.length; i += 4) {
    const g = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    data[i] = data[i + 1] = data[i + 2] = g;
  }
}

function adaptiveThreshold(data, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  }
  const integral = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const r = Math.max(8, Math.floor(Math.min(w, h) / 28));
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - r), y2 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - r), x2 = Math.min(w - 1, x + r);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integral[(y2 + 1) * (w + 1) + x2 + 1] - integral[y1 * (w + 1) + x2 + 1]
        - integral[(y2 + 1) * (w + 1) + x1] + integral[y1 * (w + 1) + x1];
      const mean = sum / count;
      const v = gray[y * w + x] > mean * 0.92 ? 255 : 0;
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
    }
  }
}

function sharpen(data, w, h, amount) {
  const a = amount / 100;
  if (a <= 0) return;
  const src = new Uint8ClampedArray(data);
  const k = [0, -1, 0, -1, 5, -1, 0, -1, 0];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let s = 0, ki = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            s += src[((y + dy) * w + (x + dx)) * 4 + c] * k[ki++];
          }
        }
        data[o + c] = clamp(src[o + c] * (1 - a) + s * a);
      }
    }
  }
}

function noiseReduce(data, w, h, amount) {
  const a = amount / 100;
  if (a <= 0) return;
  const src = new Uint8ClampedArray(data);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            s += src[((y + dy) * w + (x + dx)) * 4 + c];
        data[o + c] = clamp(src[o + c] * (1 - a) + (s / 9) * a);
      }
    }
  }
}

// ===================== ROTATION / FLIP =====================
function transformCanvas(src, rotation = 0, flipH = false, flipV = false) {
  const rot = ((rotation % 360) + 360) % 360;
  let cur = src;
  if (rot === 90 || rot === 270) {
    const tmp = createCanvas(cur.height, cur.width);
    const tctx = tmp.getContext('2d');
    tctx.translate(tmp.width / 2, tmp.height / 2);
    tctx.rotate(rot * Math.PI / 180);
    tctx.drawImage(cur, -cur.width / 2, -cur.height / 2);
    cur = tmp;
  } else if (rot === 180) {
    const tmp = createCanvas(cur.width, cur.height);
    const tctx = tmp.getContext('2d');
    tctx.translate(tmp.width / 2, tmp.height / 2);
    tctx.rotate(Math.PI);
    tctx.drawImage(cur, -cur.width / 2, -cur.height / 2);
    cur = tmp;
  }
  if (flipH || flipV) {
    const tmp = createCanvas(cur.width, cur.height);
    const tctx = tmp.getContext('2d');
    tctx.translate(flipH ? tmp.width : 0, flipV ? tmp.height : 0);
    tctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    tctx.drawImage(cur, 0, 0);
    cur = tmp;
  }
  return cur;
}

// ===================== RENDER FILTERED =====================
export async function renderFiltered(srcCanvas, state, maxDim = 1400) {
  const s = { ...PRESETS.original, ...state };
  let work = transformCanvas(srcCanvas, s.rotation || 0, s.flipH, s.flipV);

  if (maxDim && Math.max(work.width, work.height) > maxDim) {
    const scale = maxDim / Math.max(work.width, work.height);
    const tmp = createCanvas(work.width * scale, work.height * scale);
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(work, 0, 0, tmp.width, tmp.height);
    work = tmp;
  }

  const w = work.width, h = work.height;
  const ctx = work.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  if (s.autoLevels) autoLevels(d);
  if (s.exposure) applyLevels(d, 0, 0, s.exposure);
  if (s.shadow) removeShadows(d, w, h, s.shadow);
  applyLevels(d, s.brightness, s.contrast, 0);
  if (s.mode === 'gray') toGrayscale(d);
  else if (s.mode === 'bw') { adaptiveThreshold(d, w, h); }
  else if (s.saturation) applySaturation(d, s.saturation);

  if (s.noise) noiseReduce(d, w, h, s.noise);
  if (s.whiten) whiten(d, s.whiten);
  if (s.text) sharpen(d, w, h, s.text);
  if (s.sharpness) sharpen(d, w, h, s.sharpness);

  ctx.putImageData(imgData, 0, 0);
  return work;
}