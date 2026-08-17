import ePub from "epubjs";
import { CHUNKED_ABOVE, api } from "./api";
import { toast } from "./main";
import { openPdf } from "./pdfjs";
import type { BookFormat, BookMeta } from "./types";

const ACCEPTED = /\.(epub|pdf|mobi|azw3?|prc)$/i;
const KINDLE = /\.(mobi|azw3?|prc)$/i;
/** Kindle books are converted to epub on import, so they end up stored as epub. */
const formatOf = (file: File): BookFormat => (/\.pdf$/i.test(file.name) ? "pdf" : "epub");
const sourceFormatOf = (file: File): string | undefined =>
  KINDLE.test(file.name) ? (file.name.match(KINDLE)![1].toLowerCase() as string) : undefined;
const nameOf = (file: File): string => file.name.replace(ACCEPTED, "");
const PARSE_TIMEOUT = 30_000;

/** Resolve with `fallback` if the work rejects or takes too long. */
function withTimeout<T>(work: Promise<T>, fallback: T, ms = PARSE_TIMEOUT): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    const settle = (value: T) => {
      clearTimeout(timer);
      resolve(value);
    };
    work.then(settle, (err) => {
      console.error(err);
      settle(fallback);
    });
  });
}

export async function renderLibrary(root: HTMLElement): Promise<() => void> {
  root.innerHTML = `
    <header class="lib-header">
      <div class="wordmark">
        <div class="seal">书</div>
        <h1>点·藏书<span class="sub">dot-lib · private shelf</span></h1>
      </div>
      <div>
        <input
          type="file"
          id="file-input"
          accept=".epub,.pdf,.mobi,.azw,.azw3,.prc,application/epub+zip,application/pdf"
          hidden
          multiple
        />
        <button class="btn-primary" id="upload-btn">上传图书</button>
      </div>
    </header>
    <main class="lib-main">
      <div id="shelf"></div>
    </main>
  `;

  const fileInput = root.querySelector<HTMLInputElement>("#file-input")!;
  const uploadBtn = root.querySelector<HTMLButtonElement>("#upload-btn")!;
  const shelf = root.querySelector<HTMLElement>("#shelf")!;

  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    await uploadFiles(files);
  });

  // drag & drop anywhere on the page
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    document.body.classList.add("dragover");
  };
  const onDragLeave = () => document.body.classList.remove("dragover");
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    document.body.classList.remove("dragover");
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => ACCEPTED.test(f.name));
    if (!files.length) return;
    await uploadFiles(files);
  };
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);

  async function uploadFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    uploadBtn.disabled = true;
    for (const file of files) {
      uploadBtn.textContent = `解析《${file.name}》…`;
      const format = formatOf(file);
      const sourceFormat = sourceFormatOf(file);
      try {
        // Kindle formats have no reader here — convert to epub while the file
        // is still in the browser, then upload the conversion.
        let upload = file;
        let info: BookInfo;
        if (sourceFormat) {
          uploadBtn.textContent = `转换《${nameOf(file)}》…`;
          const { mobiToEpub } = await import("./mobi-to-epub");
          const converted = await mobiToEpub(file, (done) => {
            uploadBtn.textContent = `转换《${nameOf(file)}》 ${Math.round(done * 100)}%`;
          });
          upload = converted.file;
          info = { title: converted.title, author: converted.author, cover: converted.cover };
        } else {
          // Neither parser reliably rejects on a broken file — epub.js just never
          // settles, and pdf.js waits forever on an encrypted one. Give up after
          // a while and file the book under its name rather than wedging the UI.
          const fallback: BookInfo = { title: nameOf(file), author: "", cover: null };
          info = await withTimeout(
            format === "pdf" ? extractPdfInfo(file) : extractEpubInfo(file),
            fallback
          );
          if (info === fallback) toast(`《${nameOf(file)}》读不出信息，按文件名入库`, true);
        }
        const { title, author, cover } = info;
        uploadBtn.textContent = `上传《${title}》…`;
        if (upload.size > CHUNKED_ABOVE) {
          await api.uploadBookChunked(
            upload,
            title,
            author,
            cover,
            format,
            (done) => {
              uploadBtn.textContent = `上传《${title}》 ${Math.round(done * 100)}%`;
            },
            sourceFormat
          );
        } else {
          await api.uploadBook(upload, title, author, cover, format, sourceFormat);
        }
        toast(`《${title}》已入库`);
      } catch (err) {
        console.error(err);
        toast(`上传失败：${file.name}`, true);
      }
    }
    uploadBtn.disabled = false;
    uploadBtn.textContent = "上传图书";
    await refresh();
  }

  async function refresh(): Promise<void> {
    let books: BookMeta[];
    try {
      books = await api.listBooks();
    } catch (err) {
      shelf.innerHTML = `<div class="empty"><div class="glyph">×</div><h2>无法连接书库</h2><p>${escapeHtml(String(err))}</p></div>`;
      return;
    }

    if (!books.length) {
      shelf.innerHTML = `
        <div class="empty">
          <div class="glyph">⟡</div>
          <h2>书架还空着</h2>
          <p>点击右上角「上传图书」，<br/>或把 .epub / .pdf / .mobi 文件拖到页面任意处。</p>
        </div>`;
      return;
    }

    shelf.innerHTML = `
      <p class="shelf-count">藏书 ${books.length} 册</p>
      <div class="book-grid">
        ${books.map(cardHtml).join("")}
      </div>`;

    shelf.querySelectorAll<HTMLElement>("[data-open]").forEach((el) =>
      el.addEventListener("click", () => (location.hash = `#/read/${el.dataset.open}`))
    );
    shelf.querySelectorAll<HTMLElement>("[data-delete]").forEach((el) =>
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = el.dataset.delete!;
        const title = el.dataset.title ?? "";
        if (!confirm(`确定删除《${title}》？划线与进度将一并删除。`)) return;
        try {
          await api.deleteBook(id);
          toast(`《${title}》已删除`);
          await refresh();
        } catch {
          toast("删除失败", true);
        }
      })
    );

    // fill progress rows lazily (one request per book, fire-and-forget)
    shelf.querySelectorAll<HTMLElement>("[data-progress]").forEach(async (el) => {
      try {
        const p = await api.getProgress(el.dataset.progress!);
        const pct = Math.round((p.percentage || 0) * 100);
        const started = pct > 0 || !!p.cfi || p.page > 0;
        el.querySelector<HTMLElement>(".bar i")!.style.width = `${pct}%`;
        el.querySelector<HTMLElement>(".pct")!.textContent =
          pct >= 99 ? "读完" : started ? `读至 ${pct}%` : "未读";
        el.classList.toggle("done", pct >= 99);
      } catch {
        /* ignore */
      }
    });
  }

  function cardHtml(b: BookMeta): string {
    const coverInner = b.hasCover
      ? `<img src="${api.coverUrl(b.id)}" alt="" loading="lazy" />`
      : `<div class="placeholder"><span class="t">${escapeHtml(b.title)}</span><span class="a">${escapeHtml(b.author)}</span></div>`;
    return `
      <div class="book-card">
        <div class="cover" data-open="${b.id}" title="打开阅读">
          ${coverInner}
          <span class="format-tag format-${b.sourceFormat ?? b.format}">${(
            b.sourceFormat ?? b.format
          ).toUpperCase()}</span>
        </div>
        <div class="read-progress" data-progress="${b.id}">
          <div class="bar"><i style="width:0"></i></div>
          <span class="pct"></span>
        </div>
        <div class="meta">
          <div class="title">${escapeHtml(b.title)}</div>
          <div class="author">${escapeHtml(b.author || "佚名")}</div>
        </div>
        <div class="card-actions">
          <button data-open="${b.id}">阅读</button>
          <button data-delete="${b.id}" data-title="${escapeHtml(b.title)}">删除</button>
        </div>
      </div>`;
  }

  await refresh();

  return () => {
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("dragleave", onDragLeave);
    window.removeEventListener("drop", onDrop);
  };
}

