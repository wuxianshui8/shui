// 区域代理端：片区大盘 / 业务员管理 / 片区订单 / 收益结算 / 风控客诉 / 公告设置
import { session, api, idemKey, loginByPassword } from "./api.js";
import {
  esc, money, cents, fmtDate, avatar, toastOk, toastErr,
  confirmDialog, sheet, createRouter, loadingHtml, emptyHtml,
} from "./ui.js";

const $shell = document.querySelector(".m-shell");
const $hdr = document.getElementById("hdr");
const $body = document.querySelector("[data-route]");
const $tab = document.getElementById("tabbar");

const TABS = [
  { path: "/", label: "片区", ico: "🗺️" },
  { path: "/sales", label: "业务员", ico: "👥" },
  { path: "/earnings", label: "收益", ico: "💰" },
  { path: "/risk", label: "风控", ico: "🛡️" },
  { path: "/me", label: "我的", ico: "⚙️" },
];
const TAB_ALIAS = { "/orders": "/" };
const state = {
  trendMode: "orders",
  kw: "",
  salesStatus: "",
  orderStatus: "",
  orderFrom: "",
  orderTo: "",
  riskId: null,
};
let router = null;

/* ============================ 通用工具 ============================ */
const isAuthed = () => !!session.token && ["agent", "admin"].includes(session.user?.role || "");
const shortMoney = (c) => {
  const y = Number(c || 0) / 100;
  if (y >= 10000) return "¥" + (y / 10000).toFixed(1) + "万";
  if (y >= 1000) return "¥" + (y / 1000).toFixed(1) + "k";
  return "¥" + Math.round(y);
};
const ratePct = (r) => (Number(r || 0) * 100).toFixed(Number(r) * 100 % 1 === 0 ? 0 : 2) + "%";

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
    renderLogin("登录状态已失效，请重新登录。");
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
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ============================ 外壳渲染 ============================ */
function setHeader({ title, sub = "", back = false, refresh = false, action = "" }) {
  $hdr.innerHTML =
    (back ? '<button class="back-btn" data-h="back" aria-label="返回">‹</button>' : "") +
    '<div class="grow"><h1>' + esc(title) + "</h1>" +
    (sub ? '<div class="sub">' + esc(sub) + "</div>" : "") + "</div>" +
    (refresh ? '<button class="icon-btn" data-h="refresh" aria-label="刷新页面">⟳</button>' : "") +
    action;
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

/* ============================ 中文枚举 ============================ */
const ORDER_BADGE = {
  awaiting_payment: "gold", pending_class: "", in_class: "green",
  awaiting_parent_confirm: "gold", completed: "green", settled: "green",
  cancelled: "gray", refunding: "danger", refunded: "gray",
};
const ORDER_STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "awaiting_payment", label: "待付款" },
  { value: "pending_class", label: "待上课" },
  { value: "in_class", label: "进行中" },
  { value: "awaiting_parent_confirm", label: "待确认完成" },
  { value: "completed", label: "已完成" },
  { value: "settled", label: "已结算" },
  { value: "cancelled", label: "已取消" },
  { value: "refunding", label: "退款中" },
  { value: "refunded", label: "已退款" },
];
const RISK_TYPE = {
  sos: "🚨 紧急求助",
  fake_checkin: "虚假打卡",
  brush: "刷单",
  abnormal_location: "定位异常",
  high_cancel: "高频取消",
};
const RISK_LEVEL = {
  low: ["低风险", "gray"],
  mid: ["中风险", "gold"],
  high: ["高风险", "danger"],
};
const RISK_STATUS = {
  open: ["待处理", "gold"],
  reviewing: ["复核中", ""],
  closed: ["已关闭", "gray"],
};
const CMPL_STATUS = {
  open: ["待处理", "gold"],
  agent_handled: ["片区已处理", ""],
  escalated: ["已上报平台", "danger"],
  closed: ["已关闭", "gray"],
};
const WD_STATUS = {
  pending: ["待审核", "gold"],
  approved: ["已审核待打款", "green"],
  paid: ["已打款", "green"],
  rejected: ["已驳回", "danger"],
};
const CHANNEL_LABEL = { wechat: "微信", bank: "银行卡" };

