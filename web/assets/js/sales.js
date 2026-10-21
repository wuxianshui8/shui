// 业务员推广端：推广物料 / 业绩看板 / 客户管理 / 奖励明细 / 提现 / 我的
import { session, api, idemKey, loginByPassword } from "./api.js";
import {
  esc, money, cents, fmtDate, avatar, toastOk, toastErr,
  confirmDialog, sheet, createRouter, loadingHtml, emptyHtml,
} from "./ui.js";

const $shell = document.querySelector(".m-shell");
const $hdr = document.getElementById("hdr");
const $body = document.querySelector("[data-route]");
const $tab = document.getElementById("tabbar");
const ORIGIN = location.origin;

const TABS = [
  { path: "/", label: "推广", ico: "📣" },
  { path: "/perf", label: "业绩", ico: "📈" },
  { path: "/customers", label: "客户", ico: "👥" },
  { path: "/me", label: "我的", ico: "🙋" },
];
const TAB_ALIAS = { "/rewards": "/perf", "/wallet": "/me" };
const state = { range: "today", trend: "gmv", filter: "全部", rewardType: "" };
let router = null;

/* ============================ 通用工具 ============================ */
const isAuthed = () => !!session.token && ["sales", "admin"].includes(session.user?.role || "");
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) + "%" : "—");
const shortMoney = (c) => {
  const y = Number(c || 0) / 100;
  if (y >= 10000) return "¥" + (y / 10000).toFixed(1) + "万";
  if (y >= 1000) return "¥" + (y / 1000).toFixed(1) + "k";
  return "¥" + Math.round(y);
};

function setBusy(btn, busy, text = "处理中…") {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.old) btn.dataset.old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML =
      '<span class="spinner" style="width:14px;height:14px;border-color:#d9e2ec;border-top-color:var(--brand)"></span><span>' +
      esc(text) + "</span>";
  } else {
    btn.disabled = false;
    if (btn.dataset.old) { btn.innerHTML = btn.dataset.old; delete btn.dataset.old; }
  }
}

async function GET(path, query) {
  try { return await api.get(path, query); }
  catch (e) { onApiErr(e); throw e; }
}
async function POST(path, body, opts) {
  try { return await api.post(path, body, opts); }
  catch (e) { onApiErr(e); throw e; }
}
function onApiErr(e) {
  if (e && (e.status === 401 || e.code === "UNAUTHORIZED")) {
    session.clear();
    if (isAuthed() === false) renderLogin("登录状态已失效，请重新登录。");
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext !== false) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 继续降级 */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const done = document.execCommand("copy");
    ta.remove();
    return !!done;
  } catch { return false; }
}

/* ============================ 外壳渲染 ============================ */
function setHeader({ title, sub = "", back = false, refresh = false }) {
  $hdr.innerHTML =
    (back ? '<button class="back-btn" data-h="back" aria-label="返回">‹</button>' : "") +
    '<div class="grow"><h1>' + esc(title) + "</h1>" +
    (sub ? '<div class="sub">' + esc(sub) + "</div>" : "") + "</div>" +
    (refresh ? '<button class="icon-btn" data-h="refresh" aria-label="刷新页面">⟳</button>' : "");
  $hdr.querySelector('[data-h="back"]')?.addEventListener("click", () => {
    if (history.length > 1) history.back();
    else location.hash = "#/";
  });
  $hdr.querySelector('[data-h="refresh"]')?.addEventListener("click", () => router?.render());
}

function renderTabbar(active) {
  if (!isAuthed()) {
    $tab.innerHTML = "";
    $tab.style.display = "none";
    return;
  }
  $tab.style.display = "";
  $tab.innerHTML = TABS.map((t) =>
    '<button data-path="' + t.path + '" class="' + (active === t.path ? "active" : "") + '"' +
    (active === t.path ? ' aria-current="page"' : "") + ">" +
    '<span class="ico" aria-hidden="true">' + t.ico + "</span><span>" + t.label + "</span></button>"
  ).join("");
  $tab.querySelectorAll("[data-path]").forEach((b) =>
    b.addEventListener("click", () => { location.hash = "#" + b.dataset.path; })
  );
}

function clearSubBar() {
  $shell.querySelectorAll(".sub-bar").forEach((n) => n.remove());
  $shell.classList.remove("has-subb");
}
function setSubBar(html) {
  clearSubBar();
  const el = document.createElement("div");
  el.className = "sub-bar";
  el.innerHTML = html;
  $shell.appendChild(el);
  $shell.classList.add("has-subb");
  return el;
}
function clearLayers() {
  $shell.querySelectorAll(".mask").forEach((n) => n.remove());
  clearSubBar();
}

/* ============================ 伪二维码（确定性图案） ============================ */
const QR_N = 25;
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 由 token 生成确定性模块矩阵（含三个定位角 + 中心 logo 留白） */
function qrModules(token) {
  const r = rng(hashSeed(token));
  const m = Array.from({ length: QR_N }, () => Array(QR_N).fill(0));
  const inFinder = (x, y) =>
    (x < 8 && y < 8) || (x >= QR_N - 8 && y < 8) || (x < 8 && y >= QR_N - 8);
  for (let y = 0; y < QR_N; y++) {
    for (let x = 0; x < QR_N; x++) {
      if (inFinder(x, y)) continue;
      m[y][x] = r() > 0.52 ? 1 : 0;
    }
  }
  const finder = (ox, oy) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const edge = x === 0 || y === 0 || x === 6 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        m[oy + y][ox + x] = edge || core ? 1 : 0;
      }
    }
  };
  finder(0, 0);
  finder(QR_N - 7, 0);
  finder(0, QR_N - 7);
  const c0 = Math.floor((QR_N - 5) / 2);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) m[c0 + y][c0 + x] = 0;
  return m;
}
function qrSvg(token, px = 118) {
  const m = qrModules(token);
  const N = QR_N + 4; // 2 模块静区
  let rects = "";
  for (let y = 0; y < QR_N; y++) {
    for (let x = 0; x < QR_N; x++) {
      if (m[y][x]) rects += '<rect x="' + (x + 2) + '" y="' + (y + 2) + '" width="1" height="1"/>';
    }
  }
  const c0 = Math.floor((QR_N - 5) / 2) + 2;
  return (
    '<svg viewBox="0 0 ' + N + " " + N + '" width="' + px + '" height="' + px +
    '" shape-rendering="crispEdges" role="img" aria-label="推广二维码示意图案">' +
    '<rect width="' + N + '" height="' + N + '" fill="#ffffff"/>' +
    '<g fill="#16332b">' + rects + "</g>" +
    '<rect x="' + c0 + '" y="' + c0 + '" width="5" height="5" rx="1.1" fill="#ffffff"/>' +
    '<text x="' + (N / 2) + '" y="' + (N / 2 + 1.15) +
    '" text-anchor="middle" font-size="2.6" font-weight="700" fill="#0c9370" font-family="sans-serif">家教</text>' +
    "</svg>"
  );
}

