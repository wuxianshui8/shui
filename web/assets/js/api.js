// 前端 API 客户端：统一鉴权、错误处理、幂等键
const TOKEN_KEY = "jj_token";
const USER_KEY = "jj_user";

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY) || ""; },
  set token(v) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },
  get user() { try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; } },
  set user(u) { u ? localStorage.setItem(USER_KEY, JSON.stringify(u)) : localStorage.removeItem(USER_KEY); },
  save(token, user) { this.token = token; this.user = user; },
  clear() { this.token = ""; this.user = null; },
};

export class ApiError extends Error {
  constructor(message, code, status, data) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export async function request(method, path, body, { idem, query } = {}) {
  let url = path;
  if (query) {
    const q = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") q.set(k, v);
    });
    const s = q.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }
  const headers = { "Content-Type": "application/json" };
  if (session.token) headers.Authorization = "Bearer " + session.token;
  if (idem) headers["X-Idem-Key"] = idem;

  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new ApiError("网络异常，请检查服务是否启动", "NETWORK", 0);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }

  if (!res.ok) {
    if (res.status === 401) {
      session.clear();
      const msg = json?.message || "登录已失效";
      throw new ApiError(msg, "UNAUTHORIZED", 401);
    }
    throw new ApiError(json?.message || "请求失败", json?.code || "ERROR", res.status, json?.data);
  }
  return json?.data;
}

export const api = {
  get: (p, query) => request("GET", p, null, { query }),
  post: (p, body, opts) => request("POST", p, body || {}, opts),
  put: (p, body, opts) => request("PUT", p, body || {}, opts),
  del: (p, body, opts) => request("DELETE", p, body || {}, opts),
};

/** 生成幂等键（支付 / 提现等资金接口） */
export function idemKey(prefix = "k") {
  return prefix + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

/** 登录并跳转；role 不匹配时给出提示 */
export async function loginByPassword(phone, password, expectRole) {
  const data = await api.post("/api/auth/login-password", { phone, password });
  if (expectRole && data.user.role !== expectRole && data.user.role !== "admin") {
    throw new ApiError("该账号不是" + expectRole + "角色（当前：" + data.user.role + "）", "ROLE_MISMATCH", 400);
  }
  session.save(data.token, data.user);
  return data;
}

/** 账号密码登录：account 可以是用户名，也可以是手机号（教员端「用户名 + 密码」） */
export async function loginByAccount(account, password, expectRole) {
  const data = await api.post("/api/auth/login-account", { account, password });
  if (expectRole && data.user.role !== expectRole && data.user.role !== "admin") {
    throw new ApiError("该账号不是" + expectRole + "角色（当前：" + data.user.role + "）", "ROLE_MISMATCH", 400);
  }
  session.save(data.token, data.user);
  return data;
}

export async function loginByCode(phone, code) {
  const data = await api.post("/api/auth/login", { phone, code });
  session.save(data.token, data.user);
  return data;
}

export function requireLogin(redirect = "/") {
  if (!session.token) {
    location.href = redirect;
    return false;
  }
  return true;
}