import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { nanoid } from "nanoid";
import {
  abortMultipart,
  completeMultipart,
  createMultipart,
  deleteObject,
  getJson,
  getObjectBuffer,
  listKeys,
  putJson,
  putObject,
  uploadPart,
  type UploadedPart,
} from "./r2.js";
import type { BookFormat, BookMeta, Highlight, Progress, Rect } from "./types.js";

const app = new Hono();
app.use(logger());

const metaKey = (id: string) => `books/${id}/meta.json`;
const fileKey = (id: string, format: BookFormat) => `books/${id}/book.${format}`;
const coverKey = (id: string) => `books/${id}/cover`;
const highlightsKey = (id: string) => `books/${id}/highlights.json`;
const progressKey = (id: string) => `books/${id}/progress.json`;

const MIME: Record<BookFormat, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
};

const asFormat = (v: unknown): BookFormat => (v === "pdf" ? "pdf" : "epub");
/** Books added before PDF support carry no `format` — they are all epub. */
const normalizeMeta = (m: BookMeta): BookMeta => ({ ...m, format: asFormat(m.format) });
const normalizeHighlight = (h: Highlight): Highlight => ({
  ...h,
  page: typeof h.page === "number" ? h.page : 0,
  rects: Array.isArray(h.rects) ? h.rects : [],
});

// ---- books ----

app.get("/api/books", async (c) => {
  const keys = await listKeys("books/");
  const metaKeys = keys.filter((k) => k.endsWith("/meta.json"));
  const metas = (await Promise.all(metaKeys.map((k) => getJson<BookMeta>(k))))
    .filter((m): m is BookMeta => m !== null)
    .map(normalizeMeta);
  metas.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  return c.json(metas);
});

app.get("/api/books/:id", async (c) => {
  const meta = await getJson<BookMeta>(metaKey(c.req.param("id")));
  if (!meta) return c.json({ error: "not found" }, 404);
  return c.json(normalizeMeta(meta));
});

app.post("/api/books", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "missing file" }, 400);
  if (file.size > 200 * 1024 * 1024) return c.json({ error: "file too large" }, 413);

  const id = nanoid(12);
  const cover = body["cover"];
  const format = asFormat(
    typeof body["format"] === "string" && body["format"]
      ? body["format"]
      : /\.pdf$/i.test(file.name)
        ? "pdf"
        : "epub"
  );
  const meta: BookMeta = {
    id,
    title:
      typeof body["title"] === "string" && body["title"]
        ? body["title"]
        : file.name.replace(/\.(epub|pdf)$/i, ""),
    author: typeof body["author"] === "string" ? body["author"] : "",
    fileName: file.name,
    fileSize: file.size,
    hasCover: cover instanceof File,
    coverType: cover instanceof File ? cover.type : "",
    addedAt: new Date().toISOString(),
    format,
    ...(typeof body["sourceFormat"] === "string" && body["sourceFormat"]
      ? { sourceFormat: body["sourceFormat"] }
      : {}),
  };

  await putObject(fileKey(id, format), Buffer.from(await file.arrayBuffer()), MIME[format]);
  if (cover instanceof File) {
    await putObject(coverKey(id), Buffer.from(await cover.arrayBuffer()), cover.type || "image/jpeg");
  }
  await putJson(metaKey(id), meta);
  return c.json(meta, 201);
});

// ---- chunked upload ----
//
// Stateless on purpose: R2's uploadId and the part list live on the client and
// come back with each request, so nothing has to be remembered between them.

const MAX_SIZE = 500 * 1024 * 1024;
const idPattern = /^[A-Za-z0-9_-]{6,24}$/;

app.post("/api/books/upload/start", async (c) => {
  const { format, fileSize } = await c.req.json<{ format?: string; fileSize?: number }>();
  if (typeof fileSize === "number" && fileSize > MAX_SIZE)
    return c.json({ error: "file too large" }, 413);
  const fmt = asFormat(format);
  const id = nanoid(12);
  const uploadId = await createMultipart(fileKey(id, fmt), MIME[fmt]);
  return c.json({ id, uploadId, format: fmt, partSize: 8 * 1024 * 1024 }, 201);
});