/* ============================ 登录层 ============================ */
function renderLogin(msg = "") {
  clearLayers();
  renderTabbar(null);
  $hdr.innerHTML =
    '<div class="grow"><h1>区域代理工作台</h1><div class="sub">片区大盘 · 业务员 · 收益 · 风控</div></div>';
  const warn = msg || (session.token && !isAuthed() ? "当前账号不是区域代理角色，请使用代理账号登录。" : "");
  $body.innerHTML =
    '<div class="op-hero">' +
    '<div class="hero-kicker">运营端 · 区域代理</div>' +
    '<div class="hero-title">一区一代理，数据隔离运营</div>' +
    '<div class="hero-sub">片区订单撮合 · 业务员团队 · 分成结算 · 客诉风控</div>' +
    "</div>" +
    '<form class="card" id="loginForm" novalidate>' +
    '<div class="card-title"><h3>代理登录</h3><span class="badge gray">演示环境</span></div>' +
    (warn ? '<div class="hint small mb12">' + esc(warn) + "</div>" : "") +
    '<div class="field"><label for="lgPhone">手机号<span class="req">*</span></label>' +
    '<input class="input" id="lgPhone" name="phone" type="tel" inputmode="numeric" autocomplete="username" value="13900000010" required></div>' +
    '<div class="field"><label for="lgPwd">登录密码<span class="req">*</span></label>' +
    '<input class="input" id="lgPwd" name="password" type="password" autocomplete="current-password" value="a123456" required></div>' +
    '<button class="btn btn-primary btn-block" type="submit" id="lgBtn">登 录</button>' +
    '<div class="tiny faint mt12 center">演示账号 13900000010（西湖片区代理）· 口令 a123456</div>' +
    "</form>" +
    '<div class="hint green small">本页面为演示环境，所有数据来自本地 SQLite 演示库。</div>';

  $body.querySelector("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const phone = $body.querySelector("#lgPhone").value.trim();
    const pwd = $body.querySelector("#lgPwd").value;
    if (!/^1\d{10}$/.test(phone)) return toastErr("请输入 11 位手机号");
    if (!pwd) return toastErr("请输入登录密码");
    const btn = $body.querySelector("#lgBtn");
    setBusy(btn, true, "登录中…");
    try {
      await loginByPassword(phone, pwd, "agent");
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

/* ============================ 4.1 区域代理中心首页 ============================ */
async function pageHome() {
  if (!guard()) return;
  clearLayers();
  setHeader({ title: "区域代理中心", sub: "片区内撮合大盘", refresh: true });
  $body.innerHTML = loadingHtml("加载片区数据…");
  const d = await GET("/api/agent/dashboard");
  const a = d.agent || {};
  const region = d.region || {};
  const m = d.metrics || {};
  const risk = d.riskSummary || {};
  const notices = d.notices || [];
  const trend = d.trend || [];

  $body.innerHTML =
    '<div class="op-hero">' +
    '<div class="row between" style="align-items:flex-start;gap:10px">' +
    '<div class="grow">' +
    '<div class="hero-kicker">片区 · 区域代理</div>' +
    '<div class="hero-title">' + esc(region.name || "未分配片区") + "</div>" +
    '<div class="hero-sub">负责人 ' + esc(a.name || "-") + " · " + esc(a.phone || "-") + "</div>" +
    "</div>" +
    '<div class="col" style="align-items:flex-end;gap:6px">' +
    '<span class="hero-chip">代理等级 ' + esc(a.level || "-") + "</span>" +
    '<span class="hero-chip">' + (a.status === "disabled" ? "已停用" : "运营中") + "</span>" +
    "</div></div>" +
    '<div class="hero-stats">' +
    "<div><b>" + (m.todayOrders ?? 0) + "</b><span>今日订单</span></div>" +
    '<div><b class="long">' + shortMoney(m.monthGmv) + "</b><span>本月 GMV</span></div>" +
    "<div><b>" + (m.salesCount ?? 0) + "</b><span>业务员</span></div>" +
    "</div></div>" +
    '<div class="section-title"><span class="bar"></span>核心数据</div>' +
    '<div class="stat-grid">' +
    '<div class="stat"><div class="label">本月订单量</div><div class="value">' + (m.monthOrders ?? 0) + "<small>单</small></div></div>" +
    '<div class="stat accent"><div class="label">片区 GMV</div>' +
    '<div class="value" style="font-size:17px">' + money(m.monthGmv) + "</div></div>" +
    '<div class="stat"><div class="label">业务员人数</div><div class="value">' + (m.salesCount ?? 0) + "<small>人</small></div></div>" +
    '<div class="stat"><div class="label">待结算收益</div>' +
    '<div class="value" style="font-size:17px">' + money(m.pendingSettle) + "</div></div>" +
    "</div>" +
    '<div class="card">' +
    '<div class="card-title"><h3>片区业绩趋势</h3><span class="more" id="trendSum"></span></div>' +
    '<div class="segmented mb12" id="trendSeg" aria-label="趋势口径">' +
    '<button type="button" data-mode="orders" class="' + (state.trendMode === "orders" ? "on" : "") + '">订单量</button>' +
    '<button type="button" data-mode="gmv" class="' + (state.trendMode === "gmv" ? "on" : "") + '">GMV</button>' +
    "</div>" +
    '<div id="trendBox"></div>' +
    "</div>" +
    '<div class="section-title"><span class="bar"></span>快捷功能</div>' +
    '<div class="quick-grid mb16">' +
    '<div class="q" data-go="/sales" role="button" tabindex="0"><div class="ico">👥</div><div class="txt">业务员管理</div></div>' +
    '<div class="q" data-go="/orders" role="button" tabindex="0"><div class="ico">🧾</div><div class="txt">订单管理</div></div>' +
    '<div class="q" data-parents role="button" tabindex="0"><div class="ico">👨‍👩‍👦</div><div class="txt">家长列表</div></div>' +
    '<div class="q" data-go="/earnings" role="button" tabindex="0"><div class="ico">💰</div><div class="txt">收益提现</div></div>' +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>平台公告</h3><span class="more" data-go="/me">全部 ›</span></div>' +
    (notices.length
      ? notices.map(noticeHtml).join("")
      : emptyHtml("暂无公告", "📢")) +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>风险概览</h3><span class="more" data-go="/risk">详情 ›</span></div>' +
    '<div class="grid-3">' +
    '<div class="mini-stat"><b>' + (risk.abnormal ?? 0) + '</b><span>异常订单</span></div>' +
    '<div class="mini-stat"><b>' + (risk.brush ?? 0) + '</b><span>疑似刷单</span></div>' +
    '<div class="mini-stat"><b>' + (risk.complaints ?? 0) + '</b><span>投诉工单</span></div>' +
    "</div></div>" +
    '<div class="card"><div class="card-title"><h3>片区活跃度（近 30 天）</h3></div>' +
    '<div class="grid-3">' +
    '<div class="mini-stat"><b>' + (m.activeTeachers ?? 0) + '</b><span>活跃教员</span></div>' +
    '<div class="mini-stat"><b>' + (m.activeParents ?? 0) + '</b><span>活跃家长</span></div>' +
    '<div class="mini-stat"><b>' + (m.totalRegistrations ?? 0) + '</b><span>片区总注册</span></div>' +
    "</div></div>" +
    (d.assessment ? assessmentHtml(d.assessment) : "") +
    '<div class="hint green small">数据隔离：本页仅统计当前登录代理所属片区（' + esc(region.name || "-") + "）的订单与用户。</div>";

  const trendBox = $body.querySelector("#trendBox");
  const trendSum = $body.querySelector("#trendSum");

  const renderTrend = () => {
    if (!trend.length) { trendBox.innerHTML = emptyHtml("暂无趋势数据", "📉"); trendSum.textContent = ""; return; }
    const isGmv = state.trendMode === "gmv";
    const vals = trend.map((x) => Number(isGmv ? x.gmv : x.orders) || 0);
    const max = Math.max(1, ...vals);
    const total = vals.reduce((s, v) => s + v, 0);
    trendSum.textContent = isGmv ? "7 天合计 " + money(total) : "7 天合计 " + total + " 单";
    trendBox.innerHTML =
      '<div class="bars tall">' +
      trend.map((x, i) => {
        const v = vals[i];
        const h = 8 + Math.round((v / max) * 62);
        const pctOfTotal = total > 0 ? Math.round((v / total) * 100) : 0;
        return (
          '<div class="bar" title="' + esc(x.date) + " · " + (isGmv ? money(v) : v + " 单") + '">' +
          '<span class="v">' + pctOfTotal + "%</span>" +
          '<i style="height:' + h + '%"></i>' +
          '<span class="d">' + fmtDate(x.date, "md") + "</span></div>"
        );
      }).join("") +
      "</div>" +
      '<div class="row between mt8"><span class="tiny faint">柱高按 ' +
      (isGmv ? "GMV" : "订单量") + "最大值归一，柱顶为占 7 天合计的比例</span>" +
      '<span class="tiny faint">' + (isGmv ? "峰值 " + money(max) : "峰值 " + max + " 单") + "</span></div>";
  };
  renderTrend();

  $body.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      state.trendMode = b.dataset.mode;
      $body.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === state.trendMode));
      renderTrend();
    })
  );
  $body.querySelectorAll("[data-go]").forEach((el) => {
    const go = (e) => { e.stopPropagation(); location.hash = "#" + el.dataset.go; };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } });
  });
  const pEntry = $body.querySelector("[data-parents]");
  const openParents = () => openParentsSheet();
  pEntry.addEventListener("click", openParents);
  pEntry.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openParents(); } });
}

/** 考核完成度卡片（指标来自规则配置中心 agent_assessment） */
function assessmentHtml(a) {
  const t = a.targets || {};
  const row = (label, rate, actual, target) =>
    '<div style="margin-bottom:11px">' +
    '<div class="row between small"><span>' + esc(label) + "</span>" +
    '<span class="bold">' + actual + " / " + target + " · " + rate + "%</span></div>" +
    '<div class="progress" style="margin-top:4px"><i style="width:' + Math.min(100, rate) + '%"></i></div>' +
    "</div>";
  const pass = a.status === "达标";
  return (
    '<div class="card">' +
    '<div class="card-title"><h3>片区考核完成度</h3>' +
    '<span class="more">' +
    (pass ? '<span class="badge green">达标 ' : '<span class="badge gold">未达标 ') + a.score + " 分</span></span></div>" +
    row("本月 GMV", a.gmvRate, money(a.monthGmv), money(t.monthly_gmv_target)) +
    row("本月订单量", a.orderRate, (a.monthOrders ?? 0) + " 单", (t.monthly_orders_target ?? 0) + " 单") +
    row("活跃业务员", a.salesRate, (a.salesCount ?? 0) + " 人", (t.active_sales_target ?? 0) + " 人") +
    '<div class="tiny faint">考核指标由平台「规则配置中心 · 代理考核指标」统一下发，达标线 ' +
    esc(t.pass_score ?? 80) + " 分。</div>" +
    "</div>"
  );
}

function noticeHtml(n) {
  return (
    '<div class="notice">' +
    '<div class="t">' + (n.pinned ? '<span class="badge gold">置顶</span>' : "") + esc(n.title) + "</div>" +
    (n.content ? '<div class="c">' + esc(n.content) + "</div>" : "") +
    '<div class="d">' + fmtDate(n.created_at, "date") + "</div></div>"
  );
}

