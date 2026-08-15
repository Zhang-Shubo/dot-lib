export type BookFormat = "epub" | "pdf";

export interface BookMeta {
  id: string;
  title: string;
  author: string;
  fileName: string;
  fileSize: number;
  hasCover: boolean;
  coverType: string;
  addedAt: string;
  /** books stored before PDF support have no field — treat them as epub */
  format: BookFormat;
  /** set when the stored file was converted on import, e.g. "mobi" / "azw3" */
  sourceFormat?: string;
}

/** Normalized (0–1, relative to the page box) rectangle of a PDF highlight. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Highlight {
  id: string;
  /** epub only; empty for standalone chapter notes and for PDF notes */
  cfiRange: string;
  /** spine href of the chapter this note belongs to (epub only) */
  chapter: string;
  /** PDF only: 1-based page number; 0 for epub notes */
  page: number;
  /** PDF only: highlighted boxes on that page; empty for a whole-page note */
  rects: Rect[];
  text: string;
  color: string;
  note: string;
  createdAt: string;
}

export interface Progress {
  /** epub only */
  cfi: string;
  /** PDF only: 1-based page number; 0 for epub */
  page: number;
  percentage: number;
  updatedAt: string;
}