app.put("/api/books/upload/:id/part", async (c) => {
  const id = c.req.param("id");
  if (!idPattern.test(id)) return c.json({ error: "bad id" }, 400);
  const uploadId = c.req.query("uploadId");
  const partNumber = Number(c.req.query("part"));
  const format = asFormat(c.req.query("format"));
  if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1)
    return c.json({ error: "missing uploadId or part" }, 400);
  const body = Buffer.from(await c.req.arrayBuffer());
  if (!body.length) return c.json({ error: "empty part" }, 400);
  const etag = await uploadPart(fileKey(id, format), uploadId, partNumber, body);
  return c.json({ partNumber, etag });
});

app.post("/api/books/upload/:id/finish", async (c) => {
  const id = c.req.param("id");
  if (!idPattern.test(id)) return c.json({ error: "bad id" }, 400);
  const input = await c.req.json<{
    uploadId: string;
    format?: string;
    parts: UploadedPart[];
    title?: string;
    author?: string;
    fileName?: string;
    fileSize?: number;
    cover?: string;
    coverType?: string;
    sourceFormat?: string;
  }>();
  if (!input.uploadId || !Array.isArray(input.parts) || !input.parts.length)
    return c.json({ error: "missing uploadId or parts" }, 400);

  const format = asFormat(input.format);
  await completeMultipart(fileKey(id, format), input.uploadId, input.parts);

  const cover = input.cover ? Buffer.from(input.cover, "base64") : null;
  if (cover?.length) await putObject(coverKey(id), cover, input.coverType || "image/jpeg");

  const fileName = input.fileName ?? "";
  const meta: BookMeta = {
    id,
    title: input.title || fileName.replace(/\.(epub|pdf)$/i, "") || "未命名",
    author: input.author ?? "",
    fileName,
    fileSize: input.fileSize ?? 0,
    hasCover: !!cover?.length,
    coverType: cover?.length ? input.coverType || "image/jpeg" : "",
    addedAt: new Date().toISOString(),
    format,
    ...(input.sourceFormat ? { sourceFormat: input.sourceFormat } : {}),
  };
  await putJson(metaKey(id), meta);
  return c.json(meta, 201);
});

app.post("/api/books/upload/:id/abort", async (c) => {
  const id = c.req.param("id");
  if (!idPattern.test(id)) return c.json({ error: "bad id" }, 400);
  const { uploadId, format } = await c.req.json<{ uploadId?: string; format?: string }>();
  if (!uploadId) return c.json({ error: "missing uploadId" }, 400);
  await abortMultipart(fileKey(id, asFormat(format)), uploadId).catch(() => {});
  return c.json({ ok: true });
});

app.get("/api/books/:id/file", async (c) => {
  const id = c.req.param("id");
  const meta = await getJson<BookMeta>(metaKey(id));
  const format = asFormat(meta?.format);
  const buf = await getObjectBuffer(fileKey(id, format));
  if (!buf) return c.json({ error: "not found" }, 404);
  return c.body(new Uint8Array(buf), 200, {
    "Content-Type": MIME[format],
    "Cache-Control": "private, max-age=3600",
  });
});

app.get("/api/books/:id/cover", async (c) => {
  const id = c.req.param("id");
  const meta = await getJson<BookMeta>(metaKey(id));
  if (!meta?.hasCover) return c.json({ error: "no cover" }, 404);
  const buf = await getObjectBuffer(coverKey(id));
  if (!buf) return c.json({ error: "not found" }, 404);
  return c.body(new Uint8Array(buf), 200, {
    "Content-Type": meta.coverType || "image/jpeg",
    "Cache-Control": "private, max-age=86400",
  });
});

app.delete("/api/books/:id", async (c) => {
  const id = c.req.param("id");
  const keys = await listKeys(`books/${id}/`);
  await Promise.all(keys.map((k) => deleteObject(k)));
  return c.json({ ok: true });
});

