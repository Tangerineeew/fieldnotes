import { ICON_PATHS, iconElement } from './icons';
import { decodeBase64 } from './api';


// PDFs embedded as `![name](source)` read in place: one page at a time with its own page turner, and every page at once in a
// sheet over the page. pdf.js (pdf-engine.ts) loads the first time one is shown. The frame cannot download or open files,
// so reading here is the whole of it.
type PdfPage = { getViewport(options: { scale: number }): { width: number; height: number };
  render(options: { canvas: HTMLCanvasElement; viewport: unknown }): { promise: Promise<void>; cancel(): void } };
type PdfDocument = { numPages: number; getPage(number: number): Promise<PdfPage>; destroy(): Promise<void> };
type Engine = { open(data: Uint8Array): Promise<PdfDocument> };
export type PdfText = { onePage: string; previous: string; next: string; all: string; close: string; failed: string };

let text: PdfText = { onePage: '1 page', previous: 'Previous page', next: 'Next page', all: 'Show all pages',
  close: 'Close', failed: 'This PDF could not be opened.' };
export const setPdfText = (next: PdfText) => { text = next; };
export const isPdf = (source?: string) => Boolean(source?.startsWith('data:application/pdf'));

let engine: Promise<Engine> | null = null;
function loadEngine() {
  engine ??= new Promise<Engine>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'pdf.js';
    script.onload = () => resolve((window as { fieldnotesPdf?: Engine }).fieldnotesPdf!);
    script.onerror = () => { engine = null; reject(new Error('pdf.js did not load')); };
    document.head.append(script);
  });
  return engine;
}

// A note re-renders on every change around it; the parsed file and the page a reader turned to outlive each render.
const documents = new Map<string, Promise<PdfDocument>>();
const turnedTo = new Map<string, number>();
const KEPT_DOCUMENTS = 6;
function openDocument(dataUrl: string) {
  const known = documents.get(dataUrl);
  if (known) { documents.delete(dataUrl); documents.set(dataUrl, known); return known; }
  const opened = loadEngine().then((pdf) => pdf.open(decodeBase64(dataUrl.slice(dataUrl.indexOf(',') + 1))));
  opened.catch(() => documents.delete(dataUrl));
  documents.set(dataUrl, opened);
  for (const [key, older] of documents) {
    if (documents.size <= KEPT_DOCUMENTS) break;
    documents.delete(key); void older.then((file) => file.destroy(), () => {});
  }
  return opened;
}

function button(className: string, label: string, path: string) {
  const element = document.createElement('button');
  element.type = 'button'; element.className = className; element.setAttribute('aria-label', label); element.title = label;
  element.append(iconElement(document, path));
  return element;
}
const ICONS = { previous: ICON_PATHS['chevron-left'], next: ICON_PATHS['chevron-right'],
  all: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', close: ICON_PATHS.close };

// Draws one page at the width its canvas is shown at, sharp on high-density screens, again when that width changes.
function drawPage(canvas: HTMLCanvasElement, page: PdfPage) {
  let task: { cancel(): void } | null = null; let drawnWidth = 0;
  const draw = () => {
    const width = canvas.clientWidth;
    if (!width || Math.abs(width - drawnWidth) < 8) return;
    drawnWidth = width; task?.cancel();
    const viewport = page.getViewport({ scale: Math.min(width * devicePixelRatio, 2400) / page.getViewport({ scale: 1 }).width });
    canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
    const render = page.render({ canvas, viewport }); task = render;
    render.promise.catch(() => {});
  };
  const base = page.getViewport({ scale: 1 });
  canvas.style.aspectRatio = `${base.width} / ${base.height}`;
  // Once a drawn canvas leaves the page (turned past, closed, or its note rendered again), its observer lets it go.
  const observer = new ResizeObserver(() => {
    if (canvas.isConnected) draw(); else if (drawnWidth) { task?.cancel(); observer.disconnect(); }
  });
  observer.observe(canvas);
}

function showAll(file: PdfDocument, name: string, opener: HTMLElement) {
  const sheet = document.createElement('div');
  sheet.className = 'fn-pdf-all'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', name);
  const bar = document.createElement('div'); bar.className = 'fn-pdf-all-bar';
  const title = document.createElement('span'); title.className = 'fn-pdf-name'; title.textContent = name;
  const close = button('fn-pdf-button', text.close, ICONS.close);
  bar.append(title, close);
  const pages = document.createElement('div'); pages.className = 'fn-pdf-all-pages';
  // Pages draw as they scroll near, so a long file opens at once.
  const near = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    near.unobserve(entry.target);
    void file.getPage(Number((entry.target as HTMLElement).dataset.page)).then((page) => drawPage(entry.target as HTMLCanvasElement, page));
  }), { root: pages, rootMargin: '600px 0px' });
  for (let number = 1; number <= file.numPages; number += 1) {
    const canvas = document.createElement('canvas');
    canvas.className = 'fn-pdf-canvas'; canvas.dataset.page = String(number); canvas.style.aspectRatio = '1 / 1.414';
    pages.append(canvas); near.observe(canvas);
  }
  sheet.append(bar, pages);
  const dismiss = () => { near.disconnect(); sheet.remove(); window.removeEventListener('keydown', escape, true); opener.focus(); };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } };
  close.addEventListener('click', dismiss);
  window.addEventListener('keydown', escape, true);
  document.body.append(sheet);
  close.focus();
}

