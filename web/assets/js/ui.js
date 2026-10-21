// 前端 UI 工具：转义、金额格式化、轻提示、弹层、哈希路由
export function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 分 → 字符串金额 */
export function money(cents, withSymbol = true) {
  const n = Number(cents || 0) / 100;
  const s = n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return withSymbol ? "¥" + s : s;
}
/** 分 → 数字元 */
export function yuan(cents) { return Number((Number(cents || 0) / 100).toFixed(2)); }
/** 元 → 分 */
export function cents(y) { return Math.round(Number(y || 0) * 100); }

export function fmtDate(iso, mode = "date") {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, "0");
  const ymd = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  const hm = p(d.getHours()) + ":" + p(d.getMinutes());
  if (mode === "date") return ymd;
  if (mode === "time") return ymd + " " + hm;
  if (mode === "hm") return hm;
  if (mode === "md") return p(d.getMonth() + 1) + "-" + p(d.getDate());
  return ymd + " " + hm;
}

export function fromNow(iso) {
  if (!iso) return "-";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  const d = Math.floor(h / 24);
  if (d < 30) return d + " 天前";
  return fmtDate(iso);
}

export function stars(score, max = 5) {
  const s = Math.round(Number(score) || 0);
  let out = "";
  for (let i = 1; i <= max; i++) out += '<i class="' + (i <= s ? "on" : "") + '">★</i>';
  return '<span class="stars">' + out + "</span>";
}

export function levelBadge(level, name) {
  const map = { Lv1: "lv1", Lv2: "lv2", Lv3: "lv3", Lv4: "lv4", Lv5: "lv5" };
  return '<span class="level-badge ' + (map[level] || "lv1") + '">' + esc(name || level) + "</span>";
}

const STATUS_STYLE = {
  awaiting_payment: "gold", pending_class: "", in_class: "green",
  awaiting_parent_confirm: "gold", completed: "green", settled: "green",
  cancelled: "gray", refunding: "danger", refunded: "gray",
  published: "", paused: "gray", revoked: "gray", matched: "green",
  pending: "gold", approved: "green", rejected: "danger",
  paid: "green", open: "gold", agent_handled: "", escalated: "danger", closed: "gray",
  active: "green", disabled: "gray", on: "green", off: "gray",
};
export function statusBadge(status, text) {
  return '<span class="badge ' + (STATUS_STYLE[status] || "gray") + '">' + esc(text || status) + "</span>";
}

export function avatar(name, url, cls = "") {
  const ch = String(name || "用").replace(/^家长·|^业务员·|^.*代理·/, "").slice(0, 1);
  if (url && String(url).startsWith("/") || (url && String(url).startsWith("http"))) {
    return '<div class="avatar ' + cls + '"><img src="' + esc(url) + '" alt=""></div>';
  }
  return '<div class="avatar ' + cls + '">' + esc(ch) + "</div>";
}

/* ---------------- 轻提示 ---------------- */
let toastWrap = null;
export function toast(message, type = "") {
  if (!toastWrap) {
    toastWrap = document.createElement("div");
    toastWrap.className = "toast-wrap";
    document.body.appendChild(toastWrap);
  }
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = message;
  toastWrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .2s ease";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 220);
  }, type === "err" ? 3200 : 2000);
}
export const toastOk = (m) => toast(m, "ok");
export const toastErr = (m) => toast(m, "err");

/* ---------------- 弹层 ---------------- */
function host() {
  return document.querySelector(".m-shell") || document.body;
}

export function confirmDialog(title, text, confirmText = "确定", danger = false) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "mask center";
    mask.innerHTML =
      '<div class="dialog">' +
      '<h3 style="font-size:16px;font-weight:700">' + esc(title) + "</h3>" +
      '<p class="small muted" style="margin-top:8px;line-height:1.7">' + esc(text || "") + "</p>" +
      '<div class="btn-row" style="margin-top:20px">' +
      '<button class="btn btn-outline" data-act="no">取消</button>' +
      '<button class="btn ' + (danger ? "btn-danger" : "btn-primary") + '" data-act="yes">' + esc(confirmText) + "</button>" +
      "</div></div>";
    host().appendChild(mask);
    const close = (v) => { mask.remove(); resolve(v); };
    mask.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "yes") close(true);
      else if (act === "no" || e.target === mask) close(false);
    });
  });
}

