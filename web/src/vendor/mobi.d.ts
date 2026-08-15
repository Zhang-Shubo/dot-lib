// Hand-written declarations for the parts of vendor/mobi.js that dot-lib uses.
// The parser returns either a MOBI6 or a KF8 book; both expose this shape.

export interface MobiSection {
  id: number | string;
  /** object URL of the section's HTML, resources already rewritten to blob URLs */
  load: () => Promise<string>;
  createDocument: () => Promise<Document>;
  size?: number;
  linear?: string;
}

export interface MobiTocItem {
  label: string;
  href: string;
  subitems?: MobiTocItem[];
}

export interface MobiMetadata {
  identifier?: string;
  title?: string;
  author?: string[];
  publisher?: string;
  /** EXTH may carry several language tags; the header form is a bare string */
  language?: string | string[];
  published?: string;
  description?: string;
  subject?: string[];
}

export interface MobiBook {
  sections: MobiSection[];
  toc?: MobiTocItem[];
  metadata: MobiMetadata;
  getCover: () => Promise<Blob | undefined>;
  /** `anchor(doc)` locates the target element inside the destination section */
  resolveHref: (href: string) => { index: number; anchor?: (doc: Document) => Element | null } | undefined;
  destroy?: () => void;
}

export declare const isMOBI: (file: Blob) => Promise<boolean>;

export declare class MOBI {
  constructor(options: { unzlib: (data: Uint8Array) => Uint8Array });
  open(file: Blob): Promise<MobiBook>;
}