/* ============================ 登录层 ============================ */
function renderLogin(msg = "") {
  clearLayers();
  renderTabbar(null);
  $hdr.innerHTML =
    '<div class="grow"><h1>业务员工作台</h1><div class="sub">推广拉新 · 业绩 · 客户 · 奖励</div></div>';
  const warn = msg || (session.token && !isAuthed() ? "当前账号不是业务员角色，请使用业务员账号登录。" : "");
  $body.innerHTML =
    '<div class="op-hero">' +
    '<div class="hero-kicker">运营端 · 业务员</div>' +
    '<div class="hero-title">扫码拉新，成交即得奖励</div>' +
    '<div class="hero-sub">专属推广码 · 客户永久归属 · 按周结算</div>' +
    "</div>" +
    '<form class="card" id="loginForm" novalidate>' +
    '<div class="card-title"><h3>业务员登录</h3><span class="badge gray">演示环境</span></div>' +
    (warn ? '<div class="hint small mb12">' + esc(warn) + "</div>" : "") +
    '<div class="field"><label for="lgPhone">手机号<span class="req">*</span></label>' +
    '<input class="input" id="lgPhone" name="phone" type="tel" inputmode="numeric" autocomplete="username" value="13900000101" required></div>' +
    '<div class="field"><label for="lgPwd">登录密码<span class="req">*</span></label>' +
    '<input class="input" id="lgPwd" name="password" type="password" autocomplete="current-password" value="a123456" required></div>' +
    '<button class="btn btn-primary btn-block" type="submit" id="lgBtn">登 录</button>' +
    '<div class="tiny faint mt12 center">演示账号 13900000101 · 口令 a123456</div>' +
    "</form>" +
    '<div class="hint green small">本页面为演示环境，所有数据来自本地 SQLite 演示库。</div>';

  const form = $body.querySelector("#loginForm");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const phone = $body.querySelector("#lgPhone").value.trim();
    const pwd = $body.querySelector("#lgPwd").value;
    if (!/^1\d{10}$/.test(phone)) return toastErr("请输入 11 位手机号");
    if (!pwd) return toastErr("请输入登录密码");
    const btn = $body.querySelector("#lgBtn");
    setBusy(btn, true, "登录中…");
    try {
      await loginByPassword(phone, pwd, "sales");
      toastOk("登录成功");
      await router.render();
    } catch (err) {
      toastErr(err.message || "登录失败");
      setBusy(btn, false);
    }
  });
}

function guard() {
  if (isAuthed()) return true;
  renderLogin();
  return false;
}

/* ============================ 4.3.1 推广物料 ============================ */
function codeCard(c, name, salesCode) {
  const isParent = c.target === "parent";
  const link = ORIGIN + (isParent ? "/parent" : "/teacher") + "?invite=" + encodeURIComponent(c.token);
  return (
    '<div class="card">' +
    '<div class="row between mb12">' +
    '<div class="card-title" style="margin:0"><h3>' + (isParent ? "家长端推广码" : "教员端推广码") + "</h3></div>" +
    '<span class="badge ' + (isParent ? "green" : "gold") + '">' + (isParent ? "扫码找老师" : "扫码接单") + "</span>" +
    "</div>" +
    '<div class="row" style="gap:14px;align-items:flex-start">' +
    '<div class="qr-box">' + qrSvg(c.token, 118) + "</div>" +
    '<div class="grow">' +
    '<div class="tiny faint">专属推广链接</div>' +
    '<div class="link-box">' + esc(link) + "</div>" +
    '<div class="grid-2 mt8" style="gap:8px">' +
    '<div class="mini-stat"><b>' + c.scans + '</b><span>扫码数</span></div>' +
    '<div class="mini-stat"><b>' + c.registrations + '</b><span>注册数</span></div>' +
    "</div>" +
    '<div class="tiny faint mt8">扫码转化 ' + pct(c.registrations, c.scans) + " · 邀请码 " + esc(c.token) + "</div>" +
    "</div></div>" +
    '<div class="btn-row mt12">' +
    '<button class="btn btn-sm btn-ghost" data-copy="' + esc(link) + '">复制链接</button>' +
    '<button class="btn btn-sm btn-outline" data-scan="' + esc(c.token) + '">模拟扫码</button>' +
    "</div>" +
    '<button class="btn btn-sm btn-primary btn-block mt8" data-poster="' + esc(c.token) +
    '" data-target="' + esc(c.target) + '">保存推广海报</button>' +
    "</div>"
  );
}

async function pagePromo() {
  if (!guard()) return;
  clearLayers();
  setHeader({ title: "推广物料", sub: "专属推广码 · 扫码自动绑定归属", refresh: true });
  $body.innerHTML = loadingHtml("加载推广物料…");
  const d = await GET("/api/sales/dashboard");
  const s = d.sales || {};
  const name = session.user?.nickname || "业务员";
  const agentName = d.agent?.name || "未分配代理";
  const regionName = d.agent?.regionName || "未分配片区";
  const codes = (d.codes || []).slice().sort((a, b) => (a.target === "parent" ? -1 : 1));

  $body.innerHTML =
    '<div class="op-hero">' +
    '<div class="row" style="gap:12px">' +
    avatar(name, null, "lg") +
    '<div class="grow">' +
    '<div class="row wrap" style="gap:6px"><b style="font-size:16px">' + esc(name) + "</b>" +
    '<span class="hero-chip">工号 ' + esc(s.code || "-") + "</span></div>" +
    '<div class="hero-sub">' + esc(regionName) + " · 所属代理 " + esc(agentName) + "</div>" +
    "</div></div>" +
    '<div class="hero-stats">' +
    "<div><b>" + (d.today?.registrations ?? 0) + "</b><span>今日拉新</span></div>" +
    "<div><b>" + (d.month?.deals ?? 0) + "</b><span>本月成交</span></div>" +
    '<div><b class="long">' + money(d.rewards?.wallet?.balance) + "</b><span>钱包余额</span></div>" +
    "</div></div>" +
    '<div class="section-title"><span class="bar"></span>扫码推广入口</div>' +
    codes.map((c) => codeCard(c, name, s.code)).join("") +
    '<div class="hint green small">' +
    "家长 / 教员通过您的专属链接注册后，客户永久归属本工号；扫码数据每 1 次点击累加，注册数按成功绑定计。" +
    "</div>" +
    '<div class="card flat tight mt16"><div class="row between"><span class="small faint">客户归属永久绑定，扫码注册后不可转移</span>' +
    '<span class="badge">推广中</span></div></div>';

  $body.querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      const ok = await copyText(b.dataset.copy);
      ok ? toastOk("推广链接已复制") : toastErr("复制失败，请长按链接手动复制");
    })
  );

  $body.querySelectorAll("[data-scan]").forEach((b) =>
    b.addEventListener("click", async () => {
      setBusy(b, true, "记录中…");
      try {
        await POST("/api/public/promo/" + encodeURIComponent(b.dataset.scan) + "/scan");
        toastOk("已记录 1 次扫码");
        await router.render();
      } catch (e) {
        toastErr(e.message || "扫码记录失败");
        setBusy(b, false);
      }
    })
  );

  $body.querySelectorAll("[data-poster]").forEach((b) =>
    b.addEventListener("click", () => {
      const c = codes.find((x) => x.token === b.dataset.poster) || {
        token: b.dataset.poster,
        target: b.dataset.target,
      };
      openPoster(c, name, s.code);
    })
  );
}

