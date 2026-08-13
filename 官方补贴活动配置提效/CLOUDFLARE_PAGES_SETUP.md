# Cloudflare Pages + 飞书企业鉴权部署说明

当前仓库已加入 Cloudflare Pages Advanced Mode 鉴权网关：

- `cloudflare/_worker.js`：飞书 OAuth、企业 `tenant_key` 白名单、Session Cookie、资源统一鉴权。
- `scripts/build-pages.mjs`：生成 Pages 部署目录 `dist/`。
- `tests/auth-worker.test.mjs`：鉴权签名、回跳地址、租户白名单、缺失配置测试。

> 安全默认：未配置全部 Secret 时，PRD、原型和图片统一返回 503，不会误公开。

## 一、先创建 Cloudflare Pages 项目

在 Cloudflare Dashboard：

1. 打开 **Workers & Pages**。
2. 选择 **Create application / Pages / Connect to Git**。
3. 连接 GitHub 仓库：`hahajackochan/official-subsidy-activity-prd`。
4. Production branch：`main`。
5. Framework preset：`None`。
6. Build command：

   ```text
   npm run build:pages
   ```

7. Build output directory：

   ```text
   dist
   ```

8. 保存并执行第一次部署。

部署后记录正式地址，例如：

```text
https://official-subsidy-activity-prd.pages.dev
```

第一次部署在尚未配置飞书变量时，访问正文会显示“鉴权尚未完成配置”，这是预期的失败关闭行为。

## 二、创建飞书企业自建应用

在飞书开放平台开发者后台：

1. 创建 **企业自建应用**。
2. 在 **凭证与基础信息** 获取：
   - App ID
   - App Secret
3. 在 **安全设置 / 重定向 URL** 添加：

   ```text
   https://<你的 Pages 项目>.pages.dev/auth/callback
   ```

4. 设置应用使用范围：
   - 整个企业；或
   - 指定部门 / 指定员工。
5. 发布应用版本，并确保测试员工有应用使用权限。

本方案只使用 OAuth 基础用户信息，不需要手机号、邮箱或通讯录权限。

## 三、在 Cloudflare Pages 配置变量

进入 Pages 项目：**Settings → Variables and Secrets**，在 Production 环境添加：

| 名称 | 类型 | 示例/说明 |
|---|---|---|
| `FEISHU_APP_ID` | Secret | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | Secret | 飞书应用 App Secret |
| `SESSION_SECRET` | Secret | 至少 32 字节的高强度随机值 |
| `ALLOWED_TENANT_KEYS` | Secret | `["tenant_key"]` 或逗号分隔 |
| `OAUTH_REDIRECT_URI` | Variable | `https://<项目>.pages.dev/auth/callback` |
| `SESSION_TTL_SECONDS` | Variable | `28800`（8 小时） |

生成 Session Secret（在本地终端运行）：

```bash
openssl rand -base64 48
```

添加变量后，在 **Deployments** 中对最新生产部署选择 **Retry deployment**，让变量生效。

## 四、获取企业 tenant_key

`tenant_key` 不能凭空填写。推荐在应用测试阶段：

1. 先将测试员工设置在飞书应用使用范围内。
2. 通过飞书 OAuth 登录后，由服务端调用：

   ```text
   GET https://open.feishu.cn/open-apis/authen/v1/user_info
   ```

3. 读取响应里的 `data.tenant_key`。
4. 将该值写入 Cloudflare 的 `ALLOWED_TENANT_KEYS` Secret。
5. 禁止在生产日志长期打印完整用户响应或 access token。

如果暂时不知道 tenant_key，可在飞书开放平台 API 调试台用当前企业账号调用“获取用户信息”取得。

## 五、验收

### 未登录

访问：

```text
https://<项目>.pages.dev/prd/prd_v1.0.html
```

应自动跳转飞书授权页。

### 企业内员工

授权后应回到原 PRD 路径，并正常加载：

- PRD HTML
- 5.1 / 5.2 iframe 原型
- 5.3 / 5.4 图片
- 图片放大预览

### 企业外账号

应返回 403，不得返回任何 PRD、原型或图片内容。

### 直接资源访问

退出后直接访问以下地址，也应跳转飞书登录：

```text
/prototype/prototype_v1.0.html
/annex/会员小程序-商品详情页.jpg
```

### 状态接口

```text
GET /health
GET /auth/me
GET /auth/logout
```

- `/health` 可公开返回 `{"status":"ok"}`。
- 未登录 `/auth/me` 返回 401。
- `/auth/logout` 清理登录态。

## 六、正式切换前的重要事项

当前 GitHub Pages 和公开仓库仍能绕过 Cloudflare 鉴权。Cloudflare 版本验收通过前不要关闭旧入口；正式切换时必须：

1. 将 GitHub 仓库改为 Private。
2. 关闭 GitHub Pages。
3. 确认旧 Pages URL 和匿名 GitHub Raw URL 无法访问。
4. 对外只发送新的 `pages.dev` 地址。

此外，Cloudflare 的 Preview Deployment 也会生成独立的 `pages.dev` 地址。正式使用时：

- 不要在公开 PR 中放未鉴权的构建产物；
- 本项目的 `_worker.js` 会随每个 Preview 一起部署并统一鉴权；
- Preview 环境也需要配置同样的变量，或保持缺失变量时的 503 失败关闭状态。

## 七、本地检查

```bash
npm test
npm run build:pages
```

生成目录 `dist/` 不提交到 Git。
