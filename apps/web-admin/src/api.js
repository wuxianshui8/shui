// 统一 API 客户端：与 NestJS 后端 /api 契约一致（code=0 为成功）
const TOKEN_KEY = "jiajiao_admin_token";
const USER_KEY = "jiajiao_admin_user";

export const auth = {
  get token() {
    return localStorage.getItem(TOKEN_KEY) || "";
  },
  get user() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  },
  save(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user || null));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

async function request(method, path, body, extraHeaders = {}) {
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  if (auth.token) headers.Authorization = "Bearer " + auth.token;
  const res = await fetch("/api" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    auth.clear();
    if (!location.hash.includes("/login")) location.hash = "#/login";
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { code: -1, message: text };
  }
  if (!res.ok || (json && json.code !== 0)) {
    const msg = (json && json.message) || "请求失败（HTTP " + res.status + "）";
    throw new Error(msg);
  }
  return json.data;
}

export const api = {
  get: (p) => request("GET", p),
  post: (p, b, h) => request("POST", p, b ?? {}, h),
  put: (p, b) => request("PUT", p, b ?? {}),
  del: (p) => request("DELETE", p),
};

export const money = (cents) => "¥" + (Number(cents || 0) / 100).toFixed(2);
export const STATUS_TEXT = {
  awaiting_payment: "待付款",
  pending_class: "待上课",
  in_class: "进行中",
  awaiting_parent_confirm: "待家长确认",
  completed: "已完成",
  settled: "已结算",
  cancelled: "已取消",
  refunding: "退款中",
  refunded: "已退款",
};
