const SESSION_COOKIE = "__Host-prd_session";
const OAUTH_STATE_COOKIE = "__Host-prd_oauth";
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Unhandled authentication gateway error", error?.message || error);
      return htmlResponse("服务暂不可用", "鉴权服务发生异常，请稍后重试。", 500);
    }
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const pathname = normalizePath(url.pathname);

  if (pathname === "/health") {
    return Response.json({ status: "ok" }, { headers: securityHeaders() });
  }

  if (pathname === "/auth/login") {
    return startLogin(request, env);
  }

  if (pathname === "/auth/callback") {
    return finishLogin(request, env);
  }

  if (pathname === "/auth/logout") {
    return logout(request, env);
  }

  if (pathname === "/auth/me") {
    const session = await readSession(request, env);
    if (!session) {
      return Response.json({ authenticated: false }, { status: 401, headers: securityHeaders() });
    }
    return Response.json(
      {
        authenticated: true,
        name: session.name,
        expires_at: new Date(session.exp * 1000).toISOString(),
      },
      { headers: securityHeaders({ "Cache-Control": "private, no-store" }) },
    );
  }

  const missing = missingConfiguration(env);
  if (missing.length) {
    return htmlResponse(
      "鉴权尚未完成配置",
      `Cloudflare Pages 缺少必要变量：${escapeHtml(missing.join(", "))}。为避免误公开，所有文档资源已被拒绝访问。`,
      503,
    );
  }

  const session = await readSession(request, env);
  if (!session) {
    const returnTo = safeReturnTo(`${pathname}${url.search}`);
    return redirect(`${url.origin}/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: securityHeaders({ Allow: "GET, HEAD" }) });
  }

  const assetResponse = await env.ASSETS.fetch(request);
  const headers = new Headers(assetResponse.headers);
  applySecurityHeaders(headers, {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

async function startLogin(request, env) {
  const missing = missingConfiguration(env);
  if (missing.length) {
    return htmlResponse(
      "飞书登录尚未配置",
      `请先在 Cloudflare Pages 添加：${escapeHtml(missing.join(", "))}。`,
      503,
    );
  }

  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("return_to") || "/");
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = await sha256Base64Url(verifier);
  const issuedAt = Math.floor(Date.now() / 1000);
  const oauthState = await signPayload(
    {
      state,
      verifier,
      returnTo,
      iat: issuedAt,
      exp: issuedAt + OAUTH_STATE_TTL_SECONDS,
    },
    env.SESSION_SECRET,
  );

  const authorizeUrl = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  authorizeUrl.searchParams.set("client_id", env.FEISHU_APP_ID);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl(url.origin, env));
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  return redirect(authorizeUrl.toString(), [
    serializeCookie(OAUTH_STATE_COOKIE, oauthState, OAUTH_STATE_TTL_SECONDS),
  ]);
}

async function finishLogin(request, env) {
  const missing = missingConfiguration(env);
  if (missing.length) {
    return htmlResponse("飞书登录尚未配置", `缺少：${escapeHtml(missing.join(", "))}`, 503);
  }

  const url = new URL(request.url);
  if (url.searchParams.get("error")) {
    return htmlResponse("授权未完成", "你取消了飞书授权，未创建文档访问登录态。", 401);
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const stateCookie = getCookie(request, OAUTH_STATE_COOKIE);
  const oauthState = stateCookie ? await verifyPayload(stateCookie, env.SESSION_SECRET) : null;

  if (!code || !returnedState || !oauthState || oauthState.state !== returnedState) {
    return htmlResponse("登录校验失败", "OAuth state 无效或已过期，请重新发起登录。", 400, [clearCookie(OAUTH_STATE_COOKIE)]);
  }

  const tokenResponse = await fetch("https://accounts.feishu.cn/oauth/v3/token", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: env.FEISHU_APP_ID,
      client_secret: env.FEISHU_APP_SECRET,
      code,
      redirect_uri: callbackUrl(url.origin, env),
      code_verifier: oauthState.verifier,
    }),
  });

  const tokenBody = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || tokenBody.code || !tokenBody.access_token) {
    console.error("Feishu token exchange failed", tokenResponse.status, tokenBody.code, tokenBody.error);
    return htmlResponse("飞书登录失败", "无法换取用户访问凭证，请检查飞书应用配置。", 502, [clearCookie(OAUTH_STATE_COOKIE)]);
  }

  const userResponse = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", {
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  const userBody = await userResponse.json().catch(() => ({}));
  const user = userBody.data;

  if (!userResponse.ok || userBody.code !== 0 || !user?.open_id || !user?.tenant_key) {
    console.error("Feishu user info failed", userResponse.status, userBody.code);
    return htmlResponse("无法确认飞书身份", "获取飞书用户信息失败，请稍后重试。", 502, [clearCookie(OAUTH_STATE_COOKIE)]);
  }

  if (!allowedTenantKeys(env).includes(user.tenant_key)) {
    return htmlResponse(
      "无权访问",
      "当前飞书账号不属于允许访问该 PRD 的企业，请切换企业账号后重试。",
      403,
      [clearCookie(OAUTH_STATE_COOKIE), clearCookie(SESSION_COOKIE)],
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = sessionTtl(env);
  const sessionToken = await signPayload(
    {
      sub: user.open_id,
      tenant: user.tenant_key,
      name: user.name || "飞书用户",
      iat: now,
      exp: now + ttl,
    },
    env.SESSION_SECRET,
  );

  return redirect(new URL(safeReturnTo(oauthState.returnTo), url.origin).toString(), [
    clearCookie(OAUTH_STATE_COOKIE),
    serializeCookie(SESSION_COOKIE, sessionToken, ttl),
  ]);
}

async function logout(request, env) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("return_to") || "/");
  return redirect(new URL(returnTo, url.origin).toString(), [clearCookie(SESSION_COOKIE), clearCookie(OAUTH_STATE_COOKIE)]);
}

async function readSession(request, env) {
  if (!env.SESSION_SECRET || !env.ALLOWED_TENANT_KEYS) return null;
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const payload = await verifyPayload(token, env.SESSION_SECRET);
  if (!payload || !payload.sub || !payload.tenant || !payload.exp) return null;
  if (!allowedTenantKeys(env).includes(payload.tenant)) return null;
  return payload;
}

function missingConfiguration(env) {
  const required = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "ALLOWED_TENANT_KEYS", "SESSION_SECRET"];
  return required.filter((key) => !String(env?.[key] || "").trim());
}

function allowedTenantKeys(env) {
  const raw = String(env.ALLOWED_TENANT_KEYS || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const values = JSON.parse(raw);
      return Array.isArray(values) ? values.map(String).map((value) => value.trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function sessionTtl(env) {
  const value = Number.parseInt(env.SESSION_TTL_SECONDS || "", 10);
  return Number.isFinite(value) && value >= 300 && value <= 86400 ? value : DEFAULT_SESSION_TTL_SECONDS;
}

function callbackUrl(origin, env) {
  return String(env.OAUTH_REDIRECT_URI || `${origin}/auth/callback`).trim();
}

function safeReturnTo(value) {
  const input = String(value || "/");
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\")) return "/";
  try {
    const parsed = new URL(input, "https://internal.invalid");
    if (parsed.origin !== "https://internal.invalid") return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

function normalizePath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const entry of header.split(";")) {
    const [key, ...parts] = entry.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return "";
}

function serializeCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, ...securityHeaders({ "Cache-Control": "private, no-store" }) });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function htmlResponse(title, message, status = 200, cookies = []) {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#f5f7fa;color:#303133;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:grid;place-items:center;min-height:100vh}.card{width:min(520px,calc(100% - 40px));padding:32px;background:#fff;border:1px solid #ebeef4;border-radius:12px;box-shadow:0 14px 34px rgba(15,23,42,.08)}h1{font-size:22px;margin:0 0 12px}p{line-height:1.8;color:#606266;margin:0 0 20px}a{display:inline-block;padding:7px 14px;border-radius:5px;background:#a86115;color:#fff;text-decoration:none}</style></head><body><main class="card"><h1>${escapeHtml(title)}</h1><p>${message}</p><a href="/auth/login">使用飞书重新登录</a></main></body></html>`;
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", ...securityHeaders({ "Cache-Control": "private, no-store" }) });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(body, { status, headers });
}

function securityHeaders(extra = {}) {
  const headers = new Headers();
  applySecurityHeaders(headers, extra);
  return Object.fromEntries(headers.entries());
}

function applySecurityHeaders(headers, extra = {}) {
  const defaults = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self' https://accounts.feishu.cn",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    ...extra,
  };
  for (const [key, value] of Object.entries(defaults)) headers.set(key, value);
}

async function signPayload(payload, secret) {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await hmac(body, secret);
  return `${body}.${signature}`;
}

async function verifyPayload(token, secret) {
  const [body, signature, extra] = String(token || "").split(".");
  if (!body || !signature || extra) return null;
  const expected = await hmac(body, secret);
  if (!timingSafeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(decoder.decode(base64UrlDecode(body)));
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function randomToken(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

export const __test = {
  allowedTenantKeys,
  safeReturnTo,
  signPayload,
  verifyPayload,
  missingConfiguration,
};