type BookInfo = { title: string; author: string; cover: Blob | null };

/** Read the PDF's info dictionary and paint page 1 as the cover. */
async function extractPdfInfo(file: File): Promise<BookInfo> {
  const fallback = file.name.replace(/\.pdf$/i, "");
  let doc: Awaited<ReturnType<typeof openPdf>> | null = null;
  try {
    doc = await openPdf(await file.arrayBuffer());
    const { info } = (await doc.getMetadata()) as {
      info?: { Title?: string; Author?: string };
    };
    // many PDFs carry a junk Title like "Microsoft Word - draft.doc"
    const title = info?.Title?.trim();
    return {
      title: title && !/^untitled$/i.test(title) ? title : fallback,
      author: info?.Author?.trim() ?? "",
      cover: await renderFirstPage(doc),
    };
  } catch {
    return { title: fallback, author: "", cover: null };
  } finally {
    doc?.loadingTask.destroy().catch(() => {});
  }
}

async function renderFirstPage(doc: Awaited<ReturnType<typeof openPdf>>): Promise<Blob | null> {
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(720 / base.width, 3) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    page.cleanup();
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82)
    );
  } catch {
    return null;
  }
}

/** Parse the epub locally to extract title / author / cover before uploading. */
async function extractEpubInfo(file: File): Promise<BookInfo> {
  const fallback = file.name.replace(/\.epub$/i, "");
  try {
    const book = ePub(await file.arrayBuffer());
    const meta = await book.loaded.metadata;
    let cover: Blob | null = null;
    try {
      const coverUrl = await book.coverUrl();
      if (coverUrl) cover = await (await fetch(coverUrl)).blob();
    } catch {
      /* no cover */
    }
    const info = {
      title: meta.title?.trim() || fallback,
      author: meta.creator?.trim() || "",
      cover,
    };
    book.destroy();
    return info;
  } catch {
    return { title: fallback, author: "", cover: null };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
