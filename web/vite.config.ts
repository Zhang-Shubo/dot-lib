import { createReadStream } from "node:fs";
import { cp, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// pdf.js fetches CMaps, standard fonts, wasm decoders and ICC profiles by URL
// at runtime. Rather than committing a copy of them under `public/`, serve them
// straight out of node_modules in dev and copy them into the build output.
function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const dirs = ["cmaps", "standard_fonts", "wasm", "iccs"];
  const TYPES: Record<string, string> = {
    ".wasm": "application/wasm",
    ".js": "text/javascript",
    ".icc": "application/vnd.iccprofile",
  };

  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const file = path.join(root, rel);
        if (!dirs.some((d) => file.startsWith(path.join(root, d) + path.sep))) return next();
        stat(file).then(
          (s) => {
            if (!s.isFile()) return next();
            res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
            createReadStream(file).pipe(res);
          },
          () => next()
        );
      });
    },
    async closeBundle() {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const out = path.resolve(here, "../dist/client/pdfjs");
      await Promise.all(
        dirs.map((d) => cp(path.join(root, d), path.join(out, d), { recursive: true }))
      );
    },
  };
}

export default defineConfig({
  plugins: [pdfjsAssets()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
