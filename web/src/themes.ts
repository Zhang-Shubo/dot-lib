// Page backgrounds live on `.reader.theme-*` in style.css and are shared by
// both readers; the epub reader additionally injects matching text colors into
// the book iframe (see themeRules in reader.ts).
export type Theme = { label: string; title: string; color: string; dark?: boolean; link?: string };

export const THEMES: Record<string, Theme> = {
  paper: { label: "纸白", title: "纸白", color: "#2a251d" },
  sepia: { label: "羊皮", title: "羊皮纸", color: "#3a3226" },
  green: { label: "护眼", title: "护眼绿", color: "#26332a" },
  dark: { label: "夜读", title: "夜读暖褐", color: "#d8d0bf", dark: true, link: "#c9a06a" },
  slate: { label: "深灰", title: "夜间深灰", color: "#c6c6c6", dark: true, link: "#d0796b" },
};

export const DEFAULT_THEME = "paper";

export const themeChipsHtml = (): string =>
  Object.entries(THEMES)
    .map(([k, t]) => `<button class="chip" data-theme="${k}" title="${t.title}">${t.label}</button>`)
    .join("");

export const readTheme = (): string => {
  const saved = localStorage.getItem("dotlib.theme") ?? "";
  return saved in THEMES ? saved : DEFAULT_THEME;
};
