import ePub, { EpubCFI } from "epubjs";
import type { Contents, Rendition } from "epubjs";
import type { NavItem } from "epubjs/types/navigation";
import { api } from "./api";
import { toast } from "./main";
import { THEMES, readTheme, themeChipsHtml, type Theme } from "./themes";
import { HIGHLIGHT_COLORS, type BookMeta, type Highlight } from "./types";

/** Pick the reader that matches the book's format. */
export async function renderReader(root: HTMLElement, bookId: string): Promise<() => void> {
  let meta: BookMeta;
  try {
    meta = await api.getBook(bookId);
  } catch (err) {
    toast(`打不开这本书：${err}`, true);
    location.hash = "#/";
    throw err;
  }
  if (meta.format === "pdf") {
    const { renderPdfReader } = await import("./pdf-reader");
    return renderPdfReader(root, meta);
  }
  return renderEpubReader(root, meta);
}

// The epub body stays transparent so the chrome and the text share one surface.
// Scope every rule to `body.<name>` — the class epub.js toggles on switch.
// A bare `body` selector does NOT work: themes.select() injects the new theme's
// stylesheet but never removes the previous one, and _getStylesheetNode() reuses
// the node created on a theme's *first* selection, so head order is frozen at
// first-use order. With equal specificity the last node wins, which means
// switching back to an earlier theme leaves the other theme's color in force
// (paper text rendering in dark's #d8d0bf). Scoping makes stale sheets inert.
function themeRules(name: string, t: Theme): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {
    [`body.${name}`]: { color: t.color, background: "transparent" },
  };
  if (t.dark) {
    // calibre-converted books hardcode `color: rgb(0,0,0)` on headings and bold
    // runs; on a dark page those go invisible. Body text usually sets no color
    // and inherits fine, so only the dark themes need this flattening.
    rules[`body.${name} *:not(a):not(a *)`] = { color: `${t.color} !important` };
    rules[`body.${name} a, body.${name} a *`] = { color: `${t.link} !important` };
  }
  return rules;
}
const FONT_SIZES: Record<string, string> = { s: "92%", m: "108%", l: "128%" };

