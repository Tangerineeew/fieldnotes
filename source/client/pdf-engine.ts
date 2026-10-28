import { getDocument } from 'pdfjs-dist';
// @ts-expect-error pdf.js ships no types for its worker module.
import * as worker from 'pdfjs-dist/build/pdf.worker.mjs';


// Built apart as pdf.js and loaded the first time a page shows a PDF. TREK's frame allows no workers, no wasm and no fetches
// of the plugin's own files, so pdf.js parses on the main thread and reads its CMaps and standard fonts from script files
// that the build writes under pdf-data/ (script loads are the one way the frame may read them).
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;

const loaded = new Map<string, Promise<Uint8Array>>();
const waiting = new Map<string, (base64: string) => void>();
(window as { fieldnotesPdfData?: unknown }).fieldnotesPdfData = (name: string, base64: string) => waiting.get(name)?.(base64);

function dataFile(name: string) {
  const known = loaded.get(name);
  if (known) return known;
  const promise = new Promise<Uint8Array>((resolve, reject) => {
    const script = document.createElement('script');
    const done = () => { waiting.delete(name); script.remove(); };
    waiting.set(name, (base64) => { done(); resolve(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))); });
    script.onerror = () => { done(); loaded.delete(name); reject(new Error(`Unable to load ${name}`)); };
    script.src = `pdf-data/${name}.js`;
    document.head.append(script);
  });
  loaded.set(name, promise);
  return promise;
}

// Stands in for pdf.js's DOM data factory, which would fetch() the files.
class ScriptDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    if (kind === 'cMapUrl') return dataFile(`cmaps/${filename}`);
    if (kind === 'standardFontDataUrl') return dataFile(`fonts/${filename}`);
    throw new Error(`No ${kind} data in this frame.`);
  }
}

const open = (data: Uint8Array) => getDocument({ data, BinaryDataFactory: ScriptDataFactory, cMapUrl: 'pdf-data/cmaps/',
  standardFontDataUrl: 'pdf-data/fonts/', useWorkerFetch: false, useWasm: false, enableXfa: false }).promise;

(window as { fieldnotesPdf?: unknown }).fieldnotesPdf = { open };