/** 家长列表：按片区订单聚合家长（真实数据，无独立接口时的前端聚合降级） */
async function openParentsSheet() {
  const res = sheet("片区家长列表", loadingHtml("聚合片区订单中的家长…"), [{ label: "关闭", class: "btn-outline" }]);
  const box = res.el.querySelector(".sheet-body");
  try {
    const d = await GET("/api/agent/orders");
    const list = d.list || [];
    const map = new Map();
    list.forEach((o) => {
      const p = o.parent;
      if (!p) return;
      const cur = map.get(p.id) || { id: p.id, nickname: p.nickname, phone: p.phone, orders: 0, gmv: 0, lastAt: null, statuses: {} };
      cur.orders += 1;
      cur.gmv += Number(o.amount || 0);
      if (!cur.lastAt || o.createdAt > cur.lastAt) cur.lastAt = o.createdAt;
      cur.statuses[o.status] = (cur.statuses[o.status] || 0) + 1;
      map.set(p.id, cur);
    });
    const rows = [...map.values()].sort((x, y) => y.gmv - x.gmv);
    if (!rows.length) { box.innerHTML = emptyHtml("片区还没有成交家长", "👨‍👩‍👦"); return; }
    box.innerHTML =
      '<div class="tiny faint mb12">按片区订单聚合，共 ' + rows.length + " 位家长 · 手机号为脱敏值</div>" +
      '<div class="stagger">' +
      rows.slice(0, 30).map((x) =>
        '<div class="list-item" style="cursor:default">' +
        avatar(x.nickname) +
        '<div class="grow"><div class="row between"><b class="small">' + esc(x.nickname || "家长") + "</b>" +
        '<span class="money" style="font-size:13px">' + money(x.gmv) + "</span></div>" +
        '<div class="meta">' + esc(x.phone || "-") + " · 订单 " + x.orders + " 笔</div>" +
        '<div class="tiny faint mt8">最近下单 ' + fmtDate(x.lastAt, "date") + "</div></div></div>"
      ).join("") +
      "</div>" +
      '<div class="hint green small mt12">家长联系方式由平台脱敏，代理仅可在订单处理场景内使用。</div>';
  } catch (e) {
    box.innerHTML = emptyHtml(e.message || "家长数据加载失败", "⚠️");
  }
}

/* ============================ 4.2 业务员管理 ============================ */
async function pageSales() {
  if (!guard()) return;
  clearLayers();
  setHeader({
    title: "业务员管理",
    sub: "团队业绩 · 账号启停",
    refresh: true,
    action: '<button class="icon-btn" id="addSalesTop" aria-label="新增业务员">＋</button>',
  });
  $body.innerHTML =
    '<div class="card tight">' +
    '<div class="toolbar">' +
    '<input class="input" id="kwInput" type="search" placeholder="搜索姓名 / 电话 / 编号" value="' + esc(state.kw) + '">' +
    '<button class="btn btn-sm btn-primary" id="addSalesBtn" type="button">新增</button>' +
    "</div>" +
    '<div class="row wrap mt12" style="gap:6px" id="statusChips">' +
    '<button class="chip ' + (state.salesStatus === "" ? "on" : "") + '" data-status="">全部</button>' +
    '<button class="chip ' + (state.salesStatus === "active" ? "on" : "") + '" data-status="active">在职</button>' +
    '<button class="chip ' + (state.salesStatus === "disabled" ? "on" : "") + '" data-status="disabled">已停用</button>' +
    "</div></div>" +
    '<div class="card"><div class="card-title"><h3>团队成员</h3><span class="more" id="listCount"></span></div>' +
    '<div id="salesList"></div></div>' +
    '<div class="card tight"><div class="row between"><span class="small faint">团队数据说明</span>' +
    '<span class="badge green">实时</span></div>' +
    '<div class="tiny faint mt8">本月业绩按已支付订单金额统计；客户数含扫码与自然绑定客户。</div></div>';

  const listBox = $body.querySelector("#salesList");
  const countBox = $body.querySelector("#listCount");
  let current = [];

  const renderBar = (summary) => {
    setSubBar(
      '<div class="grow"><div class="tiny faint">团队总业绩</div>' +
      '<div class="small bold">' + money(summary.monthGmv) + "</div></div>" +
      '<div><div class="tiny faint">活跃业务员</div>' +
      '<div class="small bold">' + (summary.active ?? 0) + " / " + (summary.total ?? 0) + "</div></div>" +
      '<div style="text-align:right"><div class="tiny faint">本月新增</div>' +
      '<div class="small bold">' + (summary.monthNew ?? 0) + " 人</div></div>"
    );
  };

  const paint = () => {
    countBox.textContent = current.length + " 人";
    if (!current.length) {
      listBox.innerHTML = emptyHtml(
        state.kw || state.salesStatus ? "没有匹配的业务员" : "片区还没有业务员，点击「新增」开通账号",
        "👥"
      );
      return;
    }
    listBox.innerHTML =
      '<div class="stagger">' +
      current.map((s, i) =>
        '<div class="list-item" data-sales="' + i + '" role="button" tabindex="0">' +
        avatar(s.nickname) +
        '<div class="grow">' +
        '<div class="row between"><div class="title ellipsis">' + esc(s.nickname) + "</div>" +
        '<span class="badge ' + (s.status === "active" ? "green" : "gray") + '">' +
        (s.status === "active" ? "在职" : "已停用") + "</span></div>" +
        '<div class="meta">工号 ' + esc(s.code) + " · " + esc(s.phone) + "</div>" +
        '<div class="row between mt8"><span class="tag pos">本月 ' + money(s.monthGmv) + "</span>" +
        '<span class="tiny faint">订单 ' + s.dealCount + " · 客户 " + s.customerCount + "</span></div>" +
        '<div class="tiny faint mt8">入职 ' + fmtDate(s.joinedAt, "date") + "</div>" +
        "</div></div>"
      ).join("") +
      "</div>";
    listBox.querySelectorAll("[data-sales]").forEach((el) => {
      const s = current[Number(el.dataset.sales)];
      const open = () => openSalesDetail(s, () => router.render());
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    });
  };

  const load = async () => {
    listBox.innerHTML = loadingHtml("加载业务员…");
    try {
      const d = await GET("/api/agent/sales", { keyword: state.kw || undefined, status: state.salesStatus || undefined });
      current = d.list || [];
      paint();
      renderBar(d.summary || {});
    } catch (e) {
      listBox.innerHTML = emptyHtml(e.message || "业务员加载失败", "⚠️");
      renderBar({});
    }
  };

  let timer = null;
  $body.querySelector("#kwInput").addEventListener("input", (e) => {
    state.kw = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(load, 320);
  });
  $body.querySelectorAll("[data-status]").forEach((b) =>
    b.addEventListener("click", () => {
      state.salesStatus = b.dataset.status;
      $body.querySelectorAll("[data-status]").forEach((x) => x.classList.toggle("on", x.dataset.status === state.salesStatus));
      load();
    })
  );
  const openAdd = () => openAddSales(() => router.render());
  $body.querySelector("#addSalesBtn").addEventListener("click", openAdd);
  $hdr.querySelector("#addSalesTop")?.addEventListener("click", openAdd);

  await load();
}