function openPoster(code, name, salesCode) {
  const isParent = code.target === "parent";
  const html =
    '<div class="poster">' +
    '<div class="poster-top"><div class="poster-title">家教上门撮合平台</div>' +
    '<div class="poster-sub">专业老师上门辅导 · 片区就近匹配</div></div>' +
    '<div class="poster-card">' +
    '<div class="poster-name">' + esc(name) + "</div>" +
    '<div class="poster-code">业务员编号 ' + esc(salesCode || "-") + "</div>" +
    '<div class="poster-qr">' + qrSvg(code.token, 186) + "</div>" +
    '<div class="poster-slogan">扫码注册，附近好老师上门辅导</div>' +
    '<div class="poster-target">' + (isParent ? "注册家长账号 · 免费发布家教需求" : "注册教员账号 · 就近接单赚课酬") + "</div>" +
    '<div class="poster-token">邀请码 ' + esc(code.token) + "</div>" +
    "</div>" +
    '<div class="poster-foot">平台仅提供家教信息撮合服务，教员资质由平台人工核验</div>' +
    "</div>" +
    '<div class="hint green small mt12">海报由本地 canvas 直接绘制（无第三方库），点击「下载图片」保存 PNG。</div>';
  sheet("推广海报", html, [
    { label: "关闭", class: "btn-outline" },
    { label: "下载图片", class: "btn-primary", onClick: () => downloadPoster(code, name, salesCode) },
  ]);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function downloadPoster(code, name, salesCode) {
  const W = 750;
  const H = 1180;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");
  if (!ctx) { toastErr("当前浏览器不支持 canvas，无法导出图片"); return; }
  const isParent = code.target === "parent";
  const CN = "'Microsoft YaHei','PingFang SC',sans-serif";
  try {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#10b98b");
    g.addColorStop(1, "#0b7f63");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,.10)";
    ctx.beginPath();
    ctx.arc(660, 80, 200, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 40px " + CN;
    ctx.fillText("家教上门撮合平台", W / 2, 118);
    ctx.font = "400 22px " + CN;
    ctx.fillStyle = "rgba(255,255,255,.88)";
    ctx.fillText("专业老师上门辅导 · 片区就近匹配", W / 2, 160);

    roundRect(ctx, 48, 196, W - 96, 840, 36);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    ctx.textAlign = "left";
    ctx.fillStyle = "#333333";
    ctx.font = "700 34px " + CN;
    ctx.fillText(name || "专属顾问", 96, 268);
    ctx.fillStyle = "#999999";
    ctx.font = "400 22px " + CN;
    ctx.fillText("业务员编号 " + (salesCode || "-"), 96, 304);

    const m = qrModules(code.token);
    const N = QR_N + 4;
    const size = 400;
    const cell = size / N;
    const ox = (W - size) / 2;
    const oy = 348;
    ctx.strokeStyle = "#eef1f5";
    ctx.lineWidth = 2;
    roundRect(ctx, ox - 16, oy - 16, size + 32, size + 32, 22);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#16332b";
    for (let y = 0; y < QR_N; y++) {
      for (let x = 0; x < QR_N; x++) {
        if (m[y][x]) ctx.fillRect(ox + (x + 2) * cell, oy + (y + 2) * cell, Math.ceil(cell), Math.ceil(cell));
      }
    }
    const c0 = Math.floor((QR_N - 5) / 2) + 2;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(ox + c0 * cell - 1, oy + c0 * cell - 1, cell * 5 + 2, cell * 5 + 2);
    ctx.textAlign = "center";
    ctx.fillStyle = "#0c9370";
    ctx.font = "700 " + Math.round(cell * 2.3) + "px " + CN;
    ctx.fillText("家教", W / 2, oy + c0 * cell + cell * 3.5);

    ctx.fillStyle = "#0c9370";
    ctx.font = "700 34px " + CN;
    ctx.fillText("扫码注册，附近好老师上门辅导", W / 2, oy + size + 84);
    ctx.fillStyle = "#666666";
    ctx.font = "400 22px " + CN;
    ctx.fillText(isParent ? "注册家长账号 · 免费发布家教需求" : "注册教员账号 · 就近接单赚课酬", W / 2, oy + size + 122);

    roundRect(ctx, 110, oy + size + 148, W - 220, 64, 14);
    ctx.fillStyle = "#f7faf9";
    ctx.fill();
    ctx.fillStyle = "#0a7a5d";
    ctx.font = "600 22px " + CN;
    ctx.fillText("邀请码 " + code.token, W / 2, oy + size + 190);

    ctx.fillStyle = "rgba(255,255,255,.9)";
    ctx.font = "400 20px " + CN;
    ctx.fillText("长按识别二维码注册，注册后自动绑定专属顾问", W / 2, 1092);
    ctx.fillStyle = "rgba(255,255,255,.72)";
    ctx.font = "400 17px " + CN;
    ctx.fillText("平台仅提供家教信息撮合服务，教员资质由平台人工核验", W / 2, 1124);
  } catch (e) {
    toastErr("海报绘制失败：" + (e.message || "未知错误"));
    return;
  }
  cv.toBlob((blob) => {
    if (!blob) { toastErr("海报生成失败，请重试"); return; }
    downloadBlob(blob, "推广海报-" + (salesCode || "sales") + "-" + code.target + ".png");
    toastOk("海报已下载");
  }, "image/png");
}

/* ============================ 4.3.2 业绩看板 ============================ */
async function pagePerf() {
  if (!guard()) return;
  clearLayers();
  setHeader({ title: "业绩看板", sub: "拉新 · 留资 · 成交 · 奖励结算", refresh: true });
  $body.innerHTML = loadingHtml("加载业绩数据…");
  const d = await GET("/api/sales/dashboard");
  const RANGES = [
    { k: "today", l: "今日" },
    { k: "week", l: "本周" },
    { k: "month", l: "本月" },
  ];
  if (!RANGES.some((r) => r.k === state.range)) state.range = "today";

  $body.innerHTML =
    '<div class="segmented" id="rangeSeg" role="tablist" aria-label="统计区间">' +
    RANGES.map((r) => '<button type="button" role="tab" aria-selected="' + (state.range === r.k) +
      '" data-range="' + r.k + '" class="' + (state.range === r.k ? "on" : "") + '">' + r.l + "</button>").join("") +
    "</div>" +
    '<div class="stat-grid mt12" id="statBox"></div>' +
    '<div class="card mt16">' +
    '<div class="card-title"><h3>奖励与钱包</h3></div>' +
    '<div class="grid-3">' +
    '<div class="mini-stat"><b>' + money(d.rewards?.pending) + "</b><span>待结算</span></div>" +
    '<div class="mini-stat"><b>' + money(d.rewards?.settled) + "</b><span>已发放</span></div>" +
    '<div class="mini-stat"><b>' + money(d.rewards?.wallet?.balance) + "</b><span>钱包余额</span></div>" +
    "</div>" +
    '<div class="btn-row mt12">' +
    '<button class="btn btn-sm btn-ghost" data-go="/rewards">奖励明细</button>' +
    '<button class="btn btn-sm btn-outline" data-go="/wallet">提现</button>' +
    "</div></div>" +
    '<div class="card">' +
    '<div class="card-title"><h3>业绩趋势（近 7 天）</h3>' +
    '<span class="more" id="trendSum"></span></div>' +
    '<div class="segmented mb12" id="trendSeg" aria-label="趋势口径">' +
    '<button type="button" data-trend="gmv" class="' + (state.trend === "gmv" ? "on" : "") + '">GMV 口径</button>' +
    '<button type="button" data-trend="registrations" class="' + (state.trend === "registrations" ? "on" : "") + '">注册数口径</button>' +
    "</div>" +
    '<div id="trendBox"></div>' +
    "</div>" +
    '<div class="hint green small">口径说明：注册数按绑定时间统计，留资数为已发布需求的客户数，GMV 为已支付订单金额合计。</div>';

  const statBox = $body.querySelector("#statBox");
  const trendBox = $body.querySelector("#trendBox");
  const trendSum = $body.querySelector("#trendSum");

  const renderStats = () => {
    const s = d[state.range] || { registrations: 0, leads: 0, deals: 0, gmv: 0 };
    statBox.innerHTML =
      '<div class="stat"><div class="label">新增注册</div><div class="value">' + (s.registrations ?? 0) +
      "<small>人</small></div></div>" +
      '<div class="stat"><div class="label">有效留资</div><div class="value">' + (s.leads ?? 0) +
      "<small>人</small></div></div>" +
      '<div class="stat"><div class="label">成交订单</div><div class="value">' + (s.deals ?? 0) +
      "<small>单</small></div></div>" +
      '<div class="stat accent"><div class="label">业绩 GMV</div>' +
      '<div class="value" style="font-size:17px">' + money(s.gmv) + "</div></div>";
  };

  const renderTrend = () => {
    const t = d.trend || [];
    if (!t.length) { trendBox.innerHTML = emptyHtml("暂无趋势数据", "📉"); trendSum.textContent = ""; return; }
    const vals = t.map((x) => Number(state.trend === "gmv" ? x.gmv : x.registrations) || 0);
    const max = Math.max(1, ...vals);
    const total = vals.reduce((a, b) => a + b, 0);
    trendSum.textContent = state.trend === "gmv" ? "合计 " + money(total) : "合计 " + total + " 人";
    trendBox.innerHTML =
      '<div class="bars tall">' +
      t.map((x, i) => {
        const v = vals[i];
        const h = 8 + Math.round((v / max) * 62);
        const label = state.trend === "gmv" ? shortMoney(v) : v + " 人";
        return (
          '<div class="bar" title="' + esc(x.date) + " · " + esc(label) + '">' +
          '<span class="v">' + esc(label) + "</span>" +
          '<i style="height:' + h + '%"></i>' +
          '<span class="d">' + fmtDate(x.date, "md") + "</span></div>"
        );
      }).join("") +
      "</div>";
  };

  renderStats();
  renderTrend();

  $body.querySelectorAll("[data-range]").forEach((b) =>
    b.addEventListener("click", () => {
      state.range = b.dataset.range;
      $body.querySelectorAll("[data-range]").forEach((x) => {
        x.classList.toggle("on", x.dataset.range === state.range);
        x.setAttribute("aria-selected", String(x.dataset.range === state.range));
      });
      renderStats();
    })
  );
  $body.querySelectorAll("[data-trend]").forEach((b) =>
    b.addEventListener("click", () => {
      state.trend = b.dataset.trend;
      $body.querySelectorAll("[data-trend]").forEach((x) => x.classList.toggle("on", x.dataset.trend === state.trend));
      renderTrend();
    })
  );
  $body.querySelectorAll("[data-go]").forEach((b) =>
    b.addEventListener("click", () => { location.hash = "#" + b.dataset.go; })
  );
}

/* ============================ 4.3.3 客户管理 ============================ */
const CUSTOMER_BADGE = {
  "已注册": "gray",
  "已发需求": "gold",
  "已成交": "green",
};

async function pageCustomers() {
  if (!guard()) return;
  clearLayers();
  setHeader({ title: "客户管理", sub: "扫码归属客户 · 平台内联系", refresh: true });
  $body.innerHTML = loadingHtml("加载客户列表…");
  const d = await GET("/api/sales/customers");
  const list = d.list || [];
  const sum = d.summary || {};
  const FILTERS = [
    { k: "全部", n: sum.total ?? list.length },
    { k: "已注册", n: sum.registered ?? 0 },
    { k: "已发需求", n: sum.demanded ?? 0 },
    { k: "已成交", n: sum.dealt ?? 0 },
  ];

  $body.innerHTML =
    '<div class="row wrap" style="gap:6px" id="custFilter">' +
    FILTERS.map((f) =>
      '<button class="chip ' + (state.filter === f.k ? "on" : "") + '" data-filter="' + f.k + '">' +
      f.k + " " + f.n + "</button>"
    ).join("") +
    "</div>" +
    '<div class="grid-3 mt12">' +
    '<div class="mini-stat"><b>' + (sum.total ?? 0) + '</b><span>客户总数</span></div>' +
    '<div class="mini-stat"><b>' + (sum.demanded ?? 0) + '</b><span>已发需求</span></div>' +
    '<div class="mini-stat"><b>' + (sum.dealt ?? 0) + '</b><span>已成交</span></div>' +
    "</div>" +
    '<div class="hint green small mt16">为保护隐私，平台不展示客户完整手机号，仅支持平台内联系。</div>' +
    '<div class="card mt16"><div class="card-title"><h3>客户明细</h3>' +
    '<span class="more" id="custCount"></span></div><div id="custList"></div></div>';

  const listBox = $body.querySelector("#custList");
  const countBox = $body.querySelector("#custCount");

  const renderList = () => {
    const rows = state.filter === "全部" ? list : list.filter((x) => x.status === state.filter);
    countBox.textContent = rows.length + " 条";
    if (!rows.length) {
      listBox.innerHTML = emptyHtml(
        state.filter === "全部" ? "还没有绑定客户，先去推广拉新吧" : "该状态下暂无客户",
        "👥"
      );
      return;
    }
    listBox.innerHTML =
      '<div class="stagger">' +
      rows.map((c, i) =>
        '<div class="list-item" data-cust="' + i + '" role="button" tabindex="0">' +
        avatar(c.nickname, c.avatar) +
        '<div class="grow">' +
        '<div class="row between"><div class="title ellipsis">' + esc(c.nickname || "未命名用户") + "</div>" +
        '<span class="badge ' + (CUSTOMER_BADGE[c.status] || "gray") + '">' + esc(c.status) + "</span></div>" +
        '<div class="meta">' + esc(c.phone) + " · 来源" + (c.source === "scan" ? "扫码" : "自然") +
        " · 绑定 " + fmtDate(c.boundAt, "date") + "</div>" +
        '<div class="row wrap mt8" style="gap:6px">' +
        '<span class="tag">' + (c.role === "parent" ? "家长" : c.role === "teacher" ? "教员" : esc(c.role)) + "</span>" +
        '<span class="tag">需求 ' + (c.demandCount || 0) + "</span>" +
        '<span class="tag ' + (c.dealCount > 0 ? "pos" : "") + '">成交 ' + (c.dealCount || 0) + "</span>" +
        "</div></div></div>"
      ).join("") +
      "</div>";

    listBox.querySelectorAll("[data-cust]").forEach((el) => {
      const c = rows[Number(el.dataset.cust)];
      const open = () => openCustomer(c);
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    });
  };

  $body.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      state.filter = b.dataset.filter;
      $body.querySelectorAll("[data-filter]").forEach((x) => x.classList.toggle("on", x.dataset.filter === state.filter));
      renderList();
    })
  );
  renderList();
}