// ---- highlights ----

app.get("/api/books/:id/highlights", async (c) => {
  const list = await getJson<Highlight[]>(highlightsKey(c.req.param("id")));
  return c.json((list ?? []).map(normalizeHighlight));
});

app.post("/api/books/:id/highlights", async (c) => {
  const id = c.req.param("id");
  const input = await c.req.json<Partial<Highlight>>();
  // epub notes are anchored by cfi or chapter href, PDF notes by page number
  if (!input.cfiRange && !input.chapter && !input.page)
    return c.json({ error: "missing cfiRange, chapter or page" }, 400);
  const list = (await getJson<Highlight[]>(highlightsKey(id))) ?? [];
  const hl: Highlight = {
    id: nanoid(10),
    cfiRange: input.cfiRange ?? "",
    chapter: input.chapter ?? "",
    page: typeof input.page === "number" ? input.page : 0,
    rects: Array.isArray(input.rects) ? (input.rects as Rect[]) : [],
    text: input.text ?? "",
    color: input.color ?? "amber",
    note: input.note ?? "",
    createdAt: new Date().toISOString(),
  };
  list.push(hl);
  await putJson(highlightsKey(id), list);
  return c.json(hl, 201);
});

app.put("/api/books/:id/highlights/:hid", async (c) => {
  const { id, hid } = c.req.param();
  const patch = await c.req.json<Partial<Highlight>>();
  const list = (await getJson<Highlight[]>(highlightsKey(id))) ?? [];
  const hl = list.find((h) => h.id === hid);
  if (!hl) return c.json({ error: "not found" }, 404);
  if (patch.color !== undefined) hl.color = patch.color;
  if (patch.note !== undefined) hl.note = patch.note;
  await putJson(highlightsKey(id), list);
  return c.json(normalizeHighlight(hl));
});

app.delete("/api/books/:id/highlights/:hid", async (c) => {
  const { id, hid } = c.req.param();
  const list = (await getJson<Highlight[]>(highlightsKey(id))) ?? [];
  const next = list.filter((h) => h.id !== hid);
  if (next.length === list.length) return c.json({ error: "not found" }, 404);
  await putJson(highlightsKey(id), next);
  return c.json({ ok: true });
});

// ---- reading progress ----

app.get("/api/books/:id/progress", async (c) => {
  const p = await getJson<Progress>(progressKey(c.req.param("id")));
  if (!p) return c.json({ cfi: "", page: 0, percentage: 0, updatedAt: "" } satisfies Progress);
  return c.json({ ...p, page: typeof p.page === "number" ? p.page : 0 });
});

app.put("/api/books/:id/progress", async (c) => {
  const id = c.req.param("id");
  const input = await c.req.json<Partial<Progress>>();
  const p: Progress = {
    cfi: input.cfi ?? "",
    page: typeof input.page === "number" ? input.page : 0,
    percentage: input.percentage ?? 0,
    updatedAt: new Date().toISOString(),
  };
  await putJson(progressKey(id), p);
  return c.json(p);
});

// ---- static frontend (production build) ----

// hashed assets can be cached forever, pdf.js runtime data (cmaps/fonts/wasm)
// for a day since its path is stable across builds; everything else
// (index.html) must revalidate so new builds reach the browser immediately
app.use("/*", async (c, next) => {
  await next();
  const p = c.req.path;
  if (p.startsWith("/api/")) return;
  if (p.startsWith("/assets/")) c.header("Cache-Control", "public, max-age=31536000, immutable");
  else if (p.startsWith("/pdfjs/")) c.header("Cache-Control", "public, max-age=86400");
  else c.header("Cache-Control", "no-cache");
});
app.use("/*", serveStatic({ root: "./dist/client" }));
app.get("*", serveStatic({ path: "./dist/client/index.html" }));

const port = Number(process.env.PORT || 8787);
const hostname = process.env.HOST || "0.0.0.0";
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`dot-lib listening on http://localhost:${info.port}`);
});
