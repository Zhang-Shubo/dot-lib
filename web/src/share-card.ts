import { toast } from "./main";

// 9:16 摘录分享卡片：高亮文字居中醒目，前后文淡化衬底，
// 底部是「点·藏书」标识 + 书名作者 + 朱砂印。纯 canvas 绘制，无截图依赖。

export interface ShareCardInput {
  /** 高亮的正文摘录 */
  text: string;
  /** 摘录之前的上下文（可为空） */
  before: string;
  /** 摘录之后的上下文（可为空） */
  after: string;
  title: string;
  author: string;
}

const W = 1080;
const H = 1920;
const MARGIN = 96;
const CONTENT_W = W - MARGIN * 2;
const PAPER = "#f5efe0";
const INK = "#2a251d";
const INK_FADE = "rgba(42, 37, 29, 0.16)";
const VERMILION = "#a33b2e";
const SERIF = `"Noto Serif SC", "Songti SC", "STSong", "SimSun", serif`;
/** 行首不该出现的标点：溢出时挤进上一行 */
const CLOSERS = "，。、；：！？）】》〉」』”’…—";

/** 折行留白统一收敛：CJK 之间的空白全部去掉，其余压成单个空格 */
function clean(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(new RegExp(" ?([\\u2014\\u2018-\\u201d\\u2026\\u3000-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]) ?", "g"), "$1")
    .trim();
}