function openCustomer(c) {
  const html =
    '<div class="kv"><span class="k">昵称</span><span class="v">' + esc(c.nickname || "-") + "</span></div>" +
    '<div class="kv"><span class="k">手机号（脱敏）</span><span class="v">' + esc(c.phone || "-") + "</span></div>" +
    '<div class="kv"><span class="k">身份</span><span class="v">' + (c.role === "parent" ? "家长" : c.role === "teacher" ? "教员" : esc(c.role)) + "</span></div>" +
    '<div class="kv"><span class="k">来源</span><span class="v">' + (c.source === "scan" ? "扫码推广" : "自然注册") + "</span></div>" +
    '<div class="kv"><span class="k">绑定时间</span><span class="v">' + fmtDate(c.boundAt, "time") + "</span></div>" +
    '<div class="kv"><span class="k">需求数</span><span class="v">' + (c.demandCount || 0) + "</span></div>" +
    '<div class="kv"><span class="k">成交数</span><span class="v">' + (c.dealCount || 0) + "</span></div>" +
    '<div class="kv"><span class="k">客户状态</span><span class="v">' + esc(c.status) + "</span></div>" +
    '<div class="hint green small mt12">完整手机号与联系方式不对业务员开放，如需沟通请引导客户在平台内下单后通过订单页联系。</div>';
  sheet("客户详情", html, [{ label: "关闭", class: "btn-outline" }]);
}