async function renderEpubReader(root: HTMLElement, meta: BookMeta): Promise<() => void> {
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
          <div id="viewer"></div>
        </div>
        <div class="rail-mask" id="rail-mask"></div>
        <aside class="note-rail" id="note-rail">
          <div class="rail-resizer" id="rail-resizer" title="拖动调整宽度"></div>
          <div class="rail-head">
            <h3>笔 记</h3>
            <button id="add-chapter-note" title="给当前章节添加一页笔记">＋ 记一页</button>
          </div>
          <div class="rail-scroll" id="rail-scroll"></div>
        </aside>
        <aside class="drawer" id="toc-drawer"><h3>目 录</h3><div class="scroll" id="toc-list"></div></aside>
        <div class="settings" id="settings">
          <div class="group">
            <label>字号</label>
            <div class="row" id="font-row">
              <button class="chip" data-size="s">小</button>
              <button class="chip" data-size="m">中</button>
              <button class="chip" data-size="l">大</button>
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
        <span id="chapter"></span>
      </div>
    </div>
  `;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const readerRoot = $("#reader-root");
  const readerBody = $("#reader-body");
  const railScroll = $("#rail-scroll");
  const disposers: Array<() => void> = [];
  let destroyed = false;

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

  $("#book-title").textContent = meta.title;
  document.title = `${meta.title} — 点·藏书`;

  const book = ePub(fileBuf);
  await book.opened;

  // Some epubs (calibre/sigil output) name spine documents without a file
  // extension; epub.js's archive loader then returns raw text instead of a
  // parsed document and every page renders blank. Force the parse type from
  // the manifest's declared media-type when the path has no extension.
  {
    const archive = (book as unknown as { archive?: { request: (url: string, type?: string) => Promise<unknown> } }).archive;
    const manifest = (book as unknown as { packaging?: { manifest?: Record<string, { href: string; type: string }> } })
      .packaging?.manifest;
    if (archive && manifest) {
      const items = Object.values(manifest);
      const orig = archive.request.bind(archive);
      archive.request = (url: string, type?: string) => {
        const path = url.split("?")[0].split("#")[0];
        if (!type && !/\.[a-z0-9]+$/i.test(path)) {
          const media = items.find((m) => path.endsWith(m.href.split("#")[0]))?.type ?? "";
          if (media.includes("xhtml")) type = "xhtml";
          else if (media.includes("html")) type = "html";
        }
        return orig(url, type);
      };
    }
  }

  // continuous vertical scroll — no pagination.
  // offset: huge look-ahead so every section renders once and stays mounted;
  // epub.js's lazy prepend/unload is buggy when scrolling backwards (blank
  // spacer views + wrong scroll compensation), rendering everything avoids it.
  const rendition: Rendition = book.renderTo($("#viewer"), {
    width: "100%",
    height: "100%",
    flow: "scrolled",
    manager: "continuous",
    offset: 10_000_000,
    allowScriptedContent: false,
  } as Parameters<typeof book.renderTo>[1]);

  for (const [name, t] of Object.entries(THEMES)) rendition.themes.register(name, themeRules(name, t));

  const prefs = {
    size: localStorage.getItem("dotlib.fontsize") ?? "m",
    theme: readTheme(),
  };
  const applyPrefs = () => {
    rendition.themes.select(prefs.theme);
    rendition.themes.fontSize(FONT_SIZES[prefs.size] ?? FONT_SIZES.m);
    readerRoot.classList.remove(...Object.keys(THEMES).map((t) => `theme-${t}`));
    readerRoot.classList.add(`theme-${prefs.theme}`);
    root
      .querySelectorAll<HTMLElement>("#font-row .chip")
      .forEach((c) => c.classList.toggle("active", c.dataset.size === prefs.size));
    root
      .querySelectorAll<HTMLElement>("#theme-row .chip")
      .forEach((c) => c.classList.toggle("active", c.dataset.theme === prefs.theme));
  };
  applyPrefs();

  // display() resolves only after every section is filled in; drop the
  // loading veil as soon as the first view is on screen instead.
  const displayed = rendition.display(progress.cfi || undefined);
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    rendition.on("rendered", finish);
    displayed.then(finish, finish);
  });
  $("#loading")?.remove();

  book.ready.then(() => book.locations.generate(1600)).catch(() => {});

  // ---- spine / toc maps ----
  const spineIndexOf = (href: string): number => {
    const clean = href.split("#")[0];
    const item = (book as unknown as { spine: { get: (h: string) => { index: number } | null } }).spine.get(clean);
    return item ? item.index : 9999;
  };
  const cfiSpinePos = (cfi: string): number => {
    try {
      return (new EpubCFI(cfi) as unknown as { spinePos: number }).spinePos ?? 9999;
    } catch {
      return 9999;
    }
  };

  let tocFlat: Array<{ href: string; label: string }> = [];
  book.loaded.navigation.then((nav) => {
    const flat: Array<{ href: string; label: string }> = [];
    const walk = (items: NavItem[]) =>
      items.forEach((it) => {
        flat.push({ href: it.href.split("#")[0], label: it.label.trim() });
        walk(it.subitems ?? []);
      });
    walk(nav.toc);
    tocFlat = flat;
    renderRail();
  });
  // A spine file often has no TOC entry of its own — it's the tail of the
  // chapter that started earlier, or a prologue before the first entry. Naming
  // it after the last chapter that did start beats showing a file name.
  const chapterLabel = (href: string): string => {
    const clean = href.split("#")[0];
    const exact = tocFlat.find((t) => t.href === clean);
    if (exact) return exact.label;
    const here = spineIndexOf(clean);
    let best: { index: number; label: string } | null = null;
    for (const entry of tocFlat) {
      const index = spineIndexOf(entry.href);
      if (index <= here && (!best || index > best.index)) best = { index, label: entry.label };
    }
    return best?.label ?? "";
  };

  // ---- toc drawer / settings ----
  const tocDrawer = $("#toc-drawer");
  const settings = $("#settings");
  $("#toggle-toc").addEventListener("click", () => {
    settings.classList.remove("open");
    tocDrawer.classList.toggle("open");
  });
  $("#toggle-rail").addEventListener("click", () => {
    readerBody.classList.toggle("rail-hidden");
    $("#toggle-rail").classList.toggle("active", !readerBody.classList.contains("rail-hidden"));
  });

  // 手机(≤900px):笔记栏是盖在正文上的右侧抽屉,进入先收起免得挡住正文;点遮罩空白收回
  const closeRail = () => {
    readerBody.classList.add("rail-hidden");
    $("#toggle-rail").classList.remove("active");
  };
  if (window.matchMedia("(max-width: 900px)").matches) closeRail();
  $("#rail-mask").addEventListener("click", closeRail);

  // draggable divider between text and notes
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
        // let epub.js reflow to the new text width
        window.dispatchEvent(new Event("resize"));
      };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
    });
  }
  $("#toggle-settings").addEventListener("click", () => settings.classList.toggle("open"));

  book.loaded.navigation.then((nav) => {
    const list = $("#toc-list");
    const walk = (items: NavItem[], depth: number): string =>
      items
        .map(
          (it) =>
            `<button class="toc-item depth-${Math.min(depth, 2)}" data-href="${it.href}">${it.label.trim()}</button>` +
            walk(it.subitems ?? [], depth + 1)
        )
        .join("");
    list.innerHTML = walk(nav.toc, 0) || `<div class="none">此书没有目录</div>`;
    list.querySelectorAll<HTMLElement>("[data-href]").forEach((el) =>
      el.addEventListener("click", () => {
        rendition.display(el.dataset.href!);
        tocDrawer.classList.remove("open");
      })
    );
  });

  $("#font-row").addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-size]");
    if (!chip) return;
    prefs.size = chip.dataset.size!;
    localStorage.setItem("dotlib.fontsize", prefs.size);
    applyPrefs();
  });
  $("#theme-row").addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-theme]");
    if (!chip) return;
    prefs.theme = chip.dataset.theme!;
    localStorage.setItem("dotlib.theme", prefs.theme);
    applyPrefs();
  });

  // ---- progress / current chapter ----
  let currentHref = "";
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  rendition.on("relocated", (loc: { start: { cfi: string; percentage: number; href: string } }) => {
    const pct = Math.round((loc.start.percentage || 0) * 100);
    $("#pct").textContent = `${pct}%`;
    $("#pct-bar").style.width = `${pct}%`;
    $("#chapter").textContent = chapterLabel(loc.start.href);
    if (loc.start.href !== currentHref) {
      currentHref = loc.start.href;
      markCurrentChapter();
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api
        .saveProgress(bookId, { cfi: loc.start.cfi, percentage: loc.start.percentage || 0 })
        .catch(() => {});
    }, 800);
  });

  // keyboard scrolling of the text pane
  const scrollContainer = (): HTMLElement | null => root.querySelector(".epub-container");
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
    const c = scrollContainer();
    if (!c) return;
    if (e.key === "ArrowDown") c.scrollBy({ top: 120, behavior: "smooth" });
    if (e.key === "ArrowUp") c.scrollBy({ top: -120, behavior: "smooth" });
    if (e.key === "PageDown" || e.key === " ") c.scrollBy({ top: c.clientHeight * 0.9, behavior: "smooth" });
    if (e.key === "PageUp") c.scrollBy({ top: -c.clientHeight * 0.9, behavior: "smooth" });
  };
  document.addEventListener("keydown", onKey);
  disposers.push(() => document.removeEventListener("keydown", onKey));

  // ---- notes ----
  let hls: Highlight[] = highlights;
  const colorOf = (name: string) => HIGHLIGHT_COLORS[name] ?? HIGHLIGHT_COLORS.amber;
  const noteSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const paint = (hl: Highlight) => {
    if (!hl.cfiRange) return;
    rendition.annotations.highlight(
      hl.cfiRange,
      { id: hl.id },
      (e: MouseEvent) => showPopup(e.clientX, e.clientY, { existing: hl }),
      "dotlib-hl",
      { fill: colorOf(hl.color), "fill-opacity": "1", "mix-blend-mode": "multiply" }
    );
  };
  const unpaint = (hl: Highlight) => {
    if (hl.cfiRange) rendition.annotations.remove(hl.cfiRange, "highlight");
  };
  hls.forEach(paint);

  const chapterOf = (hl: Highlight): string =>
    hl.chapter || (hl.cfiRange ? spineHref(cfiSpinePos(hl.cfiRange)) : "");
  const spineHref = (pos: number): string => {
    const spine = (book as unknown as { spine: { items: Array<{ href: string; index: number }> } }).spine;
    return spine.items.find((s) => s.index === pos)?.href ?? "";
  };

  function renderRail(): void {
    // group notes by chapter, ordered by spine position
    const groups = new Map<string, Highlight[]>();
    for (const hl of hls) {
      const ch = chapterOf(hl);
      if (!groups.has(ch)) groups.set(ch, []);
      groups.get(ch)!.push(hl);
    }
    const ordered = [...groups.entries()].sort((a, b) => spineIndexOf(a[0]) - spineIndexOf(b[0]));
    const cmp = new EpubCFI();
    for (const [, list] of ordered) {
      list.sort((a, b) => {
        if (a.cfiRange && b.cfiRange) {
          try {
            return (cmp as unknown as { compare: (x: string, y: string) => number }).compare(a.cfiRange, b.cfiRange);
          } catch {
            /* fall through */
          }
        }
        if (!a.cfiRange && b.cfiRange) return 1;
        if (a.cfiRange && !b.cfiRange) return -1;
        return a.createdAt.localeCompare(b.createdAt);
      });
    }

    if (!ordered.length) {
      railScroll.innerHTML = `<div class="none">选中正文文字划线，<br/>或点上方「＋ 记一页」<br/>给本章添加笔记。</div>`;
      return;
    }

    railScroll.innerHTML = ordered
      .map(
        ([ch, list]) => `
        <section class="note-group" data-chapter="${escapeHtml(ch)}">
          <header class="group-head">${escapeHtml(chapterLabel(ch) || "未归类")}<i>${list.length}</i></header>
          ${list.map(cardHtml).join("")}
        </section>`
      )
      .join("");

    railScroll.querySelectorAll<HTMLElement>(".note-card").forEach((card) => {
      const hl = hls.find((h) => h.id === card.dataset.id);
      if (!hl) return;
      card.querySelector<HTMLElement>(".excerpt")?.addEventListener("click", () => {
        if (hl.cfiRange) rendition.display(hl.cfiRange);
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
    markCurrentChapter();
  }

  /** 高亮所在章节里、划线前后的原文，用来做分享卡片的淡化衬底 */
  async function contextOf(hl: Highlight): Promise<{ before: string; after: string }> {
    const none = { before: "", after: "" };
    if (!hl.cfiRange) return none;
    try {
      const range = await book.getRange(hl.cfiRange);
      const body = range?.startContainer.ownerDocument?.body;
      if (!range || !body) return none;
      const doc = body.ownerDocument!;
      const b = doc.createRange();
      b.selectNodeContents(body);
      b.setEnd(range.startContainer, range.startOffset);
      const a = doc.createRange();
      a.selectNodeContents(body);
      a.setStart(range.endContainer, range.endOffset);
      return { before: b.toString().slice(-400), after: a.toString().slice(0, 400) };
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

  function cardHtml(hl: Highlight): string {
    const excerpt = hl.cfiRange
      ? `<div class="excerpt" style="border-color:${colorOf(hl.color)}" title="跳到原文">${escapeHtml(hl.text || "（无摘录）")}</div>`
      : `<div class="page-mark">✎ 本章笔记</div>`;
    const share = hl.cfiRange && hl.text ? `<button data-share="1">分享</button>` : "";
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

  function markCurrentChapter(): void {
    const cur = currentHref.split("#")[0];
    let target: HTMLElement | null = null;
    railScroll.querySelectorAll<HTMLElement>(".note-group").forEach((g) => {
      const active = g.dataset.chapter?.split("#")[0] === cur;
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

  $("#add-chapter-note").addEventListener("click", async () => {
    if (readerBody.classList.contains("rail-hidden")) {
      readerBody.classList.remove("rail-hidden");
      $("#toggle-rail").classList.add("active");
    }
    try {
      const hl = await api.addHighlight(bookId, { chapter: currentHref.split("#")[0], color: "amber" });
      hls.push(hl);
      renderRail();
      const ta = railScroll.querySelector<HTMLTextAreaElement>(`.note-card[data-id="${hl.id}"] textarea`);
      ta?.focus();
    } catch {
      toast("创建笔记失败", true);
    }
  });

  // ---- selection popup ----
  let popup: HTMLElement | null = null;
  const hidePopup = () => {
    popup?.remove();
    popup = null;
  };

  type PopupCtx = { existing?: Highlight; cfiRange?: string; contents?: Contents };

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
        } else if (ctx.cfiRange) {
          await createHighlight(ctx.cfiRange, color, ctx.contents);
        }
        hidePopup();
      })
    );
    popup.querySelector(".remove")?.addEventListener("click", async () => {
      if (ctx.existing) await removeNote(ctx.existing);
      hidePopup();
    });
  }

  async function createHighlight(cfiRange: string, color: string, contents?: Contents): Promise<void> {
    try {
      const range = await book.getRange(cfiRange);
      const text = range?.toString().trim() ?? "";
      const chapter = spineHref(cfiSpinePos(cfiRange));
      const hl = await api.addHighlight(bookId, { cfiRange, chapter, text, color });
      hls.push(hl);
      paint(hl);
      renderRail();
      contents?.window.getSelection()?.removeAllRanges();
      const ta = railScroll.querySelector<HTMLTextAreaElement>(`.note-card[data-id="${hl.id}"] textarea`);
      ta?.focus();
    } catch (err) {
      console.error(err);
      toast("保存划线失败", true);
    }
  }

  rendition.on("selected", (cfiRange: string, contents: Contents) => {
    const sel = contents.window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const iframe = contents.window.frameElement as HTMLIFrameElement | null;
    const base = iframe?.getBoundingClientRect() ?? { left: 0, top: 0 };
    showPopup(base.left + rect.left + rect.width / 2, base.top + rect.top, { cfiRange, contents });
  });

  const onGlobalDown = (e: Event) => {
    if (popup && !popup.contains(e.target as Node)) hidePopup();
    if (!settings.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("#toggle-settings"))
      settings.classList.remove("open");
  };
  document.addEventListener("mousedown", onGlobalDown);
  rendition.hooks.content.register((contents: Contents) => {
    contents.document.addEventListener("mousedown", () => hidePopup());
  });
  disposers.push(() => document.removeEventListener("mousedown", onGlobalDown));

  return () => {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(saveTimer);
    noteSaveTimers.forEach((t) => clearTimeout(t));
    hidePopup();
    disposers.forEach((d) => d());
    try {
      book.destroy();
    } catch {
      /* ignore */
    }
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
