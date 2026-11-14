// Helpers for document attachment previews (input box + chat messages).

const SNIPPET_CHARS = 600;
const THUMB_WIDTH = 320;
const STORAGE_KEY = 'opengpt:attachments';

export const formatFileSize = (bytes) => {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const getFileExt = (name = '') =>
  (name.includes('.') ? name.split('.').pop() : 'doc').toUpperCase();

const isPdf = (file) =>
  file.type === 'application/pdf' || file.name?.toLowerCase().endsWith('.pdf');

// Render the first page of a PDF to a small JPEG data URL. pdf.js is loaded
// lazily so it stays out of the main bundle.
const renderPdfThumbnail = async (file) => {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return { kind: 'image', src: canvas.toDataURL('image/jpeg', 0.7), pages: pdf.numPages };
  } finally {
    pdf.destroy();
  }
};

// Returns { kind: 'image', src, pages } for PDFs, { kind: 'text', text } for
// text/markdown, or null when no preview could be built (the card then falls
// back to a plain file icon).
export const buildAttachmentPreview = async (file) => {
  try {
    if (isPdf(file)) return await renderPdfThumbnail(file);
    const text = await file.slice(0, SNIPPET_CHARS * 4).text();
    return { kind: 'text', text: text.slice(0, SNIPPET_CHARS) };
  } catch (err) {
    console.warn('Could not build attachment preview:', err);
    return null;
  }
};

// The backend history doesn't carry attachment info, so previews for sent
// messages are remembered locally, keyed by thread and by the position of the
// message among the thread's user messages. Only name/type/size and PDF
// thumbnails are kept (no document text), for at most MAX_THREADS threads.
const MAX_THREADS = 30;

const readStore = () => {
  try {
    const store = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return store && typeof store === 'object' ? store : {};
  } catch {
    return {};
  }
};

// Drop text snippets left by older versions and evict the oldest threads.
const pruneStore = (store, maxThreads) => {
  const entries = Object.entries(store).map(([threadId, entry]) => {
    const clean = {};
    for (const [key, value] of Object.entries(entry || {})) {
      clean[key] = Array.isArray(value)
        ? value.map((a) => (a?.preview?.kind === 'image' ? a : { ...a, preview: null }))
        : value;
    }
    return [threadId, clean];
  });
  entries.sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
  return Object.fromEntries(entries.slice(0, maxThreads));
};

const writeStore = (store) => {
  let pruned = pruneStore(store, MAX_THREADS);
  // On a full quota, keep fewer threads until it fits.
  for (;;) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
      return;
    } catch (err) {
      const count = Object.keys(pruned).length;
      if (count <= 1) throw err;
      pruned = pruneStore(pruned, Math.floor(count / 2));
    }
  }
};

export const saveMessageAttachments = (threadId, humanIndex, attachments) => {
  if (!threadId || !attachments?.length) return;
  try {
    const store = readStore();
    // Always newer than every saved entry, even within the same millisecond.
    const latest = Math.max(0, ...Object.values(store).map((e) => e?.savedAt || 0));
    store[threadId] = {
      ...store[threadId],
      savedAt: Math.max(Date.now(), latest + 1),
      [humanIndex]: attachments.map(({ name, size, type, preview }) => ({
        name,
        size,
        type,
        preview: preview?.kind === 'image' ? preview : null,
      })),
    };
    writeStore(store);
  } catch (err) {
    console.warn('Could not save attachment previews:', err);
  }
};

// Forget a deleted thread's previews.
export const removeThreadAttachments = (threadId) => {
  try {
    const store = readStore();
    if (!(threadId in store)) return;
    delete store[threadId];
    writeStore(store);
  } catch (err) {
    console.warn('Could not remove attachment previews:', err);
  }
};

export const withStoredAttachments = (threadId, messages) => {
  const stored = readStore()[threadId];
  if (!stored) return messages;
  let humanIndex = -1;
  return messages.map((m) => {
    if (m.type !== 'human') return m;
    humanIndex += 1;
    return Array.isArray(stored[humanIndex]) && !m.attachments
      ? { ...m, attachments: stored[humanIndex] }
      : m;
  });
};
