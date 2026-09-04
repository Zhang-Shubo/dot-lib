# 点·藏书 dot-lib

自托管电子书阅读器。TypeScript 全栈，图书文件、封面、划线笔记、阅读进度全部存储在对象存储（Cloudflare R2 或任意 S3 兼容服务），服务器本身无状态，无需数据库。桶和凭证由 [ai-space](https://github.com/Zhang-Shubo/ai-space) 的存储组件按 `space.yaml` 的声明供给，也可以脱离 ai-space 用 `R2_*` 变量单独跑。

## 功能

- 上传 EPUB / PDF / MOBI（按钮或拖拽到页面），自动解析书名 / 作者 / 封面（PDF 取信息字典 + 首页缩略图）
- Kindle 格式（.mobi / .azw / .azw3 / .prc）在浏览器里转成 EPUB 后入库，书架角标显示原始格式
- 书架视图：封面墙 + 阅读进度条 + 格式角标
- EPUB 阅读器：连续滚动、目录跳转、字号调节、纸白 / 羊皮 / 护眼 / 夜读 / 深灰五种底色
- PDF 阅读器：连续滚动分页、大纲目录、页码跳转、缩放三档、同一套底色（深色底自动反相，浅色底叠印上色）
- 划线：两种格式都可选中文字高亮，四种颜色，可改色、可擦除、可写笔记并点击跳回原文
- 摘录分享：笔记里的每条划线可生成 9:16 分享卡片（高亮文字醒目、前后原文淡化衬底、书名作者落款），可存 PNG 或复制到剪贴板；纯 canvas 绘制，无截图依赖
- 阅读进度自动保存（EPUB 记 CFI，PDF 记页码），换设备继续读
- 超过 8MB 的书按 8MB 分片走 R2 multipart 上传，带百分比进度：一次性长请求会撞上 Cloudflare 100 秒源站超时，也会把整个文件顶进服务器内存

## 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Node 22 + Hono + @aws-sdk/client-s3（R2 S3 兼容 API） |
| 前端 | Vite + 原生 TypeScript + epub.js + pdf.js + mobi.js（vendor 自 foliate-js） |
| 存储 | S3 兼容对象存储（Cloudflare R2）：`books/{id}/book.epub`（或 `book.pdf`）+ `meta.json` + `cover` + `highlights.json` + `progress.json`；桶、前缀、凭证来自 ai-space 写的 `space.env`（`BLOB_URL` + `S3_*`），或独立部署时的 `R2_*` |
| 部署 | Docker + docker compose + `deploy.sh`（rsync 到服务器） |

pdf.js 运行时需要的 CMap（中日韩预定义编码）、标准字体、wasm 解码器由 `web/vite.config.ts` 里的 `pdfjs-assets` 插件提供：开发时直接从 node_modules 走中间件，构建时复制到 `dist/client/pdfjs/`。

### MOBI 为什么转成 EPUB

Kindle 格式没有单独的阅读器，导入时在浏览器里转换成 EPUB 再上传（`web/src/mobi-to-epub.ts`）：阅读器、CFI 定位的划线、阅读进度整套已经是围绕 EPUB 建的，转换后全部原样复用；万一哪天解析器不再维护，已入库的书也不受影响。转换会把正文按目录锚点切成一节一章，否则一本 26 章的书可能只有 4 个 spine 文件，页脚章节名和笔记分组会全部落到第一章上。

服务器只保存转换后的 EPUB，`meta.json` 里用 `sourceFormat` 记住原始格式（书架角标据此显示 MOBI / AZW3）。原始文件不上传，仍在你自己的磁盘上。

解析器 `web/src/vendor/mobi.js` 逐字 vendor 自 [foliate-js](https://github.com/johnfactotum/foliate-js)（MIT，零依赖单文件）——npm 上那个 `foliate-js` 包是第三方账号转发布的，没有走。

## 存储：接入 ai-space

`space.yaml` 向 ai-space 声明一个 S3 后端的 blob store（`prefix: ""`，沿用桶里已有的 `books/...` 布局，桶名取 ai-space 的 `SPACE_S3_BUCKET`）。ai-space 同步时用工作区 `.env` 里的 `SPACE_S3_*` 凭证探一次桶，然后把下面这些写进 `~/.ai-space/data/dot-lib/space.env`（mode 600）：

```
BLOB_URL=s3://<bucket>/
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=<bucket>
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

`server/r2.ts` 优先读 `BLOB_URL` + `S3_*`（`BLOB_URL` 里的前缀会自动加到每个 key 前面），没有时退回 `R2_*`。所以：

- 服务器上：systemd unit 多一行 `EnvironmentFile=-~/.ai-space/data/dot-lib/space.env`，本机 `.env` 只需要 `PORT`。让 ai-space 认领这个 app：把部署目录加进 ai-space 的 `SPACE_APPS`，或者直接部署到 `~/.ai-space/apps/dot-lib`。
- 本地开发：`eval "$(bun <ai-space>/src/index.ts env dot-lib)"` 把变量导入当前 shell，再 `npm run dev`。
- 脱离 ai-space：照旧在 `.env` 里填 `R2_*`（见 `.env.example`）。

## 本地开发

```bash
cp .env.example .env   # 填入 R2 凭证（或者用上面的 ai-space env 命令）
npm install
npm run dev            # 后端 :8787，前端 :5173（代理 /api）
```

`tsx` 不会自动读 `.env`，`npm run dev` 需要环境变量已经在 shell 里，例如 `set -a && . ./.env && set +a && npm run dev`，或 `node --env-file=.env`。服务器上由 systemd 的 `EnvironmentFile=` 注入，不受影响。

R2 凭证获取：Cloudflare 控制台 → R2 → 创建存储桶 → Manage R2 API Tokens → 创建具有该桶读写权限的 Token，得到 Access Key ID / Secret；Account ID 在 R2 概览页右侧。

没有 R2 时也可以设 `R2_ENDPOINT`（或 ai-space 的 `SPACE_S3_ENDPOINT`）指向任意 S3 兼容存储（如 MinIO）进行本地开发。

## 部署到服务器

服务器需要 Node 22+，以及 systemctl 的免密 sudo。前端在本地构建后连同 `dist/` 一起同步过去——epub.js 和 pdf.js 都是 devDependency，构建产物里已经打包完毕，服务器不跑 vite，只装运行时依赖，1～2GB 内存的小机器也扛得住。

```bash
DEPLOY_HOST=ubuntu@your-server ./deploy.sh
# 可选：DEPLOY_PATH=dot-lib（默认，相对远端 home）、SERVICE=dot-lib（systemd 服务名）
```

脚本做的事：本地 `npm run build` → rsync（排除 `node_modules` / `.env` / `.git`）→ 首次部署把本地 `.env` 播种上去（已存在则保留）→ 远端 `npm install --omit=dev` → 首次部署从 `deploy/dot-lib.service` 安装并 enable systemd unit → 重启服务 → 健康检查 `/api/books`。

unit 只在首次部署安装；`deploy/dot-lib.service` 改过之后（比如加了 ai-space 的 `EnvironmentFile`），要手动重装：把文件里的 `@USER@` / `@DIR@` / `@HOME@` 替换后 `sudo tee /etc/systemd/system/dot-lib.service`，再 `sudo systemctl daemon-reload && sudo systemctl restart dot-lib`。

服务默认只监听 `127.0.0.1:8787`（unit 里的 `HOST=127.0.0.1`），公网访问需要自己在前面加一层：Cloudflare Tunnel、Nginx/Caddy 均可，顺便解决 HTTPS 与登录（本应用自身不带鉴权）。

仓库里的 `Dockerfile` / `docker-compose.yml` 是另一套可选方案，当前部署没有使用。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/books` | 图书列表 |
| GET | `/api/books/:id` | 单本图书信息 |
| POST | `/api/books` | 小文件一次性上传（multipart：file, title, author, cover, format） |
| POST | `/api/books/upload/start` | 开始分片上传，返回 `id` / `uploadId` / `partSize` |
| PUT | `/api/books/upload/:id/part` | 上传一片（query：uploadId, part, format；body 为裸字节） |
| POST | `/api/books/upload/:id/finish` | 合并分片并写入 meta / 封面 |
| POST | `/api/books/upload/:id/abort` | 放弃分片上传 |
| GET | `/api/books/:id/file` | 图书文件（EPUB 或 PDF） |
| GET | `/api/books/:id/cover` | 封面 |
| DELETE | `/api/books/:id` | 删除图书及其所有数据 |
| GET/POST | `/api/books/:id/highlights` | 划线列表 / 新增（EPUB 用 `cfiRange`+`chapter` 定位，PDF 用 `page`+归一化 `rects`） |
| PUT/DELETE | `/api/books/:id/highlights/:hid` | 改色改笔记 / 删除 |
| GET/PUT | `/api/books/:id/progress` | 阅读进度 |