/* ============================ 4.3.4 奖励明细 ============================ */
function rulesHtml(r) {
  if (!r) return emptyHtml("暂无奖励规则配置", "📄");
  const tiers = (r.deal_tiers || []).map((t, i) =>
    '<div class="kv"><span class="k">阶梯 ' + (i + 1) + "：" + money(t.min) +
    (t.max == null ? " 以上" : " – " + money(t.max)) + '</span><span class="v">' + ((t.rate || 0) * 100).toFixed(0) + "%</span></div>"
  ).join("");
  const period = { weekly: "按周结算", monthly: "按月结算", daily: "按日结算" }[r.settle_period] || esc(r.settle_period || "—");
  return (
    '<div class="kv"><span class="k">注册奖（每成功注册 1 人）</span><span class="v">' + money(r.register) + "</span></div>" +
    '<div class="kv"><span class="k">留资奖（客户发布需求）</span><span class="v">' + money(r.lead) + "</span></div>" +
    '<div class="kv"><span class="k">新人首单奖</span><span class="v">' + money(r.newbie_first) + "</span></div>" +
    '<div class="kv"><span class="k">日冠军奖</span><span class="v">' + money(r.daily_champ) + "</span></div>" +
    '<div class="kv"><span class="k">周冠军奖</span><span class="v">' + money(r.weekly_champ) + "</span></div>" +
    '<div class="divider"></div>' +
    '<div class="tiny faint mb8">成交提成阶梯（按订单实付金额）</div>' + tiers +
    '<div class="kv"><span class="k">结算周期</span><span class="v">' + period + "</span></div>"
  );
}

const REWARD_STATUS = {
  pending: ["待结算", "gold"],
  settled: ["已结算", "green"],
  cancelled: ["已取消", "gray"],
};

function rewardListHtml(list) {
  if (!list || !list.length) return emptyHtml("暂无奖励记录", "🎁");
  return (
    '<div class="stagger">' +
    list.map((r, i) => {
      const st = REWARD_STATUS[r.status] || [r.status, "gray"];
      return (
        '<div class="list-item" style="cursor:default" data-reward="' + i + '">' +
        '<div class="grow">' +
        '<div class="row between"><b class="small">' + esc(rewardTypeLabel(r.type)) + "</b>" +
        '<span class="row" style="gap:6px"><span class="badge ' + st[1] + '">' + esc(st[0]) + "</span>" +
        '<span class="money" style="font-size:14px">' + money(r.amount) + "</span></span></div>" +
        '<div class="meta">' + esc(r.calc_note || "无计算说明") + "</div>" +
        '<div class="tiny faint mt8">' +
        (r.order_no ? "关联订单 " + esc(r.order_no) + " · " : "") +
        fmtDate(r.created_at, "time") +
        (r.settle_at ? " · 结算 " + fmtDate(r.settle_at, "date") : "") +
        "</div></div></div>"
      );
    }).join("") +
    "</div>"
  );
}

let rewardTypesCache = [];
function rewardTypeLabel(type) {
  return (rewardTypesCache.find((t) => t.value === type) || {}).label || type;
}