function openAddSales(onDone) {
  const res = sheet(
    "新增业务员",
    '<div class="field"><label for="asName">姓名<span class="req">*</span></label>' +
    '<input class="input" id="asName" placeholder="业务员真实姓名" autocomplete="off"></div>' +
    '<div class="field"><label for="asPhone">手机号<span class="req">*</span></label>' +
    '<input class="input" id="asPhone" type="tel" inputmode="numeric" placeholder="11 位手机号" autocomplete="off"></div>' +
    '<div class="hint small">开通后系统生成初始密码，业务员首次登录后可自行修改。</div>' +
    '<button class="btn btn-primary btn-block mt16" id="asSave" type="button">创建账号</button>',
    [{ label: "取消", class: "btn-outline" }]
  );
  res.el.querySelector("#asSave").addEventListener("click", async (e) => {
    const nickname = res.el.querySelector("#asName").value.trim();
    const phone = res.el.querySelector("#asPhone").value.trim();
    if (!nickname) return toastErr("请填写姓名");
    if (!/^1\d{10}$/.test(phone)) return toastErr("请填写正确的 11 位手机号");
    setBusy(e.currentTarget, true, "创建中…");
    try {
      const r = await POST("/api/agent/sales", { nickname, phone });
      res.close();
      toastOk("业务员账号已创建");
      sheet(
        "账号创建成功",
        '<div class="kv"><span class="k">姓名</span><span class="v">' + esc(nickname) + "</span></div>" +
        '<div class="kv"><span class="k">手机号</span><span class="v">' + esc(phone) + "</span></div>" +
        '<div class="kv"><span class="k">初始密码</span><span class="v" style="font-size:16px;color:var(--brand-dark);letter-spacing:1px">' +
        esc(r.initialPassword || "-") + "</span></div>" +
        '<div class="hint green small mt12">请将初始密码告知业务员，首次登录后建议立即修改密码。</div>',
        [{ label: "知道了", class: "btn-primary" }]
      );
      onDone && onDone();
    } catch (err) {
      toastErr(err.message || "创建失败");
      setBusy(e.currentTarget, false);
    }
  });
}

async function openSalesDetail(s, onDone) {
  const res = sheet("业务员详情", loadingHtml("加载业务员档案…"), [{ label: "关闭", class: "btn-outline" }]);
  const box = res.el.querySelector(".sheet-body");
  try {
    const d = await GET("/api/agent/sales/" + encodeURIComponent(s.userId));
    const sp = d.sales || {};
    const rewards = d.rewards || [];
    const orders = d.orders || [];
    const rewardSum = rewards.reduce((a, b) => a + Number(b.total || 0), 0);
    box.innerHTML =
      '<div class="row" style="gap:12px">' + avatar(sp.nickname || s.nickname, null, "lg") +
      '<div class="grow"><div class="row between"><b style="font-size:16px">' + esc(sp.nickname || s.nickname) + "</b>" +
      '<span class="badge ' + (sp.status === "active" ? "green" : "gray") + '">' +
      (sp.status === "active" ? "在职" : "已停用") + "</span></div>" +
      '<div class="tiny faint">工号 ' + esc(sp.code || "-") + " · " + esc(sp.phone || "-") + "</div></div></div>" +
      '<div class="divider"></div>' +
      '<div class="kv"><span class="k">本月业绩</span><span class="v">' + money(s.monthGmv) + "</span></div>" +
      '<div class="kv"><span class="k">有效订单</span><span class="v">' + s.dealCount + " 单</span></div>" +
      '<div class="kv"><span class="k">客户数</span><span class="v">' + (d.customers ?? s.customerCount) + " 人</span></div>" +
      '<div class="kv"><span class="k">入职时间</span><span class="v">' + fmtDate(sp.joined_at, "date") + "</span></div>" +
      '<div class="kv"><span class="k">累计奖励</span><span class="v">' + money(rewardSum) + "</span></div>" +
      '<div class="divider"></div>' +
      '<div class="tiny faint mb8">奖励构成</div>' +
      (rewards.length
        ? rewards.map((r) =>
            '<div class="kv"><span class="k">' + esc(rewardLabel(r.type)) + " · " + r.c + " 笔</span>" +
            '<span class="v">' + money(r.total) + "</span></div>"
          ).join("")
        : '<div class="tiny faint">暂无奖励记录</div>') +
      '<div class="divider"></div>' +
      '<div class="tiny faint mb8">最近订单</div>' +
      (orders.length
        ? orders.slice(0, 6).map((o) =>
            '<div class="kv"><span class="k">' + esc(o.order_no) + "</span>" +
            '<span class="v">' + money(o.amount) + "</span></div>"
          ).join("")
        : '<div class="tiny faint">暂无订单</div>') +
      '<button class="btn ' + (sp.status === "active" ? "btn-danger" : "btn-primary") +
      ' btn-block mt16" id="toggleSales" type="button">' +
      (sp.status === "active" ? "停用该业务员" : "恢复启用") + "</button>" +
      '<div class="tiny faint mt8 center">停用后该业务员无法登录与推广，历史客户归属不变。</div>';

    box.querySelector("#toggleSales").addEventListener("click", async (e) => {
      const toDisable = sp.status === "active";
      const okc = await confirmDialog(
        toDisable ? "停用业务员" : "恢复启用",
        toDisable
          ? "停用后该业务员无法登录、无法生成新推广码绑定客户。确定停用？"
          : "恢复后该业务员可继续登录并推广。确定恢复？",
        toDisable ? "确认停用" : "确认恢复",
        toDisable
      );
      if (!okc) return;
      setBusy(e.currentTarget, true, "处理中…");
      try {
        const r = await POST("/api/agent/sales/" + encodeURIComponent(s.userId) + "/toggle");
        toastOk(r.status === "active" ? "已恢复启用" : "已停用");
        res.close();
        onDone && onDone();
      } catch (err) {
        toastErr(err.message || "操作失败");
        setBusy(e.currentTarget, false);
      }
    });
  } catch (e) {
    box.innerHTML = emptyHtml(e.message || "业务员档案加载失败", "⚠️");
  }
}

const REWARD_TYPE_LABEL = {
  register: "注册奖",
  lead: "留资奖",
  deal: "成交提成",
  daily_champ: "日冠军奖",
  weekly_champ: "周冠军奖",
  newbie_first: "新人首单奖",
};
function rewardLabel(type) { return REWARD_TYPE_LABEL[type] || type; }

/* ============================ 4.3 片区订单管理 ============================ */
async function pageOrders() {
  if (!guard()) return;
  clearLayers();
  setHeader({ title: "片区订单", sub: "状态 · 时间筛选 · 报表导出", back: true, refresh: true });
  $body.innerHTML =
    '<div class="card tight">' +
    '<div class="field" style="margin-bottom:10px"><label for="oStatus">订单状态</label>' +
    '<select class="select" id="oStatus">' +
    ORDER_STATUS_OPTIONS.map((o) =>
      '<option value="' + o.value + '"' + (state.orderStatus === o.value ? " selected" : "") + ">" + o.label + "</option>"
    ).join("") +
    "</select></div>" +
    '<div class="field-row" style="margin-bottom:10px">' +
    '<div><label class="tiny faint" for="oFrom">开始日期</label>' +
    '<input class="input" id="oFrom" type="date" value="' + esc(state.orderFrom) + '"></div>' +
    '<div><label class="tiny faint" for="oTo">结束日期</label>' +
    '<input class="input" id="oTo" type="date" value="' + esc(state.orderTo) + '"></div>' +
    "</div>" +
    '<div class="btn-row"><button class="btn btn-sm btn-outline" id="oReset" type="button">重置</button>' +
    '<button class="btn btn-sm btn-primary" id="oSearch" type="button">查询</button></div>' +
    "</div>" +
    '<div class="card tight"><div class="row between">' +
    '<div><div class="small bold">订单报表</div><div class="tiny faint">导出本片区全部订单（CSV，含科目/金额/分成）</div></div>' +
    '<button class="btn btn-sm btn-ghost" id="exportBtn" type="button">导出报表</button></div></div>' +
    '<div class="card"><div class="card-title"><h3>订单列表</h3><span class="more" id="orderCount"></span></div>' +
    '<div id="orderList"></div></div>' +
    '<div class="hint green small">上门地址为平台脱敏值，完整地址仅对成单教员在服务期间开放。</div>';

  const listBox = $body.querySelector("#orderList");
  const countBox = $body.querySelector("#orderCount");
  let current = [];

  const paint = () => {
    countBox.textContent = current.length + " 单";
    if (!current.length) { listBox.innerHTML = emptyHtml("没有符合条件的订单", "🧾"); return; }
    listBox.innerHTML =
      '<div class="stagger">' + current.map((o, i) => orderCardHtml(o, i)).join("") + "</div>";
    listBox.querySelectorAll("[data-order]").forEach((el) => {
      const o = current[Number(el.dataset.order)];
      const open = () => openOrderDetail(o);
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    });
  };

  const load = async () => {
    listBox.innerHTML = loadingHtml("加载片区订单…");
    try {
      const d = await GET("/api/agent/orders", {
        status: state.orderStatus || undefined,
        from: state.orderFrom || undefined,
        to: state.orderTo || undefined,
      });
      current = d.list || [];
      paint();
    } catch (e) {
      listBox.innerHTML = emptyHtml(e.message || "订单加载失败", "⚠️");
      countBox.textContent = "";
    }
  };

  $body.querySelector("#oSearch").addEventListener("click", () => {
    state.orderStatus = $body.querySelector("#oStatus").value;
    state.orderFrom = $body.querySelector("#oFrom").value;
    state.orderTo = $body.querySelector("#oTo").value;
    load();
  });
  $body.querySelector("#oReset").addEventListener("click", () => {
    state.orderStatus = "";
    state.orderFrom = "";
    state.orderTo = "";
    $body.querySelector("#oStatus").value = "";
    $body.querySelector("#oFrom").value = "";
    $body.querySelector("#oTo").value = "";
    load();
  });
  $body.querySelector("#exportBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    setBusy(btn, true, "导出中…");
    try {
      const res = await fetch("/api/agent/orders/export", {
        headers: { Authorization: "Bearer " + session.token },
      });
      if (!res.ok) throw new Error(res.status === 401 ? "登录已失效，请重新登录" : "导出失败（" + res.status + "）");
      const blob = await res.blob();
      downloadBlob(blob, "region-orders.csv");
      toastOk("订单报表已导出");
      setBusy(btn, false);
    } catch (err) {
      toastErr(err.message || "导出失败");
      setBusy(btn, false);
    }
  });

  await load();
}

function orderCardHtml(o, i) {
  return (
    '<div class="card flat tight order-item" data-order="' + i + '" role="button" tabindex="0">' +
    '<div class="row between"><span class="small bold ellipsis">' + esc(o.orderNo) + "</span>" +
    '<span class="badge ' + (ORDER_BADGE[o.status] || "gray") + '">' + esc(o.statusText || o.status) + "</span></div>" +
    '<div class="row between mt8"><span class="small">' + esc(o.subject) + " · " + esc(o.stage) + "</span>" +
    '<span class="money small">' + money(o.amount) + "</span></div>" +
    '<div class="kv"><span class="k">平台服务费</span><span class="v">' + money(o.serviceFee) + "</span></div>" +
    '<div class="kv"><span class="k">片区分成</span><span class="v" style="color:var(--brand-dark)">' + money(o.agentShare) + "</span></div>" +
    '<div class="addr mt8">📍 ' + esc(o.address || "-") + "</div>" +
    '<div class="tiny faint mt8">' + fmtDate(o.createdAt, "time") +
    " · 家长 " + esc(o.parent?.nickname || "-") + " · 教员 " + esc(o.teacher?.nickname || "-") + "</div>" +
    "</div>"
  );
}

function openOrderDetail(o) {
  const rows = [
    ["订单号", esc(o.orderNo)],
    ["订单状态", esc(o.statusText || o.status)],
    ["科目 / 学段", esc(o.subject) + " · " + esc(o.stage)],
    ["实付金额", money(o.amount)],
    ["平台服务费", money(o.serviceFee)],
    ["片区分成", money(o.agentShare)],
    ["教员课酬", money(o.teacherIncome)],
    ["平台留存", money(o.platformRevenue)],
    ["抽佣比例", (Number(o.commissionRate || 0) * 100).toFixed(0) + "%"],
    ["上课时间", fmtDate(o.lessonTime, "time")],
    ["上门地址（脱敏）", esc(o.address || "-")],
    ["家长", esc(o.parent?.nickname || "-") + " · " + esc(o.parent?.phone || "-")],
    ["教员", esc(o.teacher?.nickname || "-") + " · " + esc(o.teacher?.phone || "-")],
    ["支付时间", o.paidAt ? fmtDate(o.paidAt, "time") : "-"],
    ["打卡时间", o.checkinAt ? fmtDate(o.checkinAt, "time") : "-"],
    ["创建时间", fmtDate(o.createdAt, "time")],
    ["取消方", o.cancelBy ? (o.cancelBy === "parent" ? "家长" : "教员") : "-"],
    ["取消原因", esc(o.cancelReason || "-")],
    ["退款金额", money(o.refundAmount)],
    ["违约金", money(o.penalty)],
  ];
  sheet(
    "订单详情",
    rows.map((r) => '<div class="kv"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + "</span></div>").join(""),
    [{ label: "关闭", class: "btn-outline" }]
  );
}

/* ============================ 4.4 收益结算 ============================ */
async function pageEarnings() {
  if (!guard()) return;
  clearLayers();
  setHeader({ title: "收益结算", sub: "分成构成 · 账单 · 提现", refresh: true });
  $body.innerHTML = loadingHtml("加载收益数据…");
  const [d, w] = await Promise.all([GET("/api/agent/earnings"), GET("/api/wallet")]);
  const wallet = d.wallet || w.wallet || { balance: 0, frozen: 0, totalIncome: 0, totalWithdraw: 0 };
  const rule = d.rule || {};
  const wRule = w.rule || {};
  const comp = d.composition || {};
  const bills = d.bills || [];
  const withdrawals = d.withdrawals || [];

  const compItems = [
    { k: "feeShare", label: "服务费分成", color: "#10b98b" },
    { k: "mgmt", label: "管理提成", color: "#f5a623" },
    { k: "bonus", label: "活动奖励", color: "#257bff" },
  ];
  const compVals = compItems.map((x) => Math.max(0, Number(comp[x.k] || 0)));
  const compTotal = compVals.reduce((a, b) => a + b, 0);
  let acc = 0;
  const stops = [];
  compItems.forEach((x, i) => {
    const p = compTotal > 0 ? (compVals[i] / compTotal) * 100 : 0;
    const from = acc;
    acc += p;
    stops.push(x.color + " " + from.toFixed(2) + "% " + acc.toFixed(2) + "%");
  });
  const donutStyle = compTotal > 0 ? "background:conic-gradient(" + stops.join(",") + ")" : "background:#edf0f5";

  $body.innerHTML =
    '<div class="op-hero">' +
    '<div class="hero-kicker">累计可结算收益</div>' +
    '<div class="hero-title" style="font-size:26px">' + money(d.totalIncome) + "</div>" +
    '<div class="hero-sub">本月分成 ' + money(d.monthShare) + " · 待结算 " + money(d.pending) + "</div>" +
    '<div class="hero-stats">' +
    '<div><b class="long">' + money(d.pending) + "</b><span>待结算</span></div>" +
    '<div><b class="long">' + money(wallet.totalWithdraw) + "</b><span>已提现</span></div>" +
    '<div><b class="long">' + money(wallet.balance) + "</b><span>可提现余额</span></div>" +
    "</div></div>" +
    '<div class="card"><div class="card-title"><h3>收益构成</h3><span class="badge gray">已结算订单</span></div>' +
    '<div class="donut-wrap">' +
    '<div class="donut" style="' + donutStyle + '"><div class="center-label"><div>' +
    "<b>" + shortMoney(compTotal) + "</b><span>构成合计</span></div></div></div>" +
    '<div class="legend">' +
    compItems.map((x, i) =>
      '<div class="lg"><span class="dot" style="background:' + x.color + '"></span>' +
      "<span>" + x.label + "</span>" +
      '<span class="val">' + money(compVals[i]) + "</span>" +
      '<span class="tiny faint" style="width:34px;text-align:right">' +
      (compTotal > 0 ? Math.round((compVals[i] / compTotal) * 100) : 0) + "%</span></div>"
    ).join("") +
    "</div></div>" +
    '<div class="tiny faint mt12">构成口径：服务费 × 分成比例、订单实付 × 管理提成比例、团队冠亚军奖励（平台已结算部分）。三项与账单口径独立，仅用于结构分析。</div>' +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>结算规则</h3></div>' +
    '<div class="kv"><span class="k">月度结算周期</span><span class="v">每月 ' + (rule.bill_day ?? "-") + " 日出账单</span></div>" +
    '<div class="kv"><span class="k">提现开放日</span><span class="v">每月 ' + (rule.bill_day ?? "-") + " 日起</span></div>" +
    '<div class="kv"><span class="k">服务费分成比例</span><span class="v">' + ratePct(rule.fee_share_rate) + "</span></div>" +
    '<div class="kv"><span class="k">管理提成比例</span><span class="v">' + ratePct(rule.mgmt_rate) + "</span></div>" +
    '<div class="kv"><span class="k">提现最低额</span><span class="v">' + money(wRule.min_withdraw) + "</span></div>" +
    '<div class="kv"><span class="k">提现手续费</span><span class="v">' + ratePct(wRule.withdraw_fee_rate) + "</span></div>" +
    '<div class="hint green small mt8">订单确认完成后计入待结算，账单日生成账单并转入可提现余额。</div>' +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>历史账单</h3><span class="more">近 6 个月</span></div>' +
    (bills.length
      ? '<div class="stagger">' + bills.map((b) =>
          '<div class="list-item" style="cursor:default"><div class="grow">' +
          '<div class="row between"><b class="small">' + esc(b.month) + " 账单</b>" +
          '<span class="money" style="font-size:13px">' + money(b.amount) + "</span></div>" +
          '<div class="meta">订单 ' + b.orders + " 单 · 账单日 " + (b.billDay ?? "-") + " 号</div>" +
          '<div class="mt8"><span class="badge ' + (b.status === "结算中" ? "gold" : "green") + '">' +
          esc(b.status) + "</span></div></div></div>"
        ).join("") + "</div>"
      : emptyHtml("暂无历史账单", "📄")) +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>提现记录</h3><span class="more">' + withdrawals.length + " 条</span></div>" +
    (withdrawals.length
      ? '<div class="stagger">' + withdrawals.slice(0, 6).map(wdItemHtml).join("") + "</div>"
      : emptyHtml("还没有提现记录", "🧾")) +
    "</div>" +
    '<div class="hint green small">演示环境数据来自本地 SQLite 演示库，所有金额单位为元。</div>';

  setSubBar(
    '<button class="btn btn-primary" id="applyWd" type="button">申请提现</button>'
  );
  $shell.querySelector("#applyWd").addEventListener("click", () =>
    openWithdrawSheet(wallet, wRule, () => router.render())
  );
}

function wdItemHtml(x) {
  const st = WD_STATUS[x.status] || [x.status, "gray"];
  return (
    '<div class="list-item" style="cursor:default"><div class="grow">' +
    '<div class="row between"><b class="small">提现 ' + money(x.amount) + "</b>" +
    '<span class="badge ' + st[1] + '">' + esc(st[0]) + "</span></div>" +
    '<div class="meta">' + esc(CHANNEL_LABEL[x.channel] || x.channel) + " · " + esc(x.account || "-") +
    " · 手续费 " + money(x.fee) + "</div>" +
    '<div class="tiny faint mt8">申请 ' + fmtDate(x.created_at, "time") + " · 到账 " + money(x.actual) + "</div>" +
    (x.status === "rejected" && x.reject_reason
      ? '<div class="tiny mt8" style="color:var(--danger)">驳回原因：' + esc(x.reject_reason) + "</div>"
      : "") +
    "</div></div>"
  );
}

function openWithdrawSheet(wallet, rule, onDone) {
  const min = Number(rule.min_withdraw || 0);
  const rate = Number(rule.withdraw_fee_rate || 0);
  const res = sheet(
    "申请提现",
    '<div class="card flat tight" style="background:#f8fbfa;margin-bottom:14px">' +
    '<div class="kv"><span class="k">可提现余额</span><span class="v">' + money(wallet.balance) + "</span></div>" +
    '<div class="kv"><span class="k">冻结中</span><span class="v">' + money(wallet.frozen) + "</span></div>" +
    '<div class="kv"><span class="k">最低提现 / 手续费</span><span class="v">' + money(min) + " / " + ratePct(rate) + "</span></div>" +
    "</div>" +
    '<div class="field"><label for="awAmount">提现金额（元）<span class="req">*</span></label>' +
    '<input class="input" id="awAmount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00"></div>' +
    '<div class="field"><label>收款方式</label>' +
    '<div class="segmented" id="awChannel" role="group" aria-label="收款方式">' +
    '<button type="button" data-ch="wechat" class="on">微信</button>' +
    '<button type="button" data-ch="bank">银行卡</button></div></div>' +
    '<div class="field"><label for="awAccount">收款账号<span class="req">*</span></label>' +
    '<input class="input" id="awAccount" placeholder="微信：微信号 / 手机号；银行卡：卡号"></div>' +
    '<div class="card flat tight" style="background:#f8fbfa;margin-bottom:14px">' +
    '<div class="kv"><span class="k">手续费（' + ratePct(rate) + '）</span><span class="v" id="awFee">¥0.00</span></div>' +
    '<div class="kv"><span class="k">预计到账</span><span class="v" id="awNet">¥0.00</span></div></div>' +
    '<button class="btn btn-primary btn-block" id="awSubmit" type="button">提交提现申请</button>' +
    '<div class="tiny faint mt8 center">提交后由平台审核打款，账号信息脱敏保存。</div>',
    [{ label: "取消", class: "btn-outline" }]
  );
  const amountEl = res.el.querySelector("#awAmount");
  const accountEl = res.el.querySelector("#awAccount");
  const feeEl = res.el.querySelector("#awFee");
  const netEl = res.el.querySelector("#awNet");
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

  res.el.querySelectorAll("#awChannel [data-ch]").forEach((b) =>
    b.addEventListener("click", () => {
      channel = b.dataset.ch;
      res.el.querySelectorAll("#awChannel [data-ch]").forEach((x) => x.classList.toggle("on", x.dataset.ch === channel));
      accountEl.placeholder = channel === "wechat" ? "微信：微信号 / 手机号" : "银行卡：卡号";
    })
  );

  res.el.querySelector("#awSubmit").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const amount = currentAmount();
    if (!Number.isFinite(amount) || amount <= 0) return toastErr("请输入提现金额");
    if (amount < min) return toastErr("最低提现 " + money(min));
    if (amount > wallet.balance) return toastErr("可提现余额不足");
    const account = accountEl.value.trim();
    if (!account) return toastErr("请填写收款账号");
    const fee = Math.round(amount * rate);
    const okc = await confirmDialog(
      "提交提现申请",
      "提现 " + money(amount) + "，手续费 " + money(fee) + "，预计到账 " + money(amount - fee) +
      "。提交后由平台审核打款。",
      "确认提交"
    );
    if (!okc) return;
    setBusy(btn, true, "提交中…");
    try {
      await POST("/api/withdrawals", { amount, channel, account }, { idem: idemKey("wd") });
      res.close();
      toastOk("提现申请已提交，等待审核");
      onDone && onDone();
    } catch (err) {
      toastErr(err.message || "提现申请失败");
      setBusy(btn, false);
    }
  });
}

/* ============================ 4.4 订单风控 ============================ */
async function pageRisk() {
  if (!guard()) return;
  clearLayers();
  setHeader({ title: "片区风控", sub: "异常订单 · 客诉工单 · 平台复核", refresh: true });
  $body.innerHTML = loadingHtml("加载风控数据…");
  const [r, c] = await Promise.all([GET("/api/agent/risks"), GET("/api/agent/complaints")]);
  const stats = r.stats || {};
  const events = r.events || [];
  const complaints = c.list || [];
  const highCancel = r.highCancel || [];
  const score = Number(r.score || 0);
  const deg = Math.round(-90 + (Math.min(100, Math.max(0, score)) * 180) / 100);
  const levelStyle = r.level === "低风险" ? "green" : r.level === "中风险" ? "gold" : "danger";

  $body.innerHTML =
    '<div class="stat-grid">' +
    '<div class="stat"><div class="label">异常订单</div><div class="value">' + (stats.abnormal ?? 0) + "<small>笔</small></div></div>" +
    '<div class="stat"><div class="label">疑似刷单</div><div class="value">' + (stats.brush ?? 0) + "<small>笔</small></div></div>" +
    '<div class="stat"><div class="label">投诉工单</div><div class="value">' + (stats.complaints ?? 0) + "<small>条</small></div></div>" +
    '<div class="stat"><div class="label">高风险用户</div><div class="value">' + (stats.highRisk ?? 0) + "<small>人</small></div></div>" +
    "</div>" +
    '<div class="card gauge-panel mt16"><div class="card-title" style="justify-content:center"><h3>片区风险指数</h3></div>' +
    '<div class="gauge-wrap"><div class="gauge">' +
    '<div class="arc"></div>' +
    '<div class="needle" style="transform:rotate(' + deg + 'deg)"></div>' +
    "</div>" +
    '<div class="score">' + score + "<small> / 100</small></div></div>" +
    '<div class="gauge-scale"><span>0 高危</span><span>100 安全</span></div>' +
    '<div class="row" style="justify-content:center;gap:8px;margin-top:8px">' +
    '<span class="badge ' + levelStyle + '">' + esc(r.level || "-") + "</span>" +
    '<span class="tiny faint">分数越高越安全，按异常 / 高风险 / 工单数量扣分</span></div>' +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>异常订单</h3>' +
    '<span class="more">' + events.length + " 条</span></div>" +
    (events.length
      ? '<div class="stagger" id="riskList">' + events.map(riskItemHtml).join("") + "</div>"
      : emptyHtml("片区暂无风险事件", "🛡️")) +
    '<div class="tiny faint mt8">点击条目选中后再提交平台复核，上报后相关订单结算将被冻结。</div>' +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>高频取消家长</h3>' +
    '<span class="badge gray">阈值触发</span></div>' +
    (highCancel.length
      ? '<div class="stagger">' + highCancel.map((x) =>
          '<div class="list-item" style="cursor:default"><div class="grow">' +
          '<div class="row between"><b class="small">' + esc(x.nickname || "家长") + "</b>" +
          '<span class="badge danger">取消 ' + x.c + " 次</span></div>" +
          '<div class="meta">多次取消订单，建议关注需求真实性与沟通记录</div></div></div>'
        ).join("") + "</div>"
      : emptyHtml("暂无高频取消家长", "✅")) +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>客诉工单</h3>' +
    '<span class="more">' + complaints.length + " 条</span></div>" +
    (complaints.length
      ? '<div class="stagger" id="cmplList">' + complaints.map(cmplItemHtml).join("") + "</div>"
      : emptyHtml("暂无客诉工单", "📮")) +
    "</div>" +
    '<div class="hint green small">风控数据仅在当前片区范围内可见；上报平台后由平台仲裁并决定退款与结算处理。</div>';

  // 风险事件选择
  const paintSel = () => {
    $body.querySelectorAll("[data-risk-id]").forEach((el) => {
      const on = String(state.riskId) === el.dataset.riskId;
      el.classList.toggle("sel", on);
      const tick = el.querySelector(".tick");
      if (tick) tick.textContent = on ? "✓" : "";
      el.setAttribute("aria-pressed", String(on));
    });
    const btn = $shell.querySelector("#escalateBtn");
    if (btn) btn.disabled = !state.riskId;
  };
  $body.querySelectorAll("[data-risk-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.riskId);
      state.riskId = state.riskId === id ? null : id;
      paintSel();
    });
  });

  setSubBar(
    '<button class="btn btn-outline" id="exportRisk" type="button">导出报告</button>' +
    '<button class="btn btn-primary" id="escalateBtn" type="button"' + (state.riskId ? "" : " disabled") +
    ">提交平台复核</button>"
  );
  paintSel();

  $shell.querySelector("#exportRisk").addEventListener("click", (e) => {
    try {
      exportRiskCsv(r);
      toastOk("风控报告已导出");
    } catch (err) {
      toastErr(err.message || "导出失败");
    }
  });
  $shell.querySelector("#escalateBtn").addEventListener("click", async (e) => {
    if (!state.riskId) return toastErr("请先选中一条风险事件");
    const okc = await confirmDialog(
      "提交平台复核",
      "事件 #" + state.riskId + " 将上报平台风控，并冻结相关订单结算。确定上报？",
      "确认上报"
    );
    if (!okc) return;
    setBusy(e.currentTarget, true, "上报中…");
    try {
      await POST("/api/agent/risks/" + state.riskId + "/escalate");
      state.riskId = null;
      toastOk("已上报平台复核");
      await router.render();
    } catch (err) {
      toastErr(err.message || "上报失败");
      setBusy(e.currentTarget, false);
    }
  });

  // 客诉工单操作
  const cmplBox = $body.querySelector("#cmplList");
  if (cmplBox) {
    cmplBox.querySelectorAll("[data-cmpl]").forEach((el) => {
      const item = complaints[Number(el.dataset.cmpl)];
      const open = () => openComplaint(item, () => router.render());
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    });
  }
}

function riskItemHtml(e, i) {
  const st = RISK_STATUS[e.status] || [e.status, "gray"];
  return (
    '<div class="list-item risk-item" data-risk-id="' + e.id + '" role="button" tabindex="0" aria-pressed="false">' +
    '<div class="grow">' +
    '<div class="row between"><b class="small ellipsis">' + esc(e.order_no || "事件 #" + e.id) + "</b>" +
    '<span class="row" style="gap:6px">' +
    '<span class="badge ' + (RISK_LEVEL[e.level] ? RISK_LEVEL[e.level][1] : "gray") + '">' +
    (RISK_LEVEL[e.level] ? RISK_LEVEL[e.level][0] : esc(e.level)) + "</span>" +
    '<span class="badge ' + st[1] + '">' + esc(st[0]) + "</span></span></div>" +
    '<div class="meta">' + esc(RISK_TYPE[e.type] || e.type) + " · " + esc(e.reason || "无异常描述") + "</div>" +
    '<div class="tiny faint mt8">' + fmtDate(e.created_at, "time") +
    (e.nickname ? " · 用户 " + esc(e.nickname) : "") +
    (e.settlement_hold ? " · 已冻结结算" : "") + "</div>" +
    "</div>" +
    '<span class="tick" aria-hidden="true"></span></div>'
  );
}

function cmplItemHtml(x, i) {
  const st = CMPL_STATUS[x.status] || [x.status, "gray"];
  return (
    '<div class="list-item" data-cmpl="' + i + '" role="button" tabindex="0">' +
    '<div class="grow">' +
    '<div class="row between"><b class="small ellipsis">' + esc(x.title) + "</b>" +
    '<span class="badge ' + st[1] + '">' + esc(st[0]) + "</span></div>" +
    '<div class="meta">' + (x.type === "review_appeal" ? "评价申诉" : "客诉工单") +
    " · " + esc(x.fromName || "-") + " · " + (x.from_role === "parent" ? "家长" : "教员") + "</div>" +
    '<div class="tiny faint mt8">' + fmtDate(x.created_at, "time") +
    (x.orderNo ? " · 订单 " + esc(x.orderNo) : "") + "</div>" +
    "</div></div>"
  );
}

function openComplaint(x, onDone) {
  const st = CMPL_STATUS[x.status] || [x.status, "gray"];
  const res = sheet(
    "客诉工单 #" + x.id,
    '<div class="kv"><span class="k">标题</span><span class="v">' + esc(x.title) + "</span></div>" +
    '<div class="kv"><span class="k">类型</span><span class="v">' + (x.type === "review_appeal" ? "评价申诉" : "客诉工单") + "</span></div>" +
    '<div class="kv"><span class="k">提交人</span><span class="v">' + esc(x.fromName || "-") + "（" +
    (x.from_role === "parent" ? "家长" : "教员") + "）</span></div>" +
    '<div class="kv"><span class="k">关联订单</span><span class="v">' + esc(x.orderNo || "-") + "</span></div>" +
    '<div class="kv"><span class="k">当前状态</span><span class="v">' + esc(st[0]) + "</span></div>" +
    '<div class="divider"></div>' +
    '<div class="small muted" style="white-space:pre-wrap;line-height:1.7">' + esc(x.content || "无详细描述") + "</div>" +
    (x.handle_note ? '<div class="hint small mt12">上次处理备注：' + esc(x.handle_note) + "</div>" : "") +
    '<div class="field mt12"><label for="cmNote">处理备注</label>' +
    '<textarea class="textarea" id="cmNote" placeholder="记录沟通过程，上报平台时会同步给管理员">' +
    esc(x.handle_note || "") + "</textarea></div>" +
    '<div class="btn-row">' +
    '<button class="btn btn-sm btn-outline" data-cm="handled" type="button">标记已处理</button>' +
    '<button class="btn btn-sm btn-gold" data-cm="escalate" type="button">上报平台</button></div>' +
    '<button class="btn btn-sm btn-ghost btn-block mt8" data-cm="close" type="button">关闭工单</button>' +
    '<div class="tiny faint mt8">上报平台后由平台仲裁，片区不再单独结案。</div>',
    [{ label: "取消", class: "btn-outline" }]
  );
  const noteEl = res.el.querySelector("#cmNote");
  res.el.querySelectorAll("[data-cm]").forEach((b) =>
    b.addEventListener("click", async () => {
      const action = b.dataset.cm;
      const label = action === "handled" ? "标记已处理" : action === "escalate" ? "上报平台" : "关闭工单";
      const okc = await confirmDialog(
        label,
        action === "escalate"
          ? "工单将上报平台仲裁，同时通知平台管理员。确定上报？"
          : "请确认已与双方沟通并记录处理结果。",
        "确认" + (action === "escalate" ? "上报" : "提交"),
        action === "escalate"
      );
      if (!okc) return;
      setBusy(b, true, "处理中…");
      try {
        await POST("/api/agent/complaints/" + x.id + "/handle", { action, note: noteEl.value.trim() });
        res.close();
        toastOk(label + "成功");
        onDone && onDone();
      } catch (err) {
        toastErr(err.message || "操作失败");
        setBusy(b, false);
      }
    })
  );
}

function exportRiskCsv(r) {
  const head = ["事件ID", "订单号", "风险类型", "风险等级", "异常原因", "状态", "用户", "发生时间"];
  const lines = [head.join(",")];
  (r.events || []).forEach((e) => {
    lines.push([
      e.id,
      e.order_no || "",
      RISK_TYPE[e.type] || e.type,
      RISK_LEVEL[e.level] ? RISK_LEVEL[e.level][0] : e.level,
      e.reason || "",
      RISK_STATUS[e.status] ? RISK_STATUS[e.status][0] : e.status,
      e.nickname || "",
      e.created_at,
    ].map(csvCell).join(","));
  });
  lines.push("");
  lines.push(["高频取消家长", "取消次数"].join(","));
  (r.highCancel || []).forEach((x) => lines.push([x.nickname, x.c].map(csvCell).join(",")));
  lines.push("");
  lines.push(["片区风险指数", r.score, "风险等级", r.level].map(csvCell).join(","));
  const csv = "\uFEFF" + lines.join("\r\n");
  downloadBlob(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
    "risk-report-" + (r.agentName || "region") + "-" + fmtDate(new Date().toISOString(), "date") + ".csv"
  );
}

/* ============================ 4.4.6 公告与设置 ============================ */
async function pageMe() {
  if (!guard()) return;
  clearLayers();
  setHeader({ title: "公告与设置", sub: "账号 · 片区 · 平台公告", refresh: true });
  $body.innerHTML = loadingHtml("加载账号与公告…");
  const [p, ann] = await Promise.all([GET("/api/agent/profile"), GET("/api/agent/announcements")]);
  const a = p.agent || {};
  const region = p.region || {};
  const wallet = p.wallet || {};
  const notices = ann || [];

  $body.innerHTML =
    '<div class="op-hero">' +
    '<div class="row" style="gap:12px">' + avatar(a.name || region.name || "代理", null, "lg") +
    '<div class="grow"><div class="row wrap" style="gap:6px">' +
    '<b style="font-size:16px">' + esc(a.name || "区域代理") + "</b>" +
    '<span class="hero-chip">等级 ' + esc(a.level || "-") + "</span>" +
    '<span class="hero-chip">' + (a.status === "disabled" ? "已停用" : "运营中") + "</span></div>" +
    '<div class="hero-sub">' + esc(region.name || "-") + " · " + esc(a.phone || "-") + "</div></div></div>" +
    '<div class="hero-stats">' +
    '<div><b class="long">' + money(wallet.balance) + "</b><span>可提现</span></div>" +
    '<div><b class="long">' + money(wallet.totalIncome) + "</b><span>累计收益</span></div>" +
    '<div><b>' + ratePct(a.commission_rate) + "</b><span>服务费分成</span></div>" +
    "</div></div>" +
    '<div class="card"><div class="card-title"><h3>账号信息</h3></div>' +
    '<div class="kv"><span class="k">负责人</span><span class="v">' + esc(a.name || "-") + "</span></div>" +
    '<div class="kv"><span class="k">联系电话</span><span class="v">' + esc(a.phone || "-") + "</span></div>" +
    '<div class="kv"><span class="k">所属片区</span><span class="v">' + esc(region.name || "-") + "</span></div>" +
    '<div class="kv"><span class="k">代理等级</span><span class="v">' + esc(a.level || "-") + "</span></div>" +
    '<div class="kv"><span class="k">签约时间</span><span class="v">' + fmtDate(a.signed_at, "date") + "</span></div>" +
    '<div class="kv"><span class="k">保证金</span><span class="v">' + money(a.deposit) + "</span></div>" +
    '<div class="kv"><span class="k">管理提成比例</span><span class="v">' + ratePct(a.mgmt_rate) + "</span></div>" +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>平台公告</h3><span class="more">' + notices.length + " 条</span></div>" +
    (notices.length ? notices.map(noticeHtml).join("") : emptyHtml("暂无公告", "📢")) +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>设置</h3></div>' +
    '<div class="action-item" data-go="/earnings"><span class="ico">💰</span><span class="grow">收益与提现</span><span class="arrow">›</span></div>' +
    '<div class="action-item" data-go="/sales"><span class="ico">👥</span><span class="grow">业务员管理</span><span class="arrow">›</span></div>' +
    '<div class="action-item" data-go="/risk"><span class="ico">🛡️</span><span class="grow">风控与客诉</span><span class="arrow">›</span></div>' +
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
        '<div class="list-item" style="cursor:default"><div class="grow">' +
        '<div class="row between"><b class="small">' + esc(m.title) + "</b>" +
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
  const okc = await confirmDialog("退出登录", "退出后需重新输入账号密码才能进入区域代理工作台。", "退出登录", true);
  if (!okc) return;
  session.clear();
  toastOk("已退出登录");
  await router.render();
}

/* ============================ 路由 ============================ */
router = createRouter(
  {
    "/": pageHome,
    "/sales": pageSales,
    "/orders": pageOrders,
    "/earnings": pageEarnings,
    "/risk": pageRisk,
    "/me": pageMe,
  },
  { onAfter: (path) => renderTabbar(TAB_ALIAS[path] || path) }
);

window.addEventListener("hashchange", () => { $body.scrollTop = 0; });

if (!isAuthed()) renderLogin();
else router.render();