// The frame for one PDF; it fills itself in once the file is parsed.
export function pdfView(dataUrl: string, name: string) {
  const figure = document.createElement('figure');
  figure.className = 'fn-pdf'; figure.setAttribute('aria-busy', 'true'); figure.contentEditable = 'false';
  const bar = document.createElement('div'); bar.className = 'fn-pdf-bar';
  const badge = document.createElement('span'); badge.className = 'fn-pdf-badge'; badge.textContent = 'PDF';
  const title = document.createElement('span'); title.className = 'fn-pdf-name'; title.textContent = name; title.title = name;
  const count = document.createElement('span'); count.className = 'fn-pdf-count';
  bar.append(badge, title, count);
  const canvas = document.createElement('canvas'); canvas.className = 'fn-pdf-canvas'; canvas.style.aspectRatio = '1 / 1.414';
  figure.append(bar, canvas);
  openDocument(dataUrl).then(async (file) => {
    let current = Math.min(turnedTo.get(dataUrl) || 1, file.numPages);
    // Several pages show where the reader is instead; one says so.
    count.textContent = file.numPages === 1 ? text.onePage : '';
    const previous = button('fn-pdf-button', text.previous, ICONS.previous);
    const next = button('fn-pdf-button', text.next, ICONS.next);
    const at = document.createElement('span'); at.className = 'fn-pdf-at';
    const all = button('fn-pdf-button', text.all, ICONS.all);
    const turn = async (number: number) => {
      current = number; turnedTo.set(dataUrl, number);
      at.textContent = `${number} / ${file.numPages}`;
      previous.disabled = number <= 1; next.disabled = number >= file.numPages;
      const page = await file.getPage(number);
      if (current !== number) return;
      // A fresh canvas per page, so a slow page never paints over the one turned to after it.
      const sheet = document.createElement('canvas'); sheet.className = 'fn-pdf-canvas';
      figure.querySelector('.fn-pdf-canvas')!.replaceWith(sheet); drawPage(sheet, page);
    };
    previous.addEventListener('click', () => void turn(current - 1));
    next.addEventListener('click', () => void turn(current + 1));
    all.addEventListener('click', () => showAll(file, name, all));
    if (file.numPages > 1) bar.append(previous, at, next);
    bar.append(all);
    await turn(current);
    figure.removeAttribute('aria-busy');
  }).catch(() => {
    figure.removeAttribute('aria-busy'); figure.classList.add('fn-pdf--failed');
    canvas.remove(); count.textContent = text.failed;
  });
  return figure;
}