async function pageRewards() {
  if (!guard()) return;
  clearLayers();
  setHeader({ title: "奖励明细", sub: "注册 / 留资 / 成交 / 冠军奖", back: true, refresh: true });
  $body.innerHTML = loadingHtml("加载奖励明细…");
  const d = await GET("/api/sales/rewards", { type: state.rewardType || undefined });
  rewardTypesCache = d.types || [];
  const byTypeMap = {};
  (d.byType || []).forEach((x) => { byTypeMap[x.type] = x; });

  $body.innerHTML =
    '<div class="grid-3">' +
    '<div class="mini-stat"><b>' + money(d.wallet?.balance) + '</b><span>钱包余额</span></div>' +
    '<div class="mini-stat"><b>' + money(d.wallet?.totalIncome) + '</b><span>累计收益</span></div>' +
    '<div class="mini-stat"><b>' + money(d.wallet?.totalWithdraw) + '</b><span>已提现</span></div>' +
    "</div>" +
    '<div class="card mt16"><div class="card-title"><h3>按类型汇总</h3><span class="badge gray">全量</span></div>' +
    '<div class="grid-3" style="gap:8px">' +
    rewardTypesCache.map((t) => {
      const row = byTypeMap[t.value];
      return (
        '<div class="mini-stat"><b>' + money(row ? row.total : 0) + "</b><span>" + esc(t.label) +
        (row ? " · " + row.c + " 笔" : " · 0 笔") + "</span></div>"
      );
    }).join("") +
    "</div></div>" +
    '<div class="card"><div class="tabs" id="typeTabs">' +
    '<button data-type="" class="' + (state.rewardType === "" ? "on" : "") + '">全部</button>' +
    rewardTypesCache.map((t) =>
      '<button data-type="' + esc(t.value) + '" class="' + (state.rewardType === t.value ? "on" : "") + '">' + esc(t.label) + "</button>"
    ).join("") +
    "</div>" +
    '<div class="row between mb8"><span class="tiny faint" id="rewardCount"></span>' +
    '<button class="btn btn-xs btn-outline" id="rewardRefresh">刷新</button></div>' +
    '<div id="rewardList"></div></div>' +
    '<details class="card rules"><summary>计算规则</summary>' + rulesHtml(d.rules) + "</details>" +
    '<div class="hint green small">奖励按结算周期自动生成，待结算奖励在订单确认完成并通过风控复核后转为已结算。</div>';

  const listBox = $body.querySelector("#rewardList");
  const countBox = $body.querySelector("#rewardCount");
  const paint = (rows) => {
    listBox.innerHTML = rewardListHtml(rows);
    countBox.textContent = "共 " + (rows || []).length + " 笔记录（最多展示 200 笔）";
  };
  paint(d.list);

  const load = async () => {
    listBox.innerHTML = loadingHtml("加载奖励记录…");
    try {
      const dd = await GET("/api/sales/rewards", { type: state.rewardType || undefined });
      paint(dd.list);
    } catch (e) {
      listBox.innerHTML = emptyHtml(e.message || "奖励记录加载失败", "⚠️");
    }
  };

  $body.querySelectorAll("#typeTabs [data-type]").forEach((b) =>
    b.addEventListener("click", () => {
      state.rewardType = b.dataset.type;
      $body.querySelectorAll("#typeTabs [data-type]").forEach((x) => x.classList.toggle("on", x.dataset.type === state.rewardType));
      load();
    })
  );
  $body.querySelector("#rewardRefresh").addEventListener("click", load);
}

/* ============================ 4.3.5 提现与结算 ============================ */
const WD_STATUS = {
  pending: ["待审核", "gold"],
  approved: ["已审核待打款", "green"],
  paid: ["已打款", "green"],
  rejected: ["已驳回", "danger"],
};
const CHANNEL_LABEL = { wechat: "微信", bank: "银行卡" };
const TXN_LABEL = {
  withdraw: "提现",
  sales_reward: "销售奖励",
  reward: "奖励入账",
  settle: "结算入账",
  refund: "退款",
  agent_share: "片区分成",
  teacher_income: "课酬收入",
};