/** 逐字贪心折行；拉丁词回退到空格断开，行首闭合标点挤回上一行 */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    const test = line + ch;
    if (line && ctx.measureText(test).width > maxW) {
      if (CLOSERS.includes(ch)) {
        lines.push(test);
        line = "";
        continue;
      }
      const br = /^(.+[ ·])([A-Za-z0-9'’-]+)$/.exec(line);
      if (br && /[A-Za-z0-9'’-]/.test(ch)) {
        lines.push(br[1].trimEnd());
        line = br[2] + ch;
      } else {
        lines.push(line);
        line = ch === " " ? "" : ch;
      }
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawCard(input: ShareCardInput): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.className = "share-card-canvas";
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "top";

  const rule = H - 232; // 页脚上方的细线
  const contentTop = 150;
  const contentBottom = rule - 60;

  // ---- 主文字：从大到小试字号，都放不下则截断 ----
  const mainText = clean(input.text) || "（无摘录）";
  const maxMainH = (contentBottom - contentTop) * 0.62;
  let size = 58;
  let lineH = 0;
  let mainLines: string[] = [];
  for (const s of [58, 52, 46, 40, 36]) {
    size = s;
    lineH = Math.round(s * 1.78);
    ctx.font = `${s}px ${SERIF}`;
    mainLines = wrap(ctx, mainText, CONTENT_W);
    if (mainLines.length * lineH <= maxMainH) break;
  }
  const maxLines = Math.max(Math.floor(maxMainH / lineH), 3);
  if (mainLines.length > maxLines) {
    mainLines = mainLines.slice(0, maxLines);
    let last = mainLines[maxLines - 1];
    while (last && ctx.measureText(`${last}……`).width > CONTENT_W) last = last.slice(0, -1);
    mainLines[maxLines - 1] = `${last}……`;
  }

  const mainH = mainLines.length * lineH;
  const mainTop = contentTop + (contentBottom - contentTop - mainH) / 2;
  const gap = Math.round(lineH * 0.75);

  // ---- 淡化的前后文，同字号铺满上下，边缘由渐变化开 ----
  ctx.font = `${size}px ${SERIF}`;
  ctx.fillStyle = INK_FADE;
  const beforeLines = wrap(ctx, clean(input.before).slice(-400), CONTENT_W);
  let y = mainTop - gap - lineH;
  for (let i = beforeLines.length - 1; i >= 0 && y > -lineH; i--) {
    ctx.fillText(beforeLines[i], MARGIN, y);
    y -= lineH;
  }
  const afterLines = wrap(ctx, clean(input.after).slice(0, 400), CONTENT_W);
  y = mainTop + mainH + gap;
  for (const line of afterLines) {
    if (y > contentBottom + lineH) break;
    ctx.fillText(line, MARGIN, y);
    y += lineH;
  }

  ctx.fillStyle = INK;
  mainLines.forEach((line, i) => ctx.fillText(line, MARGIN, mainTop + i * lineH));

  // ---- 上下边缘的纸色渐隐 ----
  const top = ctx.createLinearGradient(0, 0, 0, 210);
  top.addColorStop(0, PAPER);
  top.addColorStop(1, "rgba(245, 239, 224, 0)");
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, 210);
  const bottom = ctx.createLinearGradient(0, rule - 170, 0, rule - 12);
  bottom.addColorStop(0, "rgba(245, 239, 224, 0)");
  bottom.addColorStop(1, PAPER);
  ctx.fillStyle = bottom;
  ctx.fillRect(0, rule - 170, W, 170 - 12);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, rule - 12, W, H - rule + 12);

  // ---- 页脚：标识 + 书名作者 + 朱砂印 ----
  ctx.strokeStyle = "rgba(42, 37, 29, 0.14)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(MARGIN, rule);
  ctx.lineTo(W - MARGIN, rule);
  ctx.stroke();

  const cy = H - 130;
  ctx.fillStyle = VERMILION;
  ctx.beginPath();
  ctx.arc(MARGIN + 44, cy, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f8f3e6";
  ctx.font = `600 46px ${SERIF}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("点", MARGIN + 44, cy + 3);

  const sealSize = 84;
  const sealX = W - MARGIN - sealSize;
  ctx.fillStyle = VERMILION;
  ctx.beginPath();
  ctx.roundRect(sealX, cy - sealSize / 2, sealSize, sealSize, 14);
  ctx.fill();
  ctx.fillStyle = "#f8f3e6";
  ctx.font = `600 48px ${SERIF}`;
  ctx.fillText("藏", sealX + sealSize / 2, cy + 3);

  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `600 38px ${SERIF}`;
  ctx.fillText("点·藏书", MARGIN + 116, cy - 24);
  ctx.fillStyle = "#948a75";
  ctx.font = `30px ${SERIF}`;
  let sub = `《${input.title}》${input.author ? ` ${input.author}` : ""}`;
  const subMax = sealX - 24 - (MARGIN + 116);
  while (sub.length > 3 && ctx.measureText(sub).width > subMax) sub = `${sub.slice(0, -2)}…`;
  ctx.fillText(sub, MARGIN + 116, cy + 26);

  return canvas;
}

/** 生成卡片并弹出预览，可保存 PNG 或复制到剪贴板 */
export async function openShareCard(input: ShareCardInput): Promise<void> {
  try {
    await document.fonts?.ready;
  } catch {
    /* 字体状态拿不到就直接画 */
  }
  const canvas = drawCard(input);

  const mask = document.createElement("div");
  mask.className = "share-mask";
  mask.innerHTML = `
    <div class="share-modal">
      <div class="share-preview"></div>
      <div class="share-actions">
        <button class="share-save">保存图片</button>
        <button class="share-copy">复制图片</button>
        <button class="share-close">关闭</button>
      </div>
    </div>`;
  mask.querySelector(".share-preview")!.appendChild(canvas);
  document.body.appendChild(mask);

  const close = () => mask.remove();
  mask.addEventListener("mousedown", (e) => {
    if (e.target === mask) close();
  });
  mask.querySelector(".share-close")!.addEventListener("click", close);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", onKey);
    }
  };
  document.addEventListener("keydown", onKey);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    toast("生成图片失败", true);
    return;
  }

  mask.querySelector(".share-save")!.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${input.title.replace(/[\\/:*?"<>|]/g, "_")}-摘录.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  });
  mask.querySelector(".share-copy")!.addEventListener("click", async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("已复制到剪贴板");
    } catch {
      toast("复制失败，请用「保存图片」", true);
    }
  });
}
