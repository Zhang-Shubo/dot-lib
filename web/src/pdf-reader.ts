import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { api } from "./api";
import { toast } from "./main";
import { loadPdfjs, openPdf } from "./pdfjs";
import { THEMES, readTheme, themeChipsHtml } from "./themes";
import { HIGHLIGHT_COLORS, type BookMeta, type Highlight, type Rect } from "./types";

// zoom multipliers applied on top of fit-to-width
const ZOOMS: Record<string, number> = { s: 0.82, m: 1, l: 1.3 };
const PAGE_GAP = 18;
const SIDE_PAD = 24;
/** how far outside the viewport pages are kept rendered (in viewport heights) */
const PRERENDER = "120%";

type TextLayerLike = { render: () => Promise<unknown>; cancel: () => void };

type Slot = {
  num: number;
  el: HTMLElement;
  textEl: HTMLElement;
  hlEl: HTMLElement;
  /** page size in css px at scale 1 (rotation applied) */
  baseW: number;
  baseH: number;
  scale: number;
  canvas: HTMLCanvasElement | null;
  task: RenderTask | null;
  textLayer: TextLayerLike | null;
  state: "empty" | "rendering" | "done";
  /** bumped on every release so an in-flight render knows it was superseded */
  gen: number;
};

export async function renderPdfReader(root: HTMLElement, meta: BookMeta): Promise<() => void> {
  const bookId = meta.id;
  root.innerHTML = `
    <div class="reader" id="reader-root">
      <div class="reader-top">
        <button class="icon-btn" id="back" title="返回书架">←</button>
        <button class="icon-btn" id="toggle-toc" title="目录">☰</button>
        <div class="reader-title" id="book-title">载入中…</div>
        <button class="icon-btn active" id="toggle-rail" title="笔记栏">✎</button>
        <button class="icon-btn" id="toggle-settings" title="设置">Aa</button>
      </div>
      <div class="reader-body" id="reader-body">
        <div class="text-pane">
          <div class="loading" id="loading">书页展开中 …</div>
          <div id="viewer"><div class="pdf-scroll" id="pdf-scroll"></div></div>
        </div>
        <aside class="note-rail" id="note-rail">
          <div class="rail-resizer" id="rail-resizer" title="拖动调整宽度"></div>
          <div class="rail-head">
            <h3>笔 记</h3>
            <button id="add-page-note" title="给当前页添加一页笔记">＋ 记一页</button>
          </div>
          <div class="rail-scroll" id="rail-scroll"></div>
        </aside>
        <aside class="drawer" id="toc-drawer"><h3>目 录</h3><div class="scroll" id="toc-list"></div></aside>
        <div class="settings" id="settings">
          <div class="group">
            <label>缩放</label>
            <div class="row" id="zoom-row">
              <button class="chip" data-zoom="s">小</button>
              <button class="chip" data-zoom="m">中</button>
              <button class="chip" data-zoom="l">大</button>
            </div>
          </div>
          <div class="group">
            <label>底色</label>
            <div class="row wrap" id="theme-row">${themeChipsHtml()}</div>
          </div>
        </div>
      </div>
      <div class="reader-foot">
        <span id="pct">0%</span>
        <div class="bar"><i id="pct-bar"></i></div>
        <span class="page-jump">第 <input id="page-input" type="text" inputmode="numeric" value="1" /> / <b id="page-total">–</b> 页</span>
      </div>
    </div>
  `;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const readerRoot = $("#reader-root");
  const readerBody = $("#reader-body");
  const scroller = $("#pdf-scroll");
  const railScroll = $("#rail-scroll");
  const disposers: Array<() => void> = [];
  let destroyed = false;

  $("#book-title").textContent = meta.title;
  document.title = `${meta.title} — 点·藏书`;
  $("#back").addEventListener("click", () => (location.hash = "#/"));

  // ---- load book data ----
  const [highlights, progress, fileBuf] = await Promise.all([
    api.listHighlights(bookId).catch(() => [] as Highlight[]),
    api.getProgress(bookId).catch(() => ({ cfi: "", page: 0, percentage: 0, updatedAt: "" })),
    fetch(api.bookFileUrl(bookId)).then((r) => {
      if (!r.ok) throw new Error(`无法下载图书 (${r.status})`);
      return r.arrayBuffer();
    }),
  ]).catch((err) => {
    toast(String(err), true);
    location.hash = "#/";
    throw err;
  });

  const pdfjs = await loadPdfjs();
  let doc: PDFDocumentProxy;
  try {
    doc = await openPdf(fileBuf);
  } catch (err) {
    toast(`PDF 解析失败：${err}`, true);
    location.hash = "#/";
    throw err;
  }
  const total = doc.numPages;
  $("#page-total").textContent = String(total);

  // pdf.js caches page proxies internally, but going through one map keeps the
  // measure pass and the render pass from racing on the same page.
  const pageCache = new Map<number, Promise<PDFPageProxy>>();
  const getPage = (n: number): Promise<PDFPageProxy> => {
    let p = pageCache.get(n);
    if (!p) {
      p = doc.getPage(n);
      pageCache.set(n, p);
    }
    return p;
  };

  // ---- measure every page so the scroll geometry is right from the start ----
  const slots: Slot[] = [];
  const loadingEl = $("#loading");
  {
    const dims: Array<{ w: number; h: number }> = new Array(total);
    const CHUNK = 16;
    for (let start = 1; start <= total; start += CHUNK) {
      if (destroyed) break;
      const batch: Promise<void>[] = [];
      for (let n = start; n < start + CHUNK && n <= total; n++) {
        batch.push(
          getPage(n).then((page) => {
            const v = page.getViewport({ scale: 1 });
            dims[n - 1] = { w: v.width, h: v.height };
          })
        );
      }
      await Promise.all(batch);
      if (total > 60) loadingEl.textContent = `书页展开中 … ${Math.min(start + CHUNK - 1, total)}/${total}`;
    }

    const frag = document.createDocumentFragment();
    for (let n = 1; n <= total; n++) {
      const el = document.createElement("div");
      el.className = "pdf-page";
      el.dataset.page = String(n);
      el.innerHTML = `<div class="pdf-text"></div><div class="pdf-hl"></div><span class="pdf-pageno">${n}</span>`;
      frag.appendChild(el);
      slots.push({
        num: n,
        el,
        textEl: el.querySelector<HTMLElement>(".pdf-text")!,
        hlEl: el.querySelector<HTMLElement>(".pdf-hl")!,
        baseW: dims[n - 1]?.w || 595,
        baseH: dims[n - 1]?.h || 842,
        scale: 1,
        canvas: null,
        task: null,
        textLayer: null,
        state: "empty",
        gen: 0,
      });
    }
    scroller.appendChild(frag);
  }

  // ---- zoom / theme ----
  const prefs = { zoom: localStorage.getItem("dotlib.pdfzoom") ?? "m", theme: readTheme() };
  const applyPrefs = (): void => {
    readerRoot.classList.remove(...Object.keys(THEMES).map((t) => `theme-${t}`));
    readerRoot.classList.add(`theme-${prefs.theme}`);
    root
      .querySelectorAll<HTMLElement>("#zoom-row .chip")
      .forEach((c) => c.classList.toggle("active", c.dataset.zoom === prefs.zoom));
    root
      .querySelectorAll<HTMLElement>("#theme-row .chip")
      .forEach((c) => c.classList.toggle("active", c.dataset.theme === prefs.theme));
  };
  applyPrefs();

  // ---- layout ----
  const visible = new Set<number>();

  function layout(): void {
    const avail = Math.max(scroller.clientWidth - SIDE_PAD * 2, 200);
    const zoom = ZOOMS[prefs.zoom] ?? 1;
    for (const slot of slots) {
      slot.scale = Math.min(Math.max((avail / slot.baseW) * zoom, 0.1), 6);
      const w = Math.round(slot.baseW * slot.scale);
      const h = Math.round(slot.baseH * slot.scale);
      slot.el.style.width = `${w}px`;
      slot.el.style.height = `${h}px`;
      slot.el.style.setProperty("--scale-factor", String(slot.scale));
    }
  }

  /** Where we are now, as a page number plus a fraction of that page. */
  function position(): { page: number; frac: number } {
    const top = scroller.scrollTop;
    let lo = 0;
    let hi = slots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (slots[mid].el.offsetTop <= top) lo = mid;
      else hi = mid - 1;
    }
    const slot = slots[lo];
    const h = slot.el.offsetHeight + PAGE_GAP;
    const frac = Math.min(Math.max((top - slot.el.offsetTop) / h, 0), 1);
    return { page: slot.num, frac };
  }

  function scrollToPosition(page: number, frac = 0): void {
    const slot = slots[Math.min(Math.max(page, 1), total) - 1];
    if (!slot) return;
    scroller.scrollTop = slot.el.offsetTop + frac * (slot.el.offsetHeight + PAGE_GAP);
  }

  layout();
  // restore where we left off; percentage carries the sub-page offset
  if (progress.page > 0) {
    const frac = Math.min(Math.max((progress.percentage || 0) * total - (progress.page - 1), 0), 0.99);
    scrollToPosition(progress.page, frac);
  }

  // ---- page rendering ----
  function releaseSlot(slot: Slot): void {
    slot.gen++;
    slot.task?.cancel();
    slot.task = null;
    slot.textLayer?.cancel();
    slot.textLayer = null;
    slot.canvas?.remove();
    slot.canvas = null;
    slot.textEl.textContent = "";
    slot.state = "empty";
  }

  let firstPainted = false;
  async function renderSlot(slot: Slot): Promise<void> {
    if (destroyed || slot.state !== "empty") return;
    slot.state = "rendering";
    const gen = slot.gen;
    const scale = slot.scale;
    const stale = () => destroyed || slot.gen !== gen;
    try {
      const page = await getPage(slot.num);
      if (stale()) return;
      if (!visible.has(slot.num)) {
        slot.state = "empty";
        return;
      }
      const viewport = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-canvas";
      canvas.width = Math.ceil(viewport.width * dpr);
      canvas.height = Math.ceil(viewport.height * dpr);
      canvas.style.width = `${Math.round(slot.baseW * scale)}px`;
      canvas.style.height = `${Math.round(slot.baseH * scale)}px`;
      slot.canvas = canvas;
      slot.el.insertBefore(canvas, slot.textEl);

      slot.task = page.render({
        canvas,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      });
      await slot.task.promise;
      slot.task = null;

      const textContent = await page.getTextContent();
      if (stale()) return;
      slot.textEl.textContent = "";
      const layer = new pdfjs.TextLayer({
        textContentSource: textContent,
        container: slot.textEl,
        viewport,
      }) as unknown as TextLayerLike;
      slot.textLayer = layer;
      await layer.render();
      if (stale()) return;
      slot.state = "done";
      if (!firstPainted) {
        firstPainted = true;
        loadingEl.remove();
      }
    } catch (err) {
      // a cancelled render is the normal outcome of scrolling fast / zooming
      if ((err as { name?: string })?.name !== "RenderingCancelledException") console.error(err);
      if (!stale() && slot.state === "rendering") releaseSlot(slot);
    }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const slot = slots[Number((entry.target as HTMLElement).dataset.page) - 1];
        if (!slot) continue;
        if (entry.isIntersecting) {
          visible.add(slot.num);
          void renderSlot(slot);
        } else {
          visible.delete(slot.num);
          releaseSlot(slot);
        }
      }
    },
    { root: scroller, rootMargin: `${PRERENDER} 0px` }
  );
  slots.forEach((s) => observer.observe(s.el));
  disposers.push(() => observer.disconnect());

  // nothing to render (e.g. an empty document) — don't leave the veil up
  setTimeout(() => {
    if (!firstPainted && !destroyed) loadingEl.remove();
  }, 8000);

  function rerenderVisible(): void {
    for (const num of visible) {
      const slot = slots[num - 1];
      releaseSlot(slot);
      void renderSlot(slot);
    }
  }

  /** Re-fit pages after a zoom change or a pane resize, keeping the reading spot. */
  function relayout(): void {
    const at = position();
    layout();
    scrollToPosition(at.page, at.frac);
    rerenderVisible();
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastWidth = scroller.clientWidth;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (destroyed || scroller.clientWidth === lastWidth) return;
      lastWidth = scroller.clientWidth;
      relayout();
    }, 200);
  };
  window.addEventListener("resize", onResize);
  disposers.push(() => {
    window.removeEventListener("resize", onResize);
    clearTimeout(resizeTimer);
  });

  // ---- progress ----
  let currentPage = progress.page > 0 ? progress.page : 1;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let ticking = false;
  const pageInput = $<HTMLInputElement>("#page-input");

  function onScroll(): void {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const { page, frac } = position();
      const pct = Math.min((page - 1 + frac) / total, 1);
      $("#pct").textContent = `${Math.round(pct * 100)}%`;
      $("#pct-bar").style.width = `${pct * 100}%`;
      if (page !== currentPage) {
        currentPage = page;
        if (document.activeElement !== pageInput) pageInput.value = String(page);
        markCurrentPage();
      }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        api.saveProgress(bookId, { page, percentage: pct }).catch(() => {});
      }, 800);
    });
  }
  scroller.addEventListener("scroll", onScroll, { passive: true });
  disposers.push(() => {
    scroller.removeEventListener("scroll", onScroll);
    clearTimeout(saveTimer);
  });
  onScroll();

  pageInput.value = String(currentPage);
  const jump = () => {
    const n = Math.min(Math.max(parseInt(pageInput.value, 10) || 1, 1), total);
    pageInput.value = String(n);
    scrollToPosition(n);
    pageInput.blur();
  };
  pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") jump();
  });
  pageInput.addEventListener("blur", () => (pageInput.value = String(currentPage)));

  // ---- chrome: drawer, rail, settings ----
  const tocDrawer = $("#toc-drawer");
  const settings = $("#settings");
  $("#toggle-toc").addEventListener("click", () => {
    settings.classList.remove("open");
    tocDrawer.classList.toggle("open");
  });
  $("#toggle-rail").addEventListener("click", () => {
    readerBody.classList.toggle("rail-hidden");
    $("#toggle-rail").classList.toggle("active", !readerBody.classList.contains("rail-hidden"));
    onResize();
  });
  $("#toggle-settings").addEventListener("click", () => settings.classList.toggle("open"));

  {
    let railW = Number(localStorage.getItem("dotlib.railw")) || 400;
    const clamp = (w: number) => Math.min(Math.max(w, 280), Math.round(window.innerWidth * 0.6));
    const apply = () => readerBody.style.setProperty("--rail-w", `${clamp(railW)}px`);
    apply();
    const resizer = $("#rail-resizer");
    resizer.addEventListener("pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      try {
        resizer.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events */
      }
      readerBody.classList.add("resizing");
      const onMove = (ev: PointerEvent) => {
        railW = clamp(window.innerWidth - ev.clientX);
        apply();
      };
      const onUp = () => {
        readerBody.classList.remove("resizing");
        localStorage.setItem("dotlib.railw", String(clamp(railW)));
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onUp);
        onResize();
      };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
    });
  }

  $("#zoom-row").addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-zoom]");
    if (!chip) return;
    prefs.zoom = chip.dataset.zoom!;
    localStorage.setItem("dotlib.pdfzoom", prefs.zoom);
    applyPrefs();
    relayout();
  });
  $("#theme-row").addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-theme]");
    if (!chip) return;
    prefs.theme = chip.dataset.theme!;
    localStorage.setItem("dotlib.theme", prefs.theme);
    applyPrefs();
  });

  // ---- outline ----
  type OutlineNode = { title: string; items?: OutlineNode[]; dest?: unknown };
  const destPage = async (dest: unknown): Promise<number | null> => {
    try {
      const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      const ref = Array.isArray(explicit) ? explicit[0] : null;
      if (ref === null || ref === undefined) return null;
      // an explicit destination starts with either a page ref or a page index
      if (typeof ref === "number") return ref + 1;
      return (await doc.getPageIndex(ref as never)) + 1;
    } catch {
      return null;
    }
  };

  {
    const list = $("#toc-list");
    const nodes: OutlineNode[] = [];
    const walk = (items: OutlineNode[], depth: number): string =>
      items
        .map((it) => {
          const idx = nodes.push(it) - 1;
          return (
            `<button class="toc-item depth-${Math.min(depth, 2)}" data-idx="${idx}">${escapeHtml(
              it.title?.trim() || "（未命名）"
            )}</button>` + walk(it.items ?? [], depth + 1)
          );
        })
        .join("");
    const outline = (await doc.getOutline().catch(() => null)) as OutlineNode[] | null;
    list.innerHTML = outline?.length
      ? walk(outline, 0)
      : `<div class="none">此书没有目录，<br/>用底部页码框跳转</div>`;
    list.querySelectorAll<HTMLElement>("[data-idx]").forEach((el) =>
      el.addEventListener("click", async () => {
        const n = await destPage(nodes[Number(el.dataset.idx)]?.dest);
        if (n) scrollToPosition(n);
        else toast("这条目录没有指向页码", true);
        tocDrawer.classList.remove("open");
      })
    );
  }

  // keyboard scrolling
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
    if (e.key === "ArrowDown") scroller.scrollBy({ top: 120, behavior: "smooth" });
    else if (e.key === "ArrowUp") scroller.scrollBy({ top: -120, behavior: "smooth" });
    else if (e.key === "PageDown" || e.key === " ")
      scroller.scrollBy({ top: scroller.clientHeight * 0.9, behavior: "smooth" });
    else if (e.key === "PageUp") scroller.scrollBy({ top: -scroller.clientHeight * 0.9, behavior: "smooth" });
    else if (e.key === "ArrowRight") scrollToPosition(Math.min(currentPage + 1, total));
    else if (e.key === "ArrowLeft") scrollToPosition(Math.max(currentPage - 1, 1));
    else return;
    e.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  disposers.push(() => document.removeEventListener("keydown", onKey));

  // ---- notes ----
  let hls: Highlight[] = highlights.filter((h) => h.page > 0);
  const colorOf = (name: string) => HIGHLIGHT_COLORS[name] ?? HIGHLIGHT_COLORS.amber;
  const noteSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function paint(hl: Highlight): void {
    const slot = slots[hl.page - 1];
    if (!slot || !hl.rects.length) return;
    for (const r of hl.rects) {
      const box = document.createElement("i");
      box.className = "pdf-hl-box";
      box.dataset.hl = hl.id;
      box.style.left = `${r.x * 100}%`;
      box.style.top = `${r.y * 100}%`;
      box.style.width = `${r.w * 100}%`;
      box.style.height = `${r.h * 100}%`;
      box.style.background = colorOf(hl.color);
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        showPopup(e.clientX, e.clientY, { existing: hl });
      });
      slot.hlEl.appendChild(box);
    }
  }

  const unpaint = (hl: Highlight): void => {
    slots[hl.page - 1]?.hlEl.querySelectorAll(`[data-hl="${hl.id}"]`).forEach((el) => el.remove());
  };
  hls.forEach(paint);

  const topOf = (hl: Highlight): number => (hl.rects.length ? Math.min(...hl.rects.map((r) => r.y)) : -1);

  function renderRail(): void {
    const groups = new Map<number, Highlight[]>();
    for (const hl of hls) {
      if (!groups.has(hl.page)) groups.set(hl.page, []);
      groups.get(hl.page)!.push(hl);
    }
    const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, list] of ordered) {
      list.sort((a, b) => topOf(a) - topOf(b) || a.createdAt.localeCompare(b.createdAt));
    }

    if (!ordered.length) {
      railScroll.innerHTML = `<div class="none">选中正文文字划线，<br/>或点上方「＋ 记一页」<br/>给本页添加笔记。</div>`;
      return;
    }

    railScroll.innerHTML = ordered
      .map(
        ([page, list]) => `
        <section class="note-group" data-page="${page}">
          <header class="group-head">第 ${page} 页<i>${list.length}</i></header>
          ${list.map(cardHtml).join("")}
        </section>`
      )
      .join("");

    railScroll.querySelectorAll<HTMLElement>(".note-card").forEach((card) => {
      const hl = hls.find((h) => h.id === card.dataset.id);
      if (!hl) return;
      card.querySelector<HTMLElement>(".excerpt")?.addEventListener("click", () => {
        const y = topOf(hl);
        scrollToPosition(hl.page, y > 0.06 ? y - 0.06 : 0);
      });
      card.querySelector<HTMLElement>("[data-del]")?.addEventListener("click", () => removeNote(hl));
      card.querySelector<HTMLElement>("[data-share]")?.addEventListener("click", () => shareNote(hl));
      const ta = card.querySelector<HTMLTextAreaElement>("textarea");
      if (ta) {
        const autosize = () => {
          ta.style.height = "auto";
          ta.style.height = `${ta.scrollHeight}px`;
        };
        autosize();
        ta.addEventListener("input", () => {
          autosize();
          clearTimeout(noteSaveTimers.get(hl.id));
          noteSaveTimers.set(
            hl.id,
            setTimeout(() => saveNote(hl, ta.value), 900)
          );
        });
        ta.addEventListener("blur", () => {
          clearTimeout(noteSaveTimers.get(hl.id));
          if (ta.value !== hl.note) saveNote(hl, ta.value);
        });
      }
    });
    markCurrentPage();
  }

  function cardHtml(hl: Highlight): string {
    const excerpt = hl.rects.length
      ? `<div class="excerpt" style="border-color:${colorOf(hl.color)}" title="跳到原文">${escapeHtml(
          hl.text || "（无摘录）"
        )}</div>`
      : `<div class="page-mark">✎ 本页笔记</div>`;
    const share = hl.rects.length && hl.text ? `<button data-share="1">分享</button>` : "";
    return `
      <div class="note-card" data-id="${hl.id}">
        ${excerpt}
        <textarea class="note-input" placeholder="写点想法…" rows="1">${escapeHtml(hl.note)}</textarea>
        <div class="row">
          <span>${hl.createdAt.slice(0, 10)}</span>
          ${share}
          <button data-del="1">删除</button>
        </div>
      </div>`;
  }

  /** 高亮所在页里、划线前后的原文：从文字层定位摘录（忽略空白差异），切出两侧 */
  async function contextOf(hl: Highlight): Promise<{ before: string; after: string }> {
    const none = { before: "", after: "" };
    const needle = (hl.text || "").replace(/\s+/g, "");
    if (!needle) return none;
    try {
      const page = await getPage(hl.page);
      const tc = await page.getTextContent();
      let full = "";
      for (const item of tc.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str === "string") full += item.str;
        if (item.hasEOL) full += "\n";
      }
      const map: number[] = [];
      let compact = "";
      for (let i = 0; i < full.length; i++) {
        if (!/\s/.test(full[i])) {
          map.push(i);
          compact += full[i];
        }
      }
      const idx = compact.indexOf(needle);
      if (idx < 0) return none;
      const start = map[idx];
      const end = map[idx + needle.length - 1] + 1;
      return { before: full.slice(0, start).slice(-400), after: full.slice(end).slice(0, 400) };
    } catch {
      return none;
    }
  }

  async function shareNote(hl: Highlight): Promise<void> {
    try {
      const [context, { openShareCard }] = await Promise.all([contextOf(hl), import("./share-card")]);
      await openShareCard({ text: hl.text || "", ...context, title: meta.title, author: meta.author });
    } catch (err) {
      console.error(err);
      toast("生成分享卡片失败", true);
    }
  }

  function markCurrentPage(): void {
    let target: HTMLElement | null = null;
    railScroll.querySelectorAll<HTMLElement>(".note-group").forEach((g) => {
      const active = Number(g.dataset.page) === currentPage;
      g.classList.toggle("current", active);
      if (active) target = g;
    });
    if (target) (target as HTMLElement).scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  async function saveNote(hl: Highlight, note: string): Promise<void> {
    try {
      const updated = await api.updateHighlight(bookId, hl.id, { note });
      hl.note = updated.note;
    } catch {
      toast("保存笔记失败", true);
    }
  }

  async function removeNote(hl: Highlight): Promise<void> {
    try {
      await api.deleteHighlight(bookId, hl.id);
      unpaint(hl);
      hls = hls.filter((h) => h.id !== hl.id);
      renderRail();
    } catch {
      toast("删除失败", true);
    }
  }

  $("#add-page-note").addEventListener("click", async () => {
    if (readerBody.classList.contains("rail-hidden")) {
      readerBody.classList.remove("rail-hidden");
      $("#toggle-rail").classList.add("active");
      onResize();
    }
    try {
      const hl = await api.addHighlight(bookId, { page: currentPage, rects: [], color: "amber" });
      hls.push(hl);
      renderRail();
      railScroll.querySelector<HTMLTextAreaElement>(`.note-card[data-id="${hl.id}"] textarea`)?.focus();
    } catch {
      toast("创建笔记失败", true);
    }
  });

  renderRail();

  // ---- selection → highlight ----
  let popup: HTMLElement | null = null;
  const hidePopup = () => {
    popup?.remove();
    popup = null;
  };

  type PopupCtx = { existing?: Highlight; pending?: { page: number; rects: Rect[]; text: string } };

  function showPopup(x: number, y: number, ctx: PopupCtx): void {
    hidePopup();
    popup = document.createElement("div");
    popup.className = "hl-popup";
    popup.innerHTML =
      Object.keys(HIGHLIGHT_COLORS)
        .map((c) => `<button class="dot" data-color="${c}" style="background:${HIGHLIGHT_COLORS[c]}"></button>`)
        .join("") + (ctx.existing ? `<button class="remove">擦除</button>` : "");
    document.body.appendChild(popup);
    popup.style.left = `${Math.min(Math.max(x, 110), window.innerWidth - 110)}px`;
    popup.style.top = `${Math.max(y - 52, 60)}px`;

    popup.querySelectorAll<HTMLElement>("[data-color]").forEach((dot) =>
      dot.addEventListener("click", async () => {
        const color = dot.dataset.color!;
        if (ctx.existing) {
          try {
            const updated = await api.updateHighlight(bookId, ctx.existing.id, { color });
            unpaint(ctx.existing);
            ctx.existing.color = updated.color;
            paint(ctx.existing);
            renderRail();
          } catch {
            toast("修改颜色失败", true);
          }
        } else if (ctx.pending) {
          await createHighlight(ctx.pending, color);
        }
        hidePopup();
      })
    );
    popup.querySelector(".remove")?.addEventListener("click", async () => {
      if (ctx.existing) await removeNote(ctx.existing);
      hidePopup();
    });
  }

  async function createHighlight(
    pending: { page: number; rects: Rect[]; text: string },
    color: string
  ): Promise<void> {
    try {
      const hl = await api.addHighlight(bookId, {
        page: pending.page,
        rects: pending.rects,
        text: pending.text,
        color,
      });
      hls.push(hl);
      paint(hl);
      renderRail();
      document.getSelection()?.removeAllRanges();
      railScroll.querySelector<HTMLTextAreaElement>(`.note-card[data-id="${hl.id}"] textarea`)?.focus();
    } catch (err) {
      console.error(err);
      toast("保存划线失败", true);
    }
  }

  /** Selection → the boxes it covers on its starting page, in 0–1 page units. */
  function selectionRects(range: Range, pageEl: HTMLElement): Rect[] {
    const box = pageEl.getBoundingClientRect();
    if (!box.width || !box.height) return [];
    const raw: Rect[] = [];
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue;
      if (r.bottom <= box.top || r.top >= box.bottom) continue; // spilled onto another page
      const top = Math.max(r.top, box.top);
      const bottom = Math.min(r.bottom, box.bottom);
      raw.push({
        x: (Math.max(r.left, box.left) - box.left) / box.width,
        y: (top - box.top) / box.height,
        w: (Math.min(r.right, box.right) - Math.max(r.left, box.left)) / box.width,
        h: (bottom - top) / box.height,
      });
    }
    // text layer spans overlap a lot; drop duplicates and fully covered boxes
    const out: Rect[] = [];
    for (const r of raw) {
      if (r.w <= 0.001 || r.h <= 0.001) continue;
      const covered = out.some(
        (o) => r.x >= o.x - 0.002 && r.y >= o.y - 0.004 && r.x + r.w <= o.x + o.w + 0.002 && r.y + r.h <= o.y + o.h + 0.004
      );
      if (covered) continue;
      for (let i = out.length - 1; i >= 0; i--) {
        const o = out[i];
        if (o.x >= r.x - 0.002 && o.y >= r.y - 0.004 && o.x + o.w <= r.x + r.w + 0.002 && o.y + o.h <= r.y + r.h + 0.004)
          out.splice(i, 1);
      }
      out.push(r);
    }
    return out;
  }

  const onMouseUp = (e: MouseEvent) => {
    if (popup?.contains(e.target as Node)) return;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const anchor = range.startContainer;
    const el = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
    const pageEl = el?.closest<HTMLElement>(".pdf-page");
    if (!pageEl || !scroller.contains(pageEl)) return;
    const rects = selectionRects(range, pageEl);
    if (!rects.length) return;
    const text = sel.toString().replace(/\s+/g, " ").trim();
    showPopup(e.clientX, e.clientY, { pending: { page: Number(pageEl.dataset.page), rects, text } });
  };
  scroller.addEventListener("mouseup", onMouseUp);
  disposers.push(() => scroller.removeEventListener("mouseup", onMouseUp));

  const onGlobalDown = (e: Event) => {
    if (popup && !popup.contains(e.target as Node)) hidePopup();
    if (!settings.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("#toggle-settings"))
      settings.classList.remove("open");
  };
  document.addEventListener("mousedown", onGlobalDown);
  disposers.push(() => document.removeEventListener("mousedown", onGlobalDown));

  return () => {
    if (destroyed) return;
    destroyed = true;
    noteSaveTimers.forEach((t) => clearTimeout(t));
    hidePopup();
    disposers.forEach((d) => d());
    slots.forEach(releaseSlot);
    doc.loadingTask.destroy().catch(() => {});
    document.title = "点·藏书 dot-lib";
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
