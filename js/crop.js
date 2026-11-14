import { $, createCanvas, showLoading, hideLoading, toast } from './core.js';
import { detectCorners, orderCorners, warpPerspective, opencvReady } from './imaging.js';
import { navigate } from './nav.js';

class CropScreen {
  constructor() {
    this.el = $('#screen-crop');
    this.viewCanvas = $('#crop-view');
    this.overlay = $('#crop-overlay');
    this.area = $('#crop-area');
    this.magnifier = $('#crop-magnifier');
    this.magCanvas = $('#magnifier-canvas');
    this.ctx = this.viewCanvas.getContext('2d');
    this.octx = this.overlay.getContext('2d');
    this.imageCanvas = null;
    this.points = [];
    this.dragIndex = -1;
    this.scale = 1;
    this.aspect = 'free';
    this.opts = {};
    this.resolve = null;
    this._bind();
  }

  _bind() {
    this.el.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'crop-cancel') this.cancel();
      if (action === 'crop-done') this.confirm();
      if (action === 'crop-auto') this.autoDetect();
      if (action === 'crop-rotate-left') this.rotate(-90);
      if (action === 'crop-rotate-right') this.rotate(90);
      if (action === 'crop-reset') this.reset();
    });

    $('#aspect-bar').addEventListener('click', async e => {
      const b = e.target.closest('[data-aspect]');
      if (!b) return;
      const val = b.dataset.aspect;
      if (val === 'custom') {
        const { promptDialog } = await import('./core.js');
        const v = await promptDialog('Custom aspect ratio', '1:1.414', { placeholder: 'e.g. 3:4', okText: 'Apply' });
        if (!v) return;
        const m = v.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
        if (!m) { toast('Invalid ratio. Use e.g. 3:4', 'error'); return; }
        this.customRatio = parseFloat(m[1]) / parseFloat(m[2]);
        this.aspect = 'custom';
      } else {
        this.aspect = val;
      }
      document.querySelectorAll('#aspect-bar button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      this.draw();
    });

    this.overlay.addEventListener('pointerdown', e => this.onDown(e));
    this.overlay.addEventListener('pointermove', e => this.onMove(e));
    this.overlay.addEventListener('pointerup', e => this.onUp(e));
    this.overlay.addEventListener('pointercancel', e => this.onUp(e));
    window.addEventListener('resize', () => { if (this.imageCanvas) this.layout(); });
  }

  async open(blob, opts = {}) {
    this.opts = opts;
    this.aspect = opts.aspect || 'free';
    this.customRatio = null;
    document.querySelectorAll('#aspect-bar button').forEach(b => b.classList.toggle('active', b.dataset.aspect === this.aspect));
    const { blobToCanvas } = await import('./core.js');
    this.imageCanvas = await blobToCanvas(blob, 0);
    const ready = await opencvReady();
    if (ready) {
      const detected = await detectCorners(this.imageCanvas);
      if (detected) this.points = detected;
      else this.defaultPoints();
    } else this.defaultPoints();
    this.layout();
    this.show();
  }

  defaultPoints() {
    const w = this.imageCanvas.width, h = this.imageCanvas.height;
    const mx = w * 0.06, my = h * 0.06;
    this.points = [
      { x: mx, y: my }, { x: w - mx, y: my },
      { x: w - mx, y: h - my }, { x: mx, y: h - my }
    ];
  }

  show() {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    this.el.classList.add('active');
    document.body.classList.add('nav-hidden');
  }

  hide() { this.el.classList.remove('active'); }

  layout() {
    const rect = this.area.getBoundingClientRect();
    const maxW = rect.width - 12, maxH = rect.height - 12;
    const iw = this.imageCanvas.width, ih = this.imageCanvas.height;
    const scale = Math.min(maxW / iw, maxH / ih);
    const w = Math.round(iw * scale), h = Math.round(ih * scale);
    this.scale = scale;
    this.viewCanvas.width = w; this.viewCanvas.height = h;
    this.viewCanvas.style.width = w + 'px'; this.viewCanvas.style.height = h + 'px';
    this.overlay.width = w; this.overlay.height = h;
    this.overlay.style.width = w + 'px'; this.overlay.style.height = h + 'px';
    this.viewCanvas.style.left = '50%'; this.viewCanvas.style.top = '50%';
    this.viewCanvas.style.transform = 'translate(-50%,-50%)';
    this.overlay.style.left = '50%'; this.overlay.style.top = '50%';
    this.overlay.style.transform = 'translate(-50%,-50%)';
    this.draw();
  }

  toView(p) { return { x: p.x * this.scale, y: p.y * this.scale }; }
  toImage(p) { return { x: p.x / this.scale, y: p.y / this.scale }; }

  draw() {
    const w = this.viewCanvas.width, h = this.viewCanvas.height;
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.drawImage(this.imageCanvas, 0, 0, w, h);
    this.octx.clearRect(0, 0, w, h);
    if (this.points.length !== 4) return;

    const vp = this.points.map(p => this.toView(p));
    this.octx.fillStyle = 'rgba(0,0,0,.52)';
    this.octx.fillRect(0, 0, w, h);
    this.octx.save();
    this.octx.globalCompositeOperation = 'destination-out';
    this.octx.beginPath();
    this.octx.moveTo(vp[0].x, vp[0].y);
    for (let i = 1; i < 4; i++) this.octx.lineTo(vp[i].x, vp[i].y);
    this.octx.closePath();
    this.octx.fill();
    this.octx.restore();

    this.octx.strokeStyle = '#6ea8fe';
    this.octx.lineWidth = 2.5;
    this.octx.beginPath();
    this.octx.moveTo(vp[0].x, vp[0].y);
    for (let i = 1; i < 4; i++) this.octx.lineTo(vp[i].x, vp[i].y);
    this.octx.closePath();
    this.octx.stroke();

    for (const p of vp) {
      this.octx.beginPath();
      this.octx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      this.octx.fillStyle = 'rgba(26,115,232,.28)';
      this.octx.fill();
      this.octx.beginPath();
      this.octx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      this.octx.fillStyle = '#fff';
      this.octx.fill();
      this.octx.lineWidth = 3;
      this.octx.strokeStyle = '#1a73e8';
      this.octx.stroke();
    }
  }

  onDown(e) {
    if (this.points.length !== 4) return;
    const rect = this.overlay.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = -1, bestD = 44;
    this.points.forEach((p, i) => {
      const v = this.toView(p);
      const d = Math.hypot(v.x - x, v.y - y);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) {
      this.dragIndex = best;
      this.overlay.setPointerCapture(e.pointerId);
      this.moveMagnifier(x, y);
    }
  }

  onMove(e) {
    if (this.dragIndex < 0) return;
    const rect = this.overlay.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    this.points[this.dragIndex] = this.toImage({ x, y });
    this.draw();
    this.moveMagnifier(x, y);
  }

  onUp(e) {
    this.dragIndex = -1;
    this.magnifier.classList.add('hidden');
  }

  moveMagnifier(x, y) {
    const rect = this.overlay.getBoundingClientRect();
    this.magnifier.style.left = Math.min(rect.width - 120, Math.max(0, x - 60)) + 'px';
    this.magnifier.style.top = Math.min(rect.height - 120, Math.max(0, y - 60)) + 'px';
    this.magnifier.classList.remove('hidden');
    const mctx = this.magCanvas.getContext('2d');
    mctx.imageSmoothingEnabled = false;
    mctx.drawImage(this.viewCanvas, Math.max(0, x - 30), Math.max(0, y - 30), 60, 60, 0, 0, 120, 120);
  }

  async autoDetect() {
    if (!this.imageCanvas) return;
    showLoading('Detecting edges…');
    try {
      const pts = await detectCorners(this.imageCanvas);
      if (pts) { this.points = pts; this.draw(); toast('Document edges detected', 'success'); }
      else toast('Could not detect edges — adjust manually', 'info');
    } finally { hideLoading(); }
  }

  rotate(deg) {
    if (!this.imageCanvas) return;
    const c = createCanvas(this.imageCanvas.height, this.imageCanvas.width);
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(this.imageCanvas, -this.imageCanvas.width / 2, -this.imageCanvas.height / 2);
    this.imageCanvas = c;
    this.defaultPoints();
    this.layout();
  }

  reset() { this.defaultPoints(); this.draw(); }

  computeOutputSize() {
    const [tl, tr, br, bl] = this.points;
    const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const wBot = Math.hypot(br.x - bl.x, br.y - bl.y);
    const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const hRight = Math.hypot(br.x - tr.x, br.y - tr.y);
    let W = Math.max(wTop, wBot), H = Math.max(hLeft, hRight);
    if (this.aspect === 'a4') { const r = 210 / 297; if (W / H > r) W = H * r; else H = W / r; }
    else if (this.aspect === 'letter') { const r = 215.9 / 279.4; if (W / H > r) W = H * r; else H = W / r; }
    else if (this.aspect === 'custom' && this.customRatio) {
      const r = this.customRatio;
      if (W / H > r) W = H * r; else H = W / r;
    }
    return { w: Math.max(120, Math.round(W)), h: Math.max(120, Math.round(H)) };
  }

  async confirm() {
    if (!this.imageCanvas || this.points.length !== 4) return;
    const { w, h } = this.computeOutputSize();
    showLoading('Correcting perspective…');
    try {
      const out = await warpPerspective(this.imageCanvas, this.points, w, h);
      if (!out) throw new Error('Perspective correction failed');
      const { canvasToBlob } = await import('./core.js');
      const blob = await canvasToBlob(out, 'image/jpeg', 0.95);
      const result = { blob, width: out.width, height: out.height };
      this.hide();
      this.resolve?.(result);
      this.resolve = null;
    } catch (e) {
      toast('Crop failed: ' + e.message, 'error');
    } finally { hideLoading(); }
  }

  cancel() {
    this.hide();
    this.resolve?.(null);
    this.resolve = null;
  }
}

let instance = null;
export function getCropScreen() { return instance || (instance = new CropScreen()); }

export function openCrop(blob, opts = {}) {
  return new Promise(resolve => {
    const crop = getCropScreen();
    crop.resolve = resolve;
    crop.open(blob, opts);
    navigate('crop');
  });
}