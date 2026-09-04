# dot-lib（点·藏书：自托管电子书阅读器）

> 写给 AI 助手 / 新接手者的工程说明。先读这份，再动代码。面向用户的说明见 [README.md](README.md)。本仓库是一个 [ai-space](https://github.com/Zhang-Shubo/ai-space) app，规范见其 `docs/app-spec.md`（spec 1）。

## 铁律

1. **诚实**：取不到就留空 / 报错如实返回，绝不编造。`/api/widget` 失败时返回 `{ok:false, error}`，面板照实显示。
2. **可溯源**：每本书的 `meta.json` 记 `addedAt`、`sourceFormat`；进度记 `updatedAt`。
3. **只增不改**：划线列表只追加、改色、删除；历史 `meta.json` 字段只加不删（老书没有 `format` 字段，读时归一化为 epub）。
4. **配置只走环境变量**：真实凭证只在 `.env`（gitignore）或 ai-space 生成的 `space.env`；仓库只有 `.env.example`。
5. **只监听 127.0.0.1**：对外由隧道 / 反代负责；Docker 镜像是唯一 `HOST=0.0.0.0` 的地方。

## 技术栈与运行模型

- 后端：Node 22 + Hono + `@aws-sdk/client-s3`，`tsx` 直接跑 TS，无构建步骤。
- 前端：Vite + 原生 TS + epub.js + pdf.js + vendor 的 mobi.js；构建产物 `dist/client/` **提交进仓库**，服务器不跑 vite。
- 存储：只有对象存储（Cloudflare R2 或任意 S3 兼容），无数据库。key 布局 `books/<id>/{meta.json, book.epub|book.pdf, cover, highlights.json, progress.json}`。
- 运行：服务器上用户级 systemd 单元 `dot-lib`，工作目录 `~/.ai-space/apps/dot-lib`，`127.0.0.1:8787`。

## 目录结构

```
space.yaml            ★ ai-space 清单：service / widgets / storage.blobs
server/
├── index.ts          ★ 全部路由：/healthz、/api/books*、/api/widget、静态文件、优雅退出
├── r2.ts             ★ 对象存储客户端：BLOB_URL + S3_* 优先，R2_* 兜底；前缀在这层加减
└── types.ts          BookMeta / Highlight / Progress
web/
├── index.html
├── src/
│   ├── main.ts       前端入口（hash 路由：书架 / 阅读器）
│   ├── library.ts    书架、上传（含分片上传、MOBI 转 EPUB）
│   ├── reader.ts     EPUB 阅读器、划线、进度
│   ├── pdf-reader.ts PDF 阅读器
│   ├── mobi-to-epub.ts
│   ├── share-card.ts 摘录分享卡片（canvas）
│   ├── themes.ts / style.css
│   └── vendor/mobi.js  逐字 vendor 自 foliate-js（MIT）
├── public/favicon.svg  app 图标（space.yaml 的 icon）
└── vite.config.ts    pdfjs-assets 插件：cmaps / 字体 / wasm
dist/client/          前端构建产物（提交）
deploy/dot-lib.service  用户级 systemd 单元模板（@DIR@ 由 deploy.sh 替换）
deploy.sh             构建 → rsync → 装 unit → 重启 → /healthz
Dockerfile, docker-compose.yml  备选方案，当前未用
```

## 核心约定

- 服务端所有 key 相对于 store 根（`books/<id>/...`），`BLOB_URL` 的前缀只在 `r2.ts` 里加减，其他代码不知道前缀存在。
- 分片上传是无状态的：`uploadId` 和 part 列表由客户端保存并随请求带回。
- 面板小组件契约（ai-space app-spec，`widgets[].kind: items`）：`GET /api/widget` → `{ok:true, items:[{text,url,time}]}`，取最近有阅读动静的 3 本，口径与书架一致（读完 / 读至 N% / 未读）。`url` 用 `PUBLIC_BASE` 拼绝对地址。
- `/healthz` 只回答进程活着，不碰对象存储；桶是否正常看 `/api/books`。
- 收到 SIGTERM 后停止接新连接、等在途请求、最多 8 秒退出。
- 缓存策略：`/assets/*` 永久缓存（带 hash），`/pdfjs/*` 一天，其余 `no-cache`。

## 常用命令

```bash
npm install
set -a && . ./.env && set +a && npm run dev   # tsx 不读 .env；后端 :8787，前端 :5173
eval "$(bun <ai-space>/src/index.ts env dot-lib)" && npm run dev   # 用 ai-space 供给的存储变量
npm run typecheck
npm run build                                  # vite build → dist/client，提交产物
DEPLOY_HOST=<host> ./deploy.sh
```

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `PORT` | 否 | 默认 8787；ai-space 按 `space.yaml` 的 `service.port` 传入 |
| `HOST` | 否 | 默认 `127.0.0.1`；只有 Docker 镜像设 `0.0.0.0` |
| `PUBLIC_BASE` | 否 | 本应用公网地址，小组件链接用 |
| `BLOB_URL` + `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 二选一 | ai-space 写进 `~/.ai-space/data/dot-lib/space.env`，unit 加载 |
| `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` + `R2_ENDPOINT` 或 `R2_ACCOUNT_ID` | 二选一 | 脱离 ai-space 时的独立配置 |

真实值在部署机 `.env` 与 `space.env`，仓库只有 `.env.example`。

## 部署与运维

- 部署：`DEPLOY_HOST=<host> ./deploy.sh`，默认目录 `~/.ai-space/apps/dot-lib`，unit 每次重装，免 sudo。
- 重启：`systemctl --user restart dot-lib`
- 日志：`journalctl --user -u dot-lib -f`
- 健康检查：`curl -s 127.0.0.1:8787/healthz`
- 存储交接：ai-space 同步时按 `space.yaml` 的 `storage.blobs` 写 `space.env`；桶名来自 ai-space 的 `SPACE_S3_BUCKET`，`prefix: ""` 是为了沿用桶里已有的 `books/...` 布局。

## 已知坑

- **老部署是系统级 unit**（`/etc/systemd/system/dot-lib.service`，目录 `~/.awesome-agent/projects/dot-lib`，需要 sudo）。迁到用户级 unit 的步骤在 README「部署到服务器」；两套同时启用会抢 8787 端口。
- `tsx` 不自动读 `.env`，本地开发要先把变量 source 进 shell。
- `dist/client/` 是提交的，改了前端记得 `npm run build` 再提交，否则服务器拿到的是旧页面。
- `BLOB_URL` 的 `prefix` 一旦非空，桶里已有的 `books/...` 对象就看不见了；这个 app 必须保持 `prefix: ""`。
- 多台机器共用同一个 R2 桶时（本桶与另一项目共享），删除操作只删 `books/<id>/` 前缀下的 key，不要动其他前缀。
- Cloudflare 免费版单请求上传上限 100MB，所以大文件走分片上传（8MB 一片）。
