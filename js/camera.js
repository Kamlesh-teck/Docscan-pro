import { $, toast, showLoading, hideLoading, blobToCanvas } from './core.js';
import { detectCorners, opencvReady } from './imaging.js';
import { navigate } from './nav.js';

export class CameraScanner {
  constructor() {
    this.video = $('#camera-video');
    this.overlay = $('#camera-overlay');
    this.ctx = this.overlay.getContext('2d');
    this.stream = null;
    this.track = null;
    this.facing = 'environment';
    this.devices = [];
    this.deviceIndex = -1;
    this.caps = {};
    this.torchOn = false;
    this.zoom = 1;
    this.auto = true;
    this.stable = 0;
    this.busy = false;
    this.running = false;
    this.onCapture = null;
    this.lastDetect = 0;
    this.detectCanvas = document.createElement('canvas');
    this.detectCanvas.width = 320;
    this.detectCanvas.height = 240;
  }

  async start(mode = 'document') {
    this.mode = mode;
    $('#camera-mode-label').textContent = {
      document: 'Document', id: 'ID Card', receipt: 'Receipt', business: 'Business Card', qr: 'QR / Barcode'
    }[mode] || 'Document';
    try {
      await this.stop();
      const constraints = {
        audio: false,
        video: {
          facingMode: this.facing,
          width: { ideal: 4096 },
          height: { ideal: 2160 }
        }
      };
      if (this.deviceId) constraints.video.deviceId = { exact: this.deviceId };
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.video.srcObject = this.stream;
      await this.video.play();
      this.track = this.stream.getVideoTracks()[0];
      const settings = this.track.getSettings();
      this.caps = this.track.getCapabilities?.() || {};
      this.running = true;
      this.busy = false;
      this.stable = 0;
      this.configureControls();
      this.resizeOverlay();
      this.loop();
    } catch (e) {
      this.handleError(e);
    }
  }

  async stop() {
    this.running = false;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
    this.track = null;
  }

  handleError(e) {
    const name = e?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError')
      toast('Camera permission denied. Enable camera access in browser settings.', 'error', 4000);
    else if (name === 'NotFoundError') toast('No camera found on this device.', 'error', 4000);
    else if (name === 'NotReadableError') toast('Camera is busy or unavailable.', 'error', 4000);
    else toast('Camera error: ' + (e.message || name), 'error', 4000);
    this.stop();
    navigate('home');
  }

  configureControls() {
    const flash = $('#camera-flash-btn');
    flash.style.display = this.caps.torch ? 'grid' : 'none';
    flash.querySelector('.material-symbols-rounded').textContent = this.torchOn ? 'flash_on' : 'flash_off';

    const zoomWrap = $('#camera-zoom-wrap');
    const z = this.caps.zoom;
    if (z && z.max > z.min) {
      const slider = $('#camera-zoom');
      slider.min = z.min; slider.max = z.max; slider.step = z.step || 0.1;
      slider.value = this.zoom;
      zoomWrap.style.display = 'block';
    } else zoomWrap.style.display = 'none';
  }

  async toggleTorch() {
    if (!this.caps.torch || !this.track) return;
    try {
      this.torchOn = !this.torchOn;
      await this.track.applyConstraints({ advanced: [{ torch: this.torchOn }] });
      $('#camera-flash-btn .material-symbols-rounded').textContent = this.torchOn ? 'flash_on' : 'flash_off';
    } catch { toast('Flashlight not supported', 'error'); }
  }

  async setZoom(v) {
    if (!this.caps.zoom || !this.track) return;
    try {
      await this.track.applyConstraints({ advanced: [{ zoom: parseFloat(v) }] });
      this.zoom = parseFloat(v);
    } catch {}
  }

  async switchCamera() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.devices = devices.filter(d => d.kind === 'videoinput');
      if (this.devices.length < 2) { toast('Only one camera available', 'info'); return; }
      const current = this.devices.findIndex(d => d.deviceId === this.track?.getSettings().deviceId);
      this.deviceIndex = (current + 1) % this.devices.length;
      this.deviceId = this.devices[this.deviceIndex].deviceId;
      await this.start(this.mode);
    } catch (e) { toast('Could not switch camera', 'error'); }
  }

  resizeOverlay() {
    const rect = this.video.getBoundingClientRect();
    this.overlay.width = rect.width;
    this.overlay.height = rect.height;
  }

  mapPoint(x, y) {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const dw = this.overlay.width, dh = this.overlay.height;
    const scale = Math.max(dw / vw, dh / vh);
    const ox = (dw - vw * scale) / 2, oy = (dh - vh * scale) / 2;
    return { x: x * scale + ox, y: y * scale + oy };
  }

  async loop() {
    if (!this.running) return;
    const now = performance.now();
    if (!this.busy && this.auto && now - this.lastDetect > 450 && await opencvReady()) {
      this.lastDetect = now;
      this.busy = true;
      try {
        const c = this.detectCanvas;
        c.getContext('2d').drawImage(this.video, 0, 0, c.width, c.height);
        const pts = await detectCorners(c);
        this.drawOverlay(pts);
        if (pts && this.auto) {
          const [tl, tr, br, bl] = pts;
          const area = Math.abs((tr.x - tl.x) * (bl.y - tl.y));
          const frac = area / (c.width * c.height);
          if (frac > 0.18) this.stable++; else this.stable = 0;
          if (this.stable > 7) { this.stable = 0; this.capture(); }
        } else this.stable = 0;
      } catch {}
      this.busy = false;
    }
    requestAnimationFrame(() => this.loop());
  }

  drawOverlay(pts) {
    const w = this.overlay.width, h = this.overlay.height;
    this.ctx.clearRect(0, 0, w, h);
    if (!pts) return;
    const mapped = pts.map(p => this.mapPoint(p.x * (this.video.videoWidth / this.detectCanvas.width), p.y * (this.video.videoHeight / this.detectCanvas.height)));
    this.ctx.fillStyle = 'rgba(0,168,132,.12)';
    this.ctx.beginPath();
    this.ctx.moveTo(mapped[0].x, mapped[0].y);
    for (let i = 1; i < 4; i++) this.ctx.lineTo(mapped[i].x, mapped[i].y);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.strokeStyle = '#2dd4bf';
    this.ctx.lineWidth = 2.5;
    this.ctx.stroke();
    for (const p of mapped) {
      this.ctx.beginPath(); this.ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      this.ctx.fillStyle = '#fff'; this.ctx.fill();
      this.ctx.strokeStyle = '#2dd4bf'; this.ctx.lineWidth = 2; this.ctx.stroke();
    }
  }

  async capture() {
    if (!this.running || this.busy) return;
    this.busy = true;
    showLoading('Capturing…');
    try {
      const vw = this.video.videoWidth, vh = this.video.videoHeight;
      const c = document.createElement('canvas');
      c.width = vw; c.height = vh;
      c.getContext('2d').drawImage(this.video, 0, 0, vw, vh);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.96));
      if (!blob) throw new Error('Capture failed');
      hideLoading();
      this.onCapture?.(blob);
    } catch (e) {
      hideLoading();
      toast('Capture failed: ' + e.message, 'error');
    } finally {
      this.busy = false;
    }
  }
}

let scanner = null;
export function getScanner() { return scanner || (scanner = new CameraScanner()); }