async function pageWallet() {
  if (!guard()) return;
  clearLayers();
  setHeader({ title: "提现与结算", sub: "余额 · 提现申请 · 提现记录", back: true, refresh: true });
  $body.innerHTML = loadingHtml("加载钱包与提现记录…");
  const [w, wd] = await Promise.all([GET("/api/wallet"), GET("/api/withdrawals")]);
  const wallet = wd.wallet || w.wallet || { balance: 0, frozen: 0, totalIncome: 0, totalWithdraw: 0 };
  const rule = wd.rule || w.rule || {};
  const min = Number(rule.min_withdraw || 0);
  const rate = Number(rule.withdraw_fee_rate || 0);
  const records = wd.list || [];
  const txns = (w.txns || []).slice(0, 8);

  $body.innerHTML =
    '<div class="op-hero">' +
    '<div class="hero-kicker">可提现余额</div>' +
    '<div class="hero-title" style="font-size:26px">' + money(wallet.balance) + "</div>" +
    '<div class="hero-sub">冻结 ' + money(wallet.frozen) + " · 累计收益 " + money(wallet.totalIncome) + "</div>" +
    '<div class="hero-stats">' +
    "<div><b>" + money(wallet.balance) + "</b><span>可用余额</span></div>" +
    "<div><b>" + money(wallet.frozen) + "</b><span>冻结中</span></div>" +
    "<div><b>" + money(wallet.totalWithdraw) + "</b><span>已提现</span></div>" +
    "</div></div>" +
    '<div class="card">' +
    '<div class="card-title"><h3>申请提现</h3><span class="badge gray">最低 ' + money(min) + "</span></div>" +
    '<div class="field"><label for="wdAmount">提现金额（元）<span class="req">*</span></label>' +
    '<input class="input" id="wdAmount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" aria-describedby="wdHint">' +
    '<div class="row between mt8"><span class="tiny faint" id="wdHint">可提现 ' + money(wallet.balance) + "</span>" +
    '<button class="btn btn-xs btn-ghost" id="wdAll" type="button">全部提现</button></div></div>' +
    '<div class="field"><label>收款方式</label>' +
    '<div class="segmented" id="wdChannel" role="group" aria-label="收款方式">' +
    '<button type="button" data-ch="wechat" class="on">微信</button>' +
    '<button type="button" data-ch="bank">银行卡</button></div></div>' +
    '<div class="field"><label for="wdAccount">收款账号<span class="req">*</span></label>' +
    '<input class="input" id="wdAccount" placeholder="微信：微信号 / 手机号；银行卡：卡号">' +
    '<div class="tiny faint mt8">账号提交后由平台脱敏保存，仅用于打款。</div></div>' +
    '<div class="card flat tight" style="background:#f8fbfa;margin-bottom:14px">' +
    '<div class="kv"><span class="k">手续费（' + (rate * 100).toFixed(2) + '%）</span><span class="v" id="wdFee">¥0.00</span></div>' +
    '<div class="kv"><span class="k">预计到账</span><span class="v" id="wdNet">¥0.00</span></div></div>' +
    '<button class="btn btn-primary btn-block" id="wdSubmit" type="button">提交提现申请</button>' +
    '<div class="tiny faint mt8 center">提交后进入平台审核，审核通过后按所选渠道打款。</div>' +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>提现记录</h3>' +
    '<span class="more">' + records.length + " 条</span></div>" +
    (records.length
      ? '<div class="stagger">' + records.map(wdItemHtml).join("") + "</div>"
      : emptyHtml("还没有提现记录", "🧾")) +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>结算规则</h3></div>' +
    '<div class="kv"><span class="k">资金冻结期</span><span class="v">' + (rule.freeze_days ?? "-") + " 天</span></div>" +
    '<div class="kv"><span class="k">最低提现金额</span><span class="v">' + money(min) + "</span></div>" +
    '<div class="kv"><span class="k">提现手续费率</span><span class="v">' + (rate * 100).toFixed(2) + "%</span></div>" +
    '<div class="kv"><span class="k">状态说明</span><span class="v">待审核 / 已打款 / 已驳回</span></div>' +
    '<div class="hint green small mt8">资金由平台担保账户托管，订单确认完成并过冻结期后转为可提现余额。</div>' +
    "</div>" +
    (txns.length
      ? '<details class="card rules"><summary>最近资金流水</summary>' +
        txns.map((t) =>
          '<div class="kv"><span class="k">' + esc(TXN_LABEL[t.type] || t.type) +
          '<br><span class="tiny faint">' + fmtDate(t.created_at, "time") + "</span></span>" +
          '<span class="v" style="color:' + (t.amount < 0 ? "var(--ink)" : "var(--brand-dark)") + '">' +
          (t.amount > 0 ? "+" : "") + money(t.amount) + "</span></div>"
        ).join("") + "</details>"
      : "");

  const amountEl = $body.querySelector("#wdAmount");
  const accountEl = $body.querySelector("#wdAccount");
  const feeEl = $body.querySelector("#wdFee");
  const netEl = $body.querySelector("#wdNet");
  const submitBtn = $body.querySelector("#wdSubmit");
  let channel = "wechat";

  const currentAmount = () => cents(Number(amountEl.value || 0));
  const updateFee = () => {
    const amount = currentAmount();
    const fee = amount > 0 ? Math.round(amount * rate) : 0;
    feeEl.textContent = money(fee);
    netEl.textContent = money(Math.max(0, amount - fee));
  };
  amountEl.addEventListener("input", updateFee);
  updateFee();

  $body.querySelector("#wdAll").addEventListener("click", () => {
    amountEl.value = (Number(wallet.balance || 0) / 100).toFixed(2);
    updateFee();
    amountEl.focus();
  });

  $body.querySelectorAll("#wdChannel [data-ch]").forEach((b) =>
    b.addEventListener("click", () => {
      channel = b.dataset.ch;
      $body.querySelectorAll("#wdChannel [data-ch]").forEach((x) => x.classList.toggle("on", x.dataset.ch === channel));
      accountEl.placeholder = channel === "wechat" ? "微信：微信号 / 手机号" : "银行卡：卡号";
    })
  );

  submitBtn.addEventListener("click", async () => {
    const amount = currentAmount();
    if (!Number.isFinite(amount) || amount <= 0) return toastErr("请输入提现金额");
    if (amount < min) return toastErr("最低提现 " + money(min));
    if (amount > wallet.balance) return toastErr("可提现余额不足");
    const account = accountEl.value.trim();
    if (!account) return toastErr("请填写收款账号");
    const fee = Math.round(amount * rate);
    const okConfirm = await confirmDialog(
      "提交提现申请",
      "提现 " + money(amount) + "，手续费 " + money(fee) + "，预计到账 " + money(amount - fee) +
      "。提交后由平台审核打款。",
      "确认提交"
    );
    if (!okConfirm) return;
    setBusy(submitBtn, true, "提交中…");
    try {
      await POST("/api/withdrawals", { amount, channel, account }, { idem: idemKey("wd") });
      toastOk("提现申请已提交，等待平台审核");
      await router.render();
    } catch (e) {
      toastErr(e.message || "提现申请失败");
      setBusy(submitBtn, false);
    }
  });
}

function wdItemHtml(x) {
  const st = WD_STATUS[x.status] || [x.status, "gray"];
  return (
    '<div class="list-item" style="cursor:default">' +
    '<div class="grow">' +
    '<div class="row between"><b class="small">提现 ' + money(x.amount) + "</b>" +
    '<span class="badge ' + st[1] + '">' + esc(st[0]) + "</span></div>" +
    '<div class="meta">' + esc(CHANNEL_LABEL[x.channel] || x.channel) + " · " + esc(x.account || "-") +
    " · 手续费 " + money(x.fee) + "</div>" +
    '<div class="tiny faint mt8">申请 ' + fmtDate(x.created_at, "time") +
    " · 预计到账 " + money(x.actual) + "</div>" +
    (x.status === "rejected" && x.reject_reason
      ? '<div class="tiny mt8" style="color:var(--danger)">驳回原因：' + esc(x.reject_reason) + "</div>"
      : "") +
    "</div></div>"
  );
}

