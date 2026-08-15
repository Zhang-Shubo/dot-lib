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

export const HIGHLIGHT_COLORS: Record<string, string> = {
  amber: "rgba(224, 168, 42, 0.38)",
  vermilion: "rgba(196, 78, 55, 0.32)",
  indigo: "rgba(84, 110, 170, 0.32)",
  moss: "rgba(112, 140, 75, 0.35)",
};