export function promptDialog(title, placeholder, { value = "", textarea = true, confirmText = "提交" } = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "mask center";
    mask.innerHTML =
      '<div class="dialog">' +
      '<h3 style="font-size:16px;font-weight:700">' + esc(title) + "</h3>" +
      (textarea
        ? '<textarea class="textarea mt12" data-in placeholder="' + esc(placeholder || "") + '"></textarea>'
        : '<input class="input mt12" data-in placeholder="' + esc(placeholder || "") + '">') +
      '<div class="btn-row" style="margin-top:18px">' +
      '<button class="btn btn-outline" data-act="no">取消</button>' +
      '<button class="btn btn-primary" data-act="yes">' + esc(confirmText) + "</button>" +
      "</div></div>";
    host().appendChild(mask);
    const input = mask.querySelector("[data-in]");
    input.value = value;
    input.focus();
    const close = (v) => { mask.remove(); resolve(v); };
    mask.querySelector('[data-act="yes"]').onclick = () => {
      if (!input.value.trim()) return toastErr("请填写内容");
      close(input.value.trim());
    };
    mask.querySelector('[data-act="no"]').onclick = () => close(null);
  });
}

export function sheet(title, contentHtml, actions = []) {
  const mask = document.createElement("div");
  mask.className = "mask";
  mask.innerHTML =
    '<div class="sheet"><h3>' + esc(title) + "</h3><div class='sheet-body'>" + contentHtml + "</div>" +
    (actions.length
      ? '<div class="actions">' + actions.map((a, i) =>
          '<button class="btn ' + (a.class || "btn-outline") + '" data-i="' + i + '">' + esc(a.label) + "</button>").join("") + "</div>"
      : "") +
    "</div>";
  host().appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener("click", (e) => {
    if (e.target === mask) return close();
    const btn = e.target.closest("[data-i]");
    if (btn) {
      const a = actions[Number(btn.dataset.i)];
      close();
      a?.onClick?.();
    }
  });
  return { close, el: mask };
}

/* ---------------- 哈希路由 ---------------- */
export function createRouter(routes, { container, onAfter } = {}) {
  const parse = () => {
    const raw = (location.hash || "#/").replace(/^#/, "");
    const [path, qs] = raw.split("?");
    const query = Object.fromEntries(new URLSearchParams(qs || ""));
    return { path: path || "/", query };
  };
  const render = async () => {
    const { path, query } = parse();
    const keys = Object.keys(routes).sort((a, b) => b.split("/").length - a.split("/").length);
    let matched = null;
    let params = {};
    for (const key of keys) {
      const parts = key.split("/").filter(Boolean);
      const cur = path.split("/").filter(Boolean);
      if (parts.length !== cur.length) continue;
      const p = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].startsWith(":")) p[parts[i].slice(1)] = decodeURIComponent(cur[i]);
        else if (parts[i] !== cur[i]) { ok = false; break; }
      }
      if (ok) { matched = routes[key]; params = p; break; }
    }
    const target = container || document.querySelector("[data-route]");
    if (!matched) {
      if (target) target.innerHTML = '<div class="empty"><div class="ico">🧭</div>页面不存在</div>';
      return;
    }
    try {
      await matched({ params, query, path });
      onAfter?.(path);
    } catch (err) {
      if (err?.status === 401) return;
      toastErr(err?.message || "加载失败");
      if (target) target.innerHTML = '<div class="empty"><div class="ico">⚠️</div>' + esc(err?.message || "加载失败") + "</div>";
    }
  };
  window.addEventListener("hashchange", render);
  return { render, parse, go: (p) => (location.hash = "#" + p) };
}

export function loadingHtml(text = "加载中…") {
  return '<div class="empty"><div class="spinner" style="border-color:#dbe3ee;border-top-color:var(--brand);margin:0 auto 10px"></div>' + esc(text) + "</div>";
}
export function emptyHtml(text = "暂无数据", icon = "📭") {
  return '<div class="empty"><div class="ico">' + icon + "</div>" + esc(text) + "</div>";
}

/** 事件委托绑定 */
export function delegate(root, eventName, selector, handler) {
  root.addEventListener(eventName, (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(e, el);
  });
}

/** 表单读取 */
export function formData(root) {
  const out = {};
  root.querySelectorAll("[name]").forEach((el) => {
    if (el.type === "checkbox") out[el.name] = el.checked;
    else out[el.name] = el.value;
  });
  return out;
}