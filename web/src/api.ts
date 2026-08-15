import type { BookFormat, BookMeta, Highlight, Progress } from "./types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Files at or above this go up in parts (see uploadBookChunked). */
export const CHUNKED_ABOVE = 8 * 1024 * 1024;
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export const api = {
  listBooks: () => req<BookMeta[]>("/api/books"),
  getBook: (id: string) => req<BookMeta>(`/api/books/${id}`),

  uploadBook: (
    file: File,
    title: string,
    author: string,
    cover: Blob | null,
    format: BookFormat,
    sourceFormat?: string
  ) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("title", title);
    fd.append("author", author);
    fd.append("format", format);
    if (sourceFormat) fd.append("sourceFormat", sourceFormat);
    if (cover) fd.append("cover", cover, "cover");
    return req<BookMeta>("/api/books", { method: "POST", body: fd });
  },

  /**
   * Upload in parts. One long request for a whole book gets cut off by
   * Cloudflare's 100s origin timeout and forces the server to buffer the file
   * in memory; a few 8MB requests do neither, and a failed part is retried on
   * its own instead of restarting the book.
   */
  uploadBookChunked: async (
    file: File,
    title: string,
    author: string,
    cover: Blob | null,
    format: BookFormat,
    onProgress?: (fraction: number) => void,
    sourceFormat?: string
  ): Promise<BookMeta> => {
    const start = await req<{ id: string; uploadId: string; format: BookFormat; partSize: number }>(
      "/api/books/upload/start",
      json("POST", { format, fileSize: file.size })
    );
    const partSize = start.partSize || DEFAULT_PART_SIZE;
    const count = Math.max(Math.ceil(file.size / partSize), 1);
    const parts: Array<{ PartNumber: number; ETag: string }> = [];

    try {
      for (let i = 0; i < count; i++) {
        const chunk = file.slice(i * partSize, Math.min((i + 1) * partSize, file.size));
        const url =
          `/api/books/upload/${start.id}/part?uploadId=${encodeURIComponent(start.uploadId)}` +
          `&part=${i + 1}&format=${start.format}`;
        let etag = "";
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            ({ etag } = await req<{ etag: string }>(url, { method: "PUT", body: chunk }));
            break;
          } catch (err) {
            if (attempt) throw err;
          }
        }
        parts.push({ PartNumber: i + 1, ETag: etag });
        onProgress?.((i + 1) / count);
      }

      return await req<BookMeta>(
        `/api/books/upload/${start.id}/finish`,
        json("POST", {
          uploadId: start.uploadId,
          format: start.format,
          parts,
          title,
          author,
          fileName: file.name,
          fileSize: file.size,
          cover: cover ? await blobToBase64(cover) : undefined,
          coverType: cover?.type || "image/jpeg",
          sourceFormat,
        })
      );
    } catch (err) {
      // leave no half-finished multipart upload lingering in the bucket
      await fetch(
        `/api/books/upload/${start.id}/abort`,
        json("POST", { uploadId: start.uploadId, format: start.format })
      ).catch(() => {});
      throw err;
    }
  },

  deleteBook: (id: string) => req<{ ok: true }>(`/api/books/${id}`, { method: "DELETE" }),

  bookFileUrl: (id: string) => `/api/books/${id}/file`,
  coverUrl: (id: string) => `/api/books/${id}/cover`,

  listHighlights: (id: string) => req<Highlight[]>(`/api/books/${id}/highlights`),
  addHighlight: (
    id: string,
    hl: Partial<Pick<Highlight, "cfiRange" | "chapter" | "page" | "rects" | "text" | "color">>
  ) => req<Highlight>(`/api/books/${id}/highlights`, json("POST", hl)),
  updateHighlight: (id: string, hid: string, patch: Partial<Highlight>) =>
    req<Highlight>(`/api/books/${id}/highlights/${hid}`, json("PUT", patch)),
  deleteHighlight: (id: string, hid: string) =>
    req<{ ok: true }>(`/api/books/${id}/highlights/${hid}`, { method: "DELETE" }),

  getProgress: (id: string) => req<Progress>(`/api/books/${id}/progress`),
  saveProgress: (id: string, p: { cfi?: string; page?: number; percentage: number }) =>
    req<Progress>(`/api/books/${id}/progress`, json("PUT", p)),
};
