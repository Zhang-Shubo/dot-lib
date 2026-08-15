import "./style.css";
import { renderLibrary } from "./library";
import { renderReader } from "./reader";

const app = document.getElementById("app")!;

let teardown: (() => void) | null = null;

async function route(): Promise<void> {
  if (teardown) {
    teardown();
    teardown = null;
  }
  app.innerHTML = "";
  const hash = location.hash;
  const readMatch = hash.match(/^#\/read\/([\w-]+)/);
  if (readMatch) {
    teardown = await renderReader(app, readMatch[1]);
  } else {
    teardown = await renderLibrary(app);
  }
}

window.addEventListener("hashchange", route);
route();

export function toast(message: string, isError = false): void {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = `toast${isError ? " error" : ""}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
