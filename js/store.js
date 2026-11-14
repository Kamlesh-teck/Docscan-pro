import { uuid, blobToCanvas, makeThumb, canvasToBlob, blobToBitmap } from './core.js';

// ===================== INDEXEDDB =====================
const DB_NAME = 'DocScanProDB';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('documents')) {
        const s = db.createObjectStore('documents', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
        s.createIndex('updatedAt', 'updatedAt');
        s.createIndex('name', 'name');
        s.createIndex('folderId', 'folderId');
        s.createIndex('favorite', 'favorite');
      }
      if (!db.objectStoreNames.contains('pages')) {
        const s = db.createObjectStore('pages', { keyPath: 'id' });
        s.createIndex('docId', 'docId');
        s.createIndex('index', 'index');
      }
      if (!db.objectStoreNames.contains('folders')) {
        db.createObjectStore('folders', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let request;
    try { request = fn(store); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const db = {
  // ---- folders ----
  putFolder: f => run('folders', 'readwrite', s => s.put(f)),
  getFolders: () => run('folders', 'readonly', s => s.getAll()),
  getFolder: id => run('folders', 'readonly', s => s.get(id)),
  deleteFolder: id => run('folders', 'readwrite', s => s.delete(id)),

  // ---- documents ----
  putDocument: d => run('documents', 'readwrite', s => s.put(d)),
  getDocument: id => run('documents', 'readonly', s => s.get(id)),
  getAllDocuments: () => run('documents', 'readonly', s => s.getAll()),
  updateDocument: (id, patch) => openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('documents', 'readwrite');
    const store = tx.objectStore('documents');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const doc = getReq.result;
      if (!doc) { reject(new Error('Document not found')); return; }
      Object.assign(doc, patch);
      store.put(doc);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  })),

  deleteDocumentFull: id => openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(['documents', 'pages'], 'readwrite');
    tx.objectStore('documents').delete(id);
    const idx = tx.objectStore('pages').index('docId');
    idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { tx.objectStore('pages').delete(cursor.primaryKey); cursor.continue(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  })),

  // ---- pages ----
  putPage: p => run('pages', 'readwrite', s => s.put(p)),
  getPage: id => run('pages', 'readonly', s => s.get(id)),
  getPages: docId => new Promise((resolve, reject) => {
    openDB().then(db => {
      const tx = db.transaction('pages', 'readonly');
      const idx = tx.objectStore('pages').index('docId');
      const req = idx.getAll(IDBKeyRange.only(docId));
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.index - b.index));
      req.onerror = () => reject(req.error);
    }).catch(reject);
  }),
  deletePage: id => run('pages', 'readwrite', s => s.delete(id)),

  // ---- storage ----
  estimate: async () => {
    try { return await navigator.storage.estimate(); }
    catch { return { usage: 0, quota: 0 }; }
  }
};

// ===================== DOCUMENT FACTORY =====================
export async function createDocument({ name, pages = [], folderId = null, type = 'document', draft = false }) {
  const id = uuid();
  const now = Date.now();
  const firstPage = pages[0];
  const doc = {
    id, name: name || `Scan ${new Date().toLocaleString()}`,
    folderId, favorite: false, createdAt: now, updatedAt: now,
    pageCount: pages.length, type, draft,
    coverThumb: firstPage?.thumbBlob || null,
    ocrText: ''
  };
  await db.putDocument(doc);
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    await db.putPage({
      id: uuid(), docId: id, index: i,
      originalBlob: p.originalBlob, baseBlob: p.baseBlob,
      processedBlob: p.processedBlob || p.baseBlob,
      thumbBlob: p.thumbBlob, width: p.width, height: p.height,
      filterState: p.filterState || null, ocrText: p.ocrText || ''
    });
  }
  return doc;
}

export async function duplicateDocument(docId) {
  const src = await db.getDocument(docId);
  if (!src) throw new Error('Document not found');
  const pages = await db.getPages(docId);
  const newId = uuid();
  const newDoc = { ...src, id: newId, name: src.name + ' (Copy)', createdAt: Date.now(), updatedAt: Date.now() };
  await db.putDocument(newDoc);
  for (const p of pages) {
    await db.putPage({ ...p, id: uuid(), docId: newId });
  }
  return newDoc;
}

export async function addPageToDocument(docId, page) {
  const pages = await db.getPages(docId);
  const newPage = {
    id: uuid(), docId, index: pages.length,
    originalBlob: page.originalBlob, baseBlob: page.baseBlob,
    processedBlob: page.processedBlob || page.baseBlob,
    thumbBlob: page.thumbBlob, width: page.width, height: page.height,
    filterState: page.filterState || null, ocrText: page.ocrText || ''
  };
  await db.putPage(newPage);
  await db.updateDocument(docId, {
    pageCount: pages.length + 1,
    updatedAt: Date.now(),
    coverThumb: pages.length === 0 ? newPage.thumbBlob : undefined
  });
  return newPage;
}

export async function updatePageAndDoc(pageId, patch) {
  const page = await db.getPage(pageId);
  if (!page) throw new Error('Page not found');
  Object.assign(page, patch);
  await db.putPage(page);
  await db.updateDocument(page.docId, { updatedAt: Date.now() });
  return page;
}

export async function reorderPages(docId, orderedIds) {
  const pages = await db.getPages(docId);
  const map = new Map(pages.map(p => [p.id, p]));
  for (let i = 0; i < orderedIds.length; i++) {
    const p = map.get(orderedIds[i]);
    if (p) { p.index = i; await db.putPage(p); }
  }
  const first = map.get(orderedIds[0]);
  await db.updateDocument(docId, { updatedAt: Date.now(), coverThumb: first?.thumbBlob });
}

// ===================== SCAN SESSION (DRAFT) =====================
export const session = {
  docId: null,
  pageIds: [],
  mode: 'document',

  clear() { this.docId = null; this.pageIds = []; this.mode = 'document'; },

  async ensureDoc(mode) {
    if (!this.docId) {
      this.mode = mode || this.mode;
      const doc = {
        id: uuid(), name: `Scan ${new Date().toLocaleString()}`,
        folderId: null, favorite: false, createdAt: Date.now(), updatedAt: Date.now(),
        pageCount: 0, type: this.mode, draft: true, coverThumb: null, ocrText: ''
      };
      await db.putDocument(doc);
      this.docId = doc.id;
    }
    return this.docId;
  },

  async addPage(pageData, mode) {
    const docId = await this.ensureDoc(mode);
    const page = await addPageToDocument(docId, pageData);
    this.pageIds.push(page.id);
    return page;
  },

  async finish(name) {
    if (!this.docId) return null;
    await db.updateDocument(this.docId, { name: name || undefined, draft: false, updatedAt: Date.now() });
    const id = this.docId;
    this.clear();
    return id;
  },

  async discard() {
    if (this.docId) await db.deleteDocumentFull(this.docId);
    this.clear();
  }
};