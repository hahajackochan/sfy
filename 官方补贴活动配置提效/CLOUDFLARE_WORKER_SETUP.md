# Cloudflare Worker（workers.dev）+ 飞书企业鉴权部署

目标地址：

```text
https://purple-silence-8fca.hahajackochan.workers.dev
```

当前线上 Worker 已能访问，但所有路径仍返回默认的 `Hello World!`，说明鉴权代码和 PRD 静态资源尚未部署到该 Worker。

本仓库已准备独立 Worker 部署：

- 入口：`cloudflare/_worker.js`
- 静态资源构建目录：`dist-worker/`
- Wrangler 配置：`wrangler.jsonc`
- Worker 名：`purple-silence-8fca`
- 静态资源绑定：`ASSETS`
- `run_worker_first: true`：所有 HTML、原型和附件必须先通过鉴权

## 一、飞书回调地址

在飞书企业自建应用的 **安全设置 → 重定向 URL** 中添加：

```text
https://purple-silence-8fca.hahajackochan.workers.dev/auth/callback
```

如果不再使用 Pages，可以删除或保留旧的 Pages 回调；实际 Worker 只使用上面的地址。

## 二、部署方式 A：本机 Wrangler（推荐）

### 1. 登录 Cloudflare

在项目目录运行：

```bash
npx wrangler login
```

浏览器中确认授权。

### 2. 写入 Secrets

逐个运行，终端会要求输入值；不要把真实值写入仓库：

```bash
npx wrangler secret put FEISHU_APP_ID
npx wrangler secret put FEISHU_APP_SECRET
npx wrangler secret put ALLOWED_TENANT_KEYS
npx wrangler secret put SESSION_SECRET
```

`ALLOWED_TENANT_KEYS` 示例：

```json
["你的飞书企业 tenant_key"]
```

生成 Session Secret：

```bash
openssl rand -base64 48
```

### 3. 本地验证

```bash
npm run check
```

### 4. 部署

```bash
npm run deploy:worker
```

Wrangler 会覆盖当前 `Hello World!` 版本，并同时上传 PRD、原型和附件。

## 三、部署方式 B：Cloudflare Dashboard 编辑器

Dashboard 在线编辑器适合简单 Hello World，不适合本项目，因为还要上传多层静态资源目录。若不用 Wrangler，应使用 Worker 的 Git 集成并把构建/部署命令配置为：

```text
npm run deploy:worker
```

但首次接入及 Secrets 配置仍建议使用 Dashboard 的 **Settings → Variables and Secrets** 完成。

## 四、变量

`wrangler.jsonc` 已包含非敏感变量：

```text
OAUTH_REDIRECT_URI=https:...back
SESSION_TTL_SECONDS=28800
```

必须以 Secret 保存：

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
ALLOWED_TENANT_KEYS
SESSION_SECRET
```

## 五、验收

部署后：

1. `GET /health` 返回：

   ```json
   {"status":"ok"}
   ```

2. 未登录访问 `/prd/prd_v1.0.html`，跳转 `/auth/login`，继而跳转飞书。
3. 指定企业员工授权后回到原 PRD。
4. 非指定企业返回 403。
5. 退出登录后直接访问 `/prototype/*` 和 `/annex/*` 也必须跳转登录。
6. `/auth/logout` 清理登录态。

## 六、正式切换

Worker 鉴权全部验收通过后：

1. 将 GitHub 仓库改为 Private。
2. 关闭公开 GitHub Pages。
3. 确认 GitHub Raw 匿名访问失败。
4. 对外只使用 Worker 地址。

否则旧 GitHub Pages 和公开仓库仍能绕过飞书鉴权。
