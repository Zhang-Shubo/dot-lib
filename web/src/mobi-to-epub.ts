import { unzlibSync, zipSync } from "fflate";
import { MOBI, type MobiBook, type MobiTocItem } from "./vendor/mobi.js";

// MOBI books are converted to EPUB in the browser at import time rather than
// read natively: the reader, CFI-anchored highlights and progress tracking all
// speak EPUB already, and a converted book keeps working if this parser ever
// goes away. The original file stays on the user's disk — we only store the
// conversion.

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const encoder = new TextEncoder();
const enc = (s: string): Uint8Array => encoder.encode(s);

export interface ConvertedBook {
  file: File;
  title: string;
  author: string;
  cover: Blob | null;
}

/** MOBI resources carry no media type, so go by magic bytes. */
function sniff(b: Uint8Array): { mime: string; ext: string } {
  if (b[0] === 0xff && b[1] === 0xd8) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x89 && b[1] === 0x50) return { mime: "image/png", ext: "png" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { mime: "image/gif", ext: "gif" };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57)
    return { mime: "image/webp", ext: "webp" };
  if (b[0] === 0x3c && b[1] === 0x3f) return { mime: "image/svg+xml", ext: "svg" };
  if (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00)
    return { mime: "font/ttf", ext: "ttf" };
  if (b[0] === 0x4f && b[1] === 0x54 && b[2] === 0x54 && b[3] === 0x4f)
    return { mime: "font/otf", ext: "otf" };
  if (b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x46)
    return { mime: "font/woff", ext: "woff" };
  return { mime: "application/octet-stream", ext: "bin" };
}

const esc = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * MOBI markup is HTML, and its `mbp:`-prefixed tags would serialize into XML
 * with an unbound prefix — the resulting XHTML wouldn't parse. Flatten them and
 * drop anything else an EPUB reader has no business running.
 */
function sanitize(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll("script, base"))) el.remove();
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    if (el.tagName.includes(":")) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const bad =
        attr.name.includes(":") && !attr.name.startsWith("xml:") && !attr.name.startsWith("xmlns");
      if (bad || attr.name.startsWith("on")) el.removeAttribute(attr.name);
    }
  }
}

const isWellFormed = (xml: string): boolean =>
  !new DOMParser().parseFromString(xml, "application/xhtml+xml").querySelector("parsererror");