/* ============================ 我的 ============================ */
async function pageMe() {
  if (!guard()) return;
  clearLayers();
  setHeader({ title: "我的", sub: "账号 · 推广 · 设置", refresh: true });
  $body.innerHTML = loadingHtml("加载账号信息…");
  const p = await GET("/api/sales/profile");
  const dash = await GET("/api/sales/dashboard").catch(() => null);
  const s = p.sales || {};
  const region = p.region || {};
  const wallet = p.wallet || {};
  const codes = p.codes || [];
  const agentName = dash?.agent?.name || "—";
  const name = s.name || session.user?.nickname || "业务员";

  $body.innerHTML =
    '<div class="op-hero">' +
    '<div class="row" style="gap:12px">' +
    avatar(name, null, "lg") +
    '<div class="grow"><div class="row wrap" style="gap:6px"><b style="font-size:16px">' + esc(name) + "</b>" +
    '<span class="hero-chip">' + (s.status === "disabled" ? "已停用" : "在职业务员") + "</span></div>" +
    '<div class="hero-sub">' + esc(s.phone || session.user?.phone || "-") + " · 工号 " + esc(s.code || "-") + "</div>" +
    "</div></div>" +
    '<div class="hero-stats">' +
    "<div><b>" + money(wallet.balance) + "</b><span>可用余额</span></div>" +
    "<div><b>" + money(wallet.totalIncome) + "</b><span>累计收益</span></div>" +
    "<div><b>" + money(wallet.totalWithdraw) + "</b><span>已提现</span></div>" +
    "</div></div>" +
    '<div class="card"><div class="card-title"><h3>账号信息</h3></div>' +
    '<div class="kv"><span class="k">业务员编号</span><span class="v">' + esc(s.code || "-") + "</span></div>" +
    '<div class="kv"><span class="k">所属片区</span><span class="v">' + esc(region.name || "-") + "</span></div>" +
    '<div class="kv"><span class="k">所属代理</span><span class="v">' + esc(agentName) + "</span></div>" +
    '<div class="kv"><span class="k">入职时间</span><span class="v">' + fmtDate(s.joined_at, "date") + "</span></div>" +
    '<div class="kv"><span class="k">账号状态</span><span class="v">' + (s.status === "disabled" ? "已停用" : "正常") + "</span></div>" +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>我的推广码</h3>' +
    '<span class="more" data-go="/">去推广 ›</span></div>' +
    (codes.length
      ? codes.map((c) =>
          '<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line)">' +
          '<div><div class="small bold">' + (c.target === "parent" ? "家长端" : "教员端") + "</div>" +
          '<div class="tiny faint">' + esc(c.token) + "</div></div>" +
          '<div class="small">扫码 ' + c.scans + " · 注册 " + c.registrations + "</div></div>"
        ).join("")
      : emptyHtml("暂无推广码", "🔗")) +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>设置</h3></div>' +
    '<div class="action-item" data-go="/rewards"><span class="ico">🎁</span><span class="grow">奖励明细</span><span class="arrow">›</span></div>' +
    '<div class="action-item" data-go="/wallet"><span class="ico">💳</span><span class="grow">提现与结算</span><span class="arrow">›</span></div>' +
    '<div class="action-item" id="msgEntry"><span class="ico">🔔</span><span class="grow">消息中心</span><span class="arrow">›</span></div>' +
    '<div class="action-item" id="pwdEntry"><span class="ico">🔒</span><span class="grow">修改密码</span><span class="arrow">›</span></div>' +
    '<div class="action-item danger" id="logoutEntry"><span class="ico">⏏</span><span class="grow">退出登录</span><span class="arrow">›</span></div>' +
    "</div>" +
    '<div class="hint green small">演示环境数据来自本地 SQLite 演示库，账号口令为 a123456。</div>';

  $body.querySelectorAll("[data-go]").forEach((el) =>
    el.addEventListener("click", () => { location.hash = "#" + el.dataset.go; })
  );
  $body.querySelector("#msgEntry").addEventListener("click", openMessages);
  $body.querySelector("#pwdEntry").addEventListener("click", openPassword);
  $body.querySelector("#logoutEntry").addEventListener("click", logout);
}

async function openMessages() {
  const res = sheet("消息中心", loadingHtml("加载消息…"), [{ label: "关闭", class: "btn-outline" }]);
  const box = res.el.querySelector(".sheet-body");
  try {
    const d = await GET("/api/messages");
    const list = d.list || [];
    if (!list.length) { box.innerHTML = emptyHtml("暂无消息", "📭"); return; }
    box.innerHTML =
      '<div class="row between mb12"><span class="small faint">共 ' + list.length + " 条 · 未读 " +
      (d.unread ?? 0) + " 条</span>" +
      (d.unread ? '<button class="btn btn-xs btn-ghost" id="markAll" type="button">全部标为已读</button>' : "") +
      "</div>" +
      '<div class="stagger">' +
      list.map((m) =>
        '<div class="list-item" style="cursor:default">' +
        '<div class="grow"><div class="row between"><b class="small">' + esc(m.title) + "</b>" +
        '<span class="badge ' + (m.read ? "gray" : "") + '">' + (m.read ? "已读" : "未读") + "</span></div>" +
        (m.content ? '<div class="meta">' + esc(m.content) + "</div>" : "") +
        '<div class="tiny faint mt8">' + fmtDate(m.created_at, "time") + "</div></div></div>"
      ).join("") + "</div>";
    const markAll = box.querySelector("#markAll");
    if (markAll) {
      markAll.addEventListener("click", async () => {
        setBusy(markAll, true, "处理中…");
        try {
          await POST("/api/messages/read-all");
          toastOk("已全部标为已读");
          res.close();
        } catch (e) {
          toastErr(e.message || "操作失败");
          setBusy(markAll, false);
        }
      });
    }
  } catch (e) {
    box.innerHTML = emptyHtml(e.message || "消息加载失败", "⚠️");
  }
}

function openPassword() {
  const res = sheet(
    "修改登录密码",
    '<div class="field"><label for="np1">新密码<span class="req">*</span></label>' +
    '<input class="input" id="np1" type="password" autocomplete="new-password" placeholder="至少 6 位"></div>' +
    '<div class="field"><label for="np2">确认新密码<span class="req">*</span></label>' +
    '<input class="input" id="np2" type="password" autocomplete="new-password" placeholder="再次输入"></div>' +
    '<div class="hint small">修改成功后其他设备需使用新密码重新登录。</div>' +
    '<button class="btn btn-primary btn-block mt16" id="npSave" type="button">保存新密码</button>',
    [{ label: "取消", class: "btn-outline" }]
  );
  res.el.querySelector("#npSave").addEventListener("click", async (e) => {
    const a = res.el.querySelector("#np1").value.trim();
    const b = res.el.querySelector("#np2").value.trim();
    if (a.length < 6) return toastErr("密码至少 6 位");
    if (a !== b) return toastErr("两次输入的密码不一致");
    setBusy(e.currentTarget, true, "保存中…");
    try {
      await POST("/api/auth/password", { password: a });
      toastOk("密码已更新");
      res.close();
    } catch (err) {
      toastErr(err.message || "修改失败");
      setBusy(e.currentTarget, false);
    }
  });
}

async function logout() {
  const okConfirm = await confirmDialog("退出登录", "退出后需重新输入账号密码才能进入业务员工作台。", "退出登录", true);
  if (!okConfirm) return;
  session.clear();
  toastOk("已退出登录");
  await router.render();
}

/* ============================ 路由 ============================ */
router = createRouter(
  {
    "/": pagePromo,
    "/perf": pagePerf,
    "/customers": pageCustomers,
    "/rewards": pageRewards,
    "/wallet": pageWallet,
    "/me": pageMe,
  },
  { onAfter: (path) => renderTabbar(TAB_ALIAS[path] || path) }
);

window.addEventListener("hashchange", () => { $body.scrollTop = 0; });

if (!isAuthed()) renderLogin();
else router.render();
