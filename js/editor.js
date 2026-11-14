import { $, showLoading, hideLoading, toast, canvasToBlob, blobToCanvas, promptDialog, confirmDialog, createCanvas } from './core.js';
import { renderFiltered, applyPreset, defaultFilterState, PRESETS } from './imaging.js';
import { db, updatePageAndDoc } from './store.js';
import { openCrop } from './crop.js';
import { navigate } from './nav.js';

const SLIDERS = [
  { key: 'brightness', label: 'Brightness', min: -100, max: 100 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { key: 'exposure', label: 'Exposure', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { key: 'sharpness', label: 'Sharpness', min: 0, max: 100 },
  { key: 'shadow', label: 'Shadow removal', min: 0, max: 100 },
  { key: 'whiten', label: 'Background whitening', min: 0, max: 100 },
  { key: 'noise', label: 'Noise reduction', min: 0, max: 100 },
  { key: 'text', label: 'Text clarity', min: 0, max: 100 }
];

class EditorScreen {
  constructor() {
    this.el = $('#screen-enhance');
    this.canvas = $('#enhance-canvas');
    this.scroll = $('#editor-scroll');
    this.page = null;
    this.baseCanvas = null;
    this.state = defaultFilterState();
    this.history = [];
    this.historyIndex = -1;
    this.opts = {};
    this.resolve = null;
    this._bound = false;
  }

  async open(page, opts = {}) {
    this.page = page;
    this.opts = opts;
    this.baseCanvas = await blobToCanvas(page.baseBlob, 0);
    this.state = page.filterState ? { ...defaultFilterState(), ...page.filterState } : defaultFilterState();
    this.history = [JSON.stringify(this.state)];
    this.historyIndex = 0;
    $('#editor-title').textContent = opts.mode === 'edit' ? 'Edit Page' : 'Enhance';
    this.buildUI();
    this.bind();
    this.show();
    await this.renderPreview();
  }

  show() {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    this.el.classList.add('active');
    document.body.classList.add('nav-hidden');
    this.scroll.scrollTop = 0;
  }

  hide() { this.el.classList.remove('active'); }

  buildUI() {
    const chipRow = $('#preset-chips');
    chipRow.innerHTML = Object.entries(PRESETS).map(([k, p]) =>
      `<button class="preset-chip ${this.state.presetKey === k ? 'active' : ''}" data-preset="${k}">${p.label}</button>`
    ).join('');
    if (!this.state.presetKey) chipRow.firstChild?.classList.add('active');

    const list = $('#slider-list');
    list.innerHTML = SLIDERS.map(s => `
      <div class="slider-row">
        <div class="slider-head"><b>${s.label}</b><span id="val-${s.key}">${Math.round(this.state[s.key] || 0)}</span></div>
        <input type="range" data-slider="${s.key}" min="${s.min}" max="${s.max}" value="${this.state[s.key] || 0}">
      </div>`).join('');

    list.querySelectorAll('[data-slider]').forEach(input => {
      input.addEventListener('input', () => {
        const key = input.dataset.slider;
        this.state[key] = parseInt(input.value, 10);
        this.state.presetKey = null;
        $(`#val-${key}`).textContent = input.value;
        this.scheduleRender();
      });
      input.addEventListener('change', () => this.pushHistory());
    });
  }

  bind() {
    if (this._bound) return;
    this._bound = true;

    this.el.addEventListener('click', async e => {
      const tab = e.target.closest('[data-tab]');
      if (tab) {
        $$('#editor-tabs button').forEach(b => b.classList.remove('active'));
        tab.classList.add('active');
        ['presets', 'adjust', 'transform'].forEach(t =>
          $('#panel-' + t)?.classList.toggle('active', t === tab.dataset.tab));
        return;
      }
      const preset = e.target.closest('[data-preset]');
      if (preset) {
        this.state = applyPreset(preset.dataset.preset);
        this.state.presetKey = preset.dataset.preset;
        $$('#preset-chips .preset-chip').forEach(b => b.classList.remove('active'));
        preset.classList.add('active');
        this.syncSliders();
        this.pushHistory();
        this.renderPreview();
        return;
      }
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'editor-back') this.cancel();
      if (action === 'editor-save') this.save();
      if (action === 'editor-undo') this.undo();
      if (action === 'editor-redo') this.redo();
      if (action === 'rotate-left') this.rotate(-90);
      if (action === 'rotate-right') this.rotate(90);
      if (action === 'flip-h') { this.state.flipH = !this.state.flipH; this.pushHistory(); this.renderPreview(); }
      if (action === 'flip-v') { this.state.flipV = !this.state.flipV; this.pushHistory(); this.renderPreview(); }
      if (action === 'editor-crop') this.crop();
      if (action === 'editor-signature') this.signature();
      if (action === 'editor-watermark') this.watermark();
      if (action === 'editor-date') this.addDate();
    });

    $('#reset-adjust').addEventListener('click', () => {
      this.state = defaultFilterState();
      this.state.presetKey = 'original';
      this.buildUI(); this.pushHistory(); this.renderPreview();
    });

    const compare = $('#compare-btn');
    compare.addEventListener('pointerdown', () => this.renderOriginal());
    compare.addEventListener('pointerup', () => this.renderPreview());
    compare.addEventListener('pointerleave', () => this.renderPreview());

    const debounced = () => this.scheduleRender();
    this._schedule = this._schedule || debounce(debounced, 120);
  }

  scheduleRender() { this._schedule?.(); }

  syncSliders() {
    SLIDERS.forEach(s => {
      const input = $(`[data-slider="${s.key}"]`);
      if (input) input.value = this.state[s.key] || 0;
      const label = $(`#val-${s.key}`);
      if (label) label.textContent = Math.round(this.state[s.key] || 0);
    });
  }

  pushHistory() {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(JSON.stringify(this.state));
    if (this.history.length > 30) this.history.shift();
    this.historyIndex = this.history.length - 1;
    this.updateUndoButtons();
  }

  undo() {
    if (this.historyIndex <= 0) return;
    this.historyIndex--;
    this.state = JSON.parse(this.history[this.historyIndex]);
    this.buildUI(); this.renderPreview(); this.updateUndoButtons();
  }
  redo() {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex++;
    this.state = JSON.parse(this.history[this.historyIndex]);
    this.buildUI(); this.renderPreview(); this.updateUndoButtons();
  }
  updateUndoButtons() {
    $('[data-action="editor-undo"]').disabled = this.historyIndex <= 0;
    $('[data-action="editor-redo"]').disabled = this.historyIndex >= this.history.length - 1;
  }

  async renderPreview() {
    if (!this.baseCanvas) return;
    const out = await renderFiltered(this.baseCanvas, this.state, 1200);
    this.canvas.width = out.width; this.canvas.height = out.height;
    this.canvas.getContext('2d').drawImage(out, 0, 0);
    $('#preview-badge').textContent = this.state.presetKey ? PRESETS[this.state.presetKey]?.label || 'Custom' : 'Custom';
  }

  async renderOriginal() {
    if (!this.baseCanvas) return;
    const out = await renderFiltered(this.baseCanvas, { ...defaultFilterState(), rotation: this.state.rotation, flipH: this.state.flipH, flipV: this.state.flipV }, 1200);
    this.canvas.width = out.width; this.canvas.height = out.height;
    this.canvas.getContext('2d').drawImage(out, 0, 0);
  }

  rotate(deg) {
    this.state.rotation = ((this.state.rotation || 0) + deg + 360) % 360;
    this.pushHistory(); this.renderPreview();
  }

  async crop() {
    const cropped = await openCrop(this.page.baseBlob, { aspect: 'free' });
    if (!cropped) return;
    this.page.baseBlob = cropped.blob;
    this.baseCanvas = await blobToCanvas(cropped.blob, 0);
    this.state = defaultFilterState();
    this.history = [JSON.stringify(this.state)];
    this.historyIndex = 0;
    this.buildUI(); this.renderPreview();
    toast('Cropped — save to keep changes', 'success');
  }

  async save() {
    if (!this.page) return;
    showLoading('Rendering high-resolution page…');
    try {
      const out = await renderFiltered(this.baseCanvas, this.state, 3500);
      const processedBlob = await canvasToBlob(out, 'image/jpeg', 0.94);
      const { makeThumb } = await import('./core.js');
      const thumbBlob = await makeThumb(processedBlob, 420);
      const patch = {
        baseBlob: this.page.baseBlob,
        processedBlob, thumbBlob,
        width: out.width, height: out.height,
        filterState: { ...this.state }
      };
      if (this.page.id) {
        await updatePageAndDoc(this.page.id, patch);
        this.page = { ...this.page, ...patch };
      } else {
        Object.assign(this.page, patch);
      }
      this.hide();
      this.resolve?.(this.page);
      this.resolve = null;
      toast('Page saved', 'success');
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    } finally { hideLoading(); }
  }

  cancel() {
    this.hide();
    this.resolve?.(null);
    this.resolve = null;
  }

  async signature() {
    const { openSignatureDialog } = await import('./screens.js');
    const dataUrl = await openSignatureDialog();
    if (!dataUrl) return;
    const img = new Image();
    img.src = dataUrl;
    await new Promise(r => { img.onload = r; });
    const base = createCanvas(this.baseCanvas.width, this.baseCanvas.height);
    const ctx = base.getContext('2d');
    ctx.drawImage(this.baseCanvas, 0, 0);
    const w = Math.round(base.width * 0.28);
    const h = Math.round(w * (img.height / img.width));
    ctx.globalAlpha = 0.9;
    ctx.drawImage(img, base.width - w - 40, base.height - h - 50, w, h);
    this.baseCanvas = base;
    const blob = await canvasToBlob(base, 'image/jpeg', 0.95);
    this.page.baseBlob = blob;
    this.renderPreview();
    toast('Signature added', 'success');
  }

  async watermark() {
    const text = await promptDialog('Watermark text', 'CONFIDENTIAL', { okText: 'Add' });
    if (!text) return;
    const base = createCanvas(this.baseCanvas.width, this.baseCanvas.height);
    const ctx = base.getContext('2d');
    ctx.drawImage(this.baseCanvas, 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = '#000';
    ctx.font = `${Math.round(base.width / 24)}px Roboto, sans-serif`;
    ctx.translate(base.width / 2, base.height / 2);
    ctx.rotate(-Math.PI / 5);
    const stepX = base.width / 2.2, stepY = base.height / 5;
    for (let y = -base.height; y < base.height; y += stepY) {
      for (let x = -base.width; x < base.width; x += stepX) {
        ctx.fillText(text, x, y);
      }
    }
    ctx.restore();
    this.baseCanvas = base;
    const blob = await canvasToBlob(base, 'image/jpeg', 0.95);
    this.page.baseBlob = blob;
    this.renderPreview();
    toast('Watermark added', 'success');
  }

  async addDate() {
    const base = createCanvas(this.baseCanvas.width, this.baseCanvas.height);
    const ctx = base.getContext('2d');
    ctx.drawImage(this.baseCanvas, 0, 0);
    const text = new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
    const fs = Math.max(18, Math.round(base.width / 45));
    ctx.font = `${fs}px Roboto, sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,.72)';
    ctx.fillText(text, base.width - ctx.measureText(text).width - 40, base.height - 30);
    this.baseCanvas = base;
    const blob = await canvasToBlob(base, 'image/jpeg', 0.95);
    this.page.baseBlob = blob;
    this.renderPreview();
    toast('Date added', 'success');
  }
}

let instance = null;
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const $$ = (sel) => document.querySelectorAll(sel);

export function getEditor() { return instance || (instance = new EditorScreen()); }

export function openEnhance(page, opts = {}) {
  return new Promise(resolve => {
    const ed = getEditor();
    ed.resolve = resolve;
    ed.open(page, opts);
    navigate('enhance');
  });
}