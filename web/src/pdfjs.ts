// pdf.js is ~1MB of JS — load it on demand (first PDF upload / first PDF read)
// so the shelf stays light for epub-only libraries.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";

type PdfjsModule = typeof import("pdfjs-dist");

let loading: Promise<PdfjsModule> | null = null;

export function loadPdfjs(): Promise<PdfjsModule> {
  if (!loading) {
    loading = import("pdfjs-dist").then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = workerUrl;
      return mod;
    });
  }
  return loading;
}

// Served by the `pdfjs-assets` plugin in vite.config.ts. Without the CMaps a
// PDF that references a predefined CJK encoding (common in Chinese books that
// don't embed their fonts) renders blank pages.
const ASSETS = "/pdfjs/";

export async function openPdf(data: ArrayBuffer | Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data,
    cMapUrl: `${ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    wasmUrl: `${ASSETS}wasm/`,
    iccUrl: `${ASSETS}iccs/`,
  }).promise;
}