const wrapXhtml = (title: string, head: string, body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="${XHTML_NS}">
<head><meta charset="utf-8"/><title>${esc(title)}</title>${head}</head>
<body>
${body}
</body>
</html>`;

interface TocEntry {
  label: string;
  href: string | null;
  subitems: TocEntry[];
}

/**
 * A MOBI's text is one long stream cut at page breaks, so a 26-chapter book can
 * arrive as four sections. The reader names the current chapter by matching the
 * spine href against the TOC, and groups notes the same way — with several
 * chapters per file every note in the book would land under the first one.
 * Split each section at its TOC anchors so files and chapters line up.
 *
 * Returns one document per piece, or null when the section can't be split
 * safely (in which case the caller keeps the original).
 */
function splitAtAnchors(doc: Document, anchorIds: Set<string>): Document[] | null {
  const anchors = [...anchorIds]
    .map((id) => doc.getElementById(id))
    .filter((el): el is HTMLElement => !!el);
  if (anchors.length < 2) return null;

  // descend past wrappers that hold everything, so the split happens among
  // real siblings rather than on a single root <div>
  let container: Element = doc.body;
  for (;;) {
    const children = Array.from(container.children);
    const only = children.length === 1 ? children[0] : null;
    if (only && anchors.every((a) => only.contains(a)) && !anchorIds.has(only.id)) container = only;
    else break;
  }

  const children = Array.from(container.children);
  const topLevelIndexOf = (el: Element): number => {
    let node: Element | null = el;
    while (node && node.parentElement !== container) node = node.parentElement;
    return node ? children.indexOf(node) : -1;
  };
  const cuts = [...new Set(anchors.map(topLevelIndexOf).filter((i) => i > 0))].sort((a, b) => a - b);
  if (!cuts.length) return null;

  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (const cut of cuts) {
    ranges.push([from, cut]);
    from = cut;
  }
  ranges.push([from, children.length]);

  const containerPath: number[] = [];
  for (let node: Element = container; node !== doc.body; node = node.parentElement!)
    containerPath.unshift(Array.from(node.parentElement!.children).indexOf(node));

  const pieces = ranges.map(([start, end]) => {
    const clone = doc.cloneNode(true) as Document;
    let target: Element = clone.body;
    for (const step of containerPath) target = target.children[step];
    Array.from(target.children).forEach((child, i) => {
      if (i < start || i >= end) child.remove();
    });
    return clone;
  });

  // never trade content for tidier chapters
  const before = (doc.body.textContent ?? "").replace(/\s+/g, "");
  const after = pieces.map((p) => p.body.textContent ?? "").join("").replace(/\s+/g, "");
  return before === after ? pieces : null;
}

const navList = (items: TocEntry[]): string =>
  `<ol>${items
    .map(
      (it) =>
        `<li>${
          it.href ? `<a href="${esc(it.href)}">${esc(it.label)}</a>` : `<span>${esc(it.label)}</span>`
        }${it.subitems.length ? navList(it.subitems) : ""}</li>`
    )
    .join("")}</ol>`;

export async function mobiToEpub(
  file: File,
  onProgress?: (fraction: number) => void
): Promise<ConvertedBook> {
  const book: MobiBook = await new MOBI({ unzlib: unzlibSync }).open(file);
  try {
    if (!book.sections?.length) throw new Error("这本书没有可读的正文");

    // --- load every section up front: links can point forward, and anchors
    // have to be planted before anything is serialized
    const parser = new DOMParser();
    const docs: Document[] = [];
    for (const [i, section] of book.sections.entries()) {
      const url = await section.load();
      const html = await (await fetch(url)).text();
      const doc = parser.parseFromString(html, "text/html");
      sanitize(doc);
      docs.push(doc);
      onProgress?.(((i + 1) / book.sections.length) * 0.7);
    }

    // --- pull out images/fonts, which arrive as blob: URLs
    const resources = new Map<string, { name: string; mime: string; bytes: Uint8Array }>();
    for (const doc of docs) {
      for (const el of Array.from(doc.querySelectorAll("[src], [href], [poster]"))) {
        for (const attr of ["src", "href", "poster"]) {
          const value = el.getAttribute(attr);
          if (!value?.startsWith("blob:")) continue;
          let res = resources.get(value);
          if (!res) {
            const bytes = new Uint8Array(await (await fetch(value)).arrayBuffer());
            const { mime, ext } = sniff(bytes);
            res = { name: `res/r${resources.size + 1}.${ext}`, mime, bytes };
            resources.set(value, res);
          }
          el.setAttribute(attr, res.name);
        }
      }
    }

    // --- rewrite internal links, planting ids on the way
    let anchorSeq = 0;
    const hrefCache = new Map<string, string | null>();
    const resolveHref = async (href: string): Promise<string | null> => {
      const cached = hrefCache.get(href);
      if (cached !== undefined) return cached;
      let mapped: string | null = null;
      try {
        const target = await book.resolveHref(href);
        const doc = target && target.index >= 0 ? docs[target.index] : undefined;
        if (target && doc) {
          let fragment = "";
          try {
            const el = target.anchor?.(doc);
            if (el) {
              if (!el.id) el.id = `dotlib-anchor-${++anchorSeq}`;
              fragment = `#${el.id}`;
            }
          } catch {
            /* the recorded selector may not match anything */
          }
          mapped = `sec${target.index}.xhtml${fragment}`;
        }
      } catch {
        /* unresolvable link — drop it below */
      }
      hrefCache.set(href, mapped);
      return mapped;
    };

    const internal = /^(filepos:|kindle:pos)/i;
    for (const doc of docs) {
      for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
        const href = a.getAttribute("href")!;
        if (!internal.test(href)) continue;
        const mapped = await resolveHref(href);
        if (mapped) a.setAttribute("href", mapped);
        else a.removeAttribute("href");
      }
    }

    const mapToc = async (items: MobiTocItem[]): Promise<TocEntry[]> => {
      const out: TocEntry[] = [];
      for (const item of items) {
        out.push({
          label: item.label?.trim() || "（未命名）",
          href: item.href ? await resolveHref(item.href) : null,
          subitems: item.subitems?.length ? await mapToc(item.subitems) : [],
        });
      }
      return out;
    };
    const toc = book.toc?.length ? await mapToc(book.toc) : [];

    // --- one file per chapter, so the reader can name chapters and group notes
    const tocAnchorsBySection = new Map<number, Set<string>>();
    const collectAnchors = (entries: TocEntry[]): void => {
      for (const entry of entries) {
        const match = entry.href?.match(/^sec(\d+)\.xhtml#(.+)$/);
        if (match) {
          const index = Number(match[1]);
          if (!tocAnchorsBySection.has(index)) tocAnchorsBySection.set(index, new Set());
          tocAnchorsBySection.get(index)!.add(match[2]);
        }
        collectAnchors(entry.subitems);
      }
    };
    collectAnchors(toc);

    const finalDocs: Document[] = [];
    const sectionStart = new Map<number, number>(); // original index -> first final index
    const finalIndexOfId = new Map<string, number>();
    docs.forEach((doc, index) => {
      sectionStart.set(index, finalDocs.length);
      const anchors = tocAnchorsBySection.get(index);
      const pieces = (anchors && splitAtAnchors(doc, anchors)) || [doc];
      for (const piece of pieces) {
        const at = finalDocs.length;
        for (const el of Array.from(piece.querySelectorAll("[id]"))) finalIndexOfId.set(el.id, at);
        finalDocs.push(piece);
      }
    });

    // links and TOC were written against the pre-split numbering — retarget them
    const retarget = (href: string | null): string | null => {
      const match = href?.match(/^sec(\d+)\.xhtml(?:#(.+))?$/);
      if (!match) return href;
      const id = match[2];
      const index = (id ? finalIndexOfId.get(id) : undefined) ?? sectionStart.get(Number(match[1]));
      if (index === undefined) return null;
      return `sec${index}.xhtml${id ? `#${id}` : ""}`;
    };
    for (const doc of finalDocs)
      for (const a of Array.from(doc.querySelectorAll('a[href^="sec"]'))) {
        const next = retarget(a.getAttribute("href"));
        if (next) a.setAttribute("href", next);
        else a.removeAttribute("href");
      }
    const retargetToc = (entries: TocEntry[]): void => {
      for (const entry of entries) {
        entry.href = retarget(entry.href);
        retargetToc(entry.subitems);
      }
    };
    retargetToc(toc);
    onProgress?.(0.8);

    // --- serialize
    const serializer = new XMLSerializer();
    const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
    const meta = book.metadata ?? {};
    const bookTitle = meta.title?.trim() || file.name.replace(/\.(mobi|azw3?|prc)$/i, "");
    const author = meta.author?.filter(Boolean).join("、") ?? "";

    finalDocs.forEach((doc, i) => {
      const head = Array.from(doc.head?.querySelectorAll("style") ?? [])
        .map((style) => `<style type="text/css">${style.textContent ?? ""}</style>`)
        .join("");
      const body = Array.from(doc.body?.childNodes ?? [])
        .map((node) => serializer.serializeToString(node))
        .join("\n");
      let xhtml = wrapXhtml(bookTitle, head, body);
      if (!isWellFormed(xhtml)) {
        // last resort: keep the words, lose the markup, rather than ship a
        // section epub.js will render as a blank page
        xhtml = wrapXhtml(bookTitle, "", `<p>${esc(doc.body?.textContent ?? "")}</p>`);
      }
      files[`OEBPS/sec${i}.xhtml`] = enc(xhtml);
    });

    for (const res of resources.values()) files[`OEBPS/${res.name}`] = res.bytes;

    let coverBlob: Blob | null = null;
    let coverItem = "";
    let coverMeta = "";
    try {
      const cover = await book.getCover();
      if (cover && cover.size) {
        const bytes = new Uint8Array(await cover.arrayBuffer());
        const { mime, ext } = sniff(bytes);
        files[`OEBPS/cover.${ext}`] = bytes;
        coverBlob = new Blob([bytes], { type: mime });
        coverItem = `<item id="cover-image" href="cover.${ext}" media-type="${mime}" properties="cover-image"/>`;
        coverMeta = `<meta name="cover" content="cover-image"/>`;
      }
    } catch {
      /* no cover */
    }

    files["OEBPS/nav.xhtml"] = enc(
      wrapXhtml(
        "目录",
        "",
        `<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc" id="toc"><h1>目录</h1>${
          toc.length
            ? navList(toc)
            : `<ol>${finalDocs
                .map((_, i) => `<li><a href="sec${i}.xhtml">第 ${i + 1} 节</a></li>`)
                .join("")}</ol>`
        }</nav>`
      )
    );

    const manifest = [
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
      coverItem,
      ...finalDocs.map((_, i) => `<item id="sec${i}" href="sec${i}.xhtml" media-type="application/xhtml+xml"/>`),
      ...[...resources.values()].map(
        (r, i) => `<item id="res${i}" href="${r.name}" media-type="${r.mime}"/>`
      ),
    ]
      .filter(Boolean)
      .join("\n    ");

    files["OEBPS/content.opf"] = enc(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${esc(meta.identifier || `dotlib-${Date.now()}`)}</dc:identifier>
    <dc:title>${esc(bookTitle)}</dc:title>
    ${(meta.author ?? []).map((a) => `<dc:creator>${esc(a)}</dc:creator>`).join("\n    ")}
    <dc:language>${esc(
      (Array.isArray(meta.language) ? meta.language[0] : meta.language) || "zh"
    )}</dc:language>
    ${meta.publisher ? `<dc:publisher>${esc(meta.publisher)}</dc:publisher>` : ""}
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
    ${coverMeta}
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine>
    ${finalDocs.map((_, i) => `<itemref idref="sec${i}"/>`).join("\n    ")}
  </spine>
</package>`);

    files["META-INF/container.xml"] = enc(`<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

    // the mimetype entry must come first and be stored, not deflated
    const zipped = zipSync(
      { mimetype: [enc("application/epub+zip"), { level: 0 }], ...files },
      { level: 6 }
    );
    onProgress?.(1);

    const name = file.name.replace(/\.(mobi|azw3?|prc)$/i, "") + ".epub";
    return {
      file: new File([zipped as BlobPart], name, { type: "application/epub+zip" }),
      title: bookTitle,
      author,
      cover: coverBlob,
    };
  } finally {
    book.destroy?.();
  }
}
