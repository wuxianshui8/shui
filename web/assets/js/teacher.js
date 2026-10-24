/* ============================================================
   教员端 SPA（哈希路由 · 原生 ES Module）
   流程：上线接单 → 抢单 → 上门定位打卡 → 结束授课 → 结算提现
   所有金额：后端为「分」整数；展示用 money()/yuan()，提交用 cents()
   ============================================================ */
import { api, session, idemKey, loginByCode, loginByPassword, loginByAccount } from "./api.js";
import {
  esc, money, yuan, cents, fmtDate, fromNow, stars, levelBadge, statusBadge,
  avatar, toast, toastOk, toastErr, confirmDialog, promptDialog, sheet,
  createRouter, loadingHtml, emptyHtml, formData,
} from "./ui.js";

/* ---------------- 常量 ---------------- */
const DEFAULT_LAT = 30.2610;
const DEFAULT_LNG = 120.1320;
const IDENTITY = { student: "在校大学生", in_service: "在职教师", part_time: "社会兼职教员" };
const WEEK = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const TXN_LABEL = {
  lesson_income: "课时费到账", freeze: "课时费冻结", unfreeze: "冻结释放", withdraw: "提现",
  withdraw_refund: "提现退回", agent_share: "片区分成", reward: "平台奖励",
};
const WITHDRAW_STATUS = { pending: "审核中", approved: "已通过", paid: "已打款", rejected: "已驳回" };
const APPLIED_STATUS = { pending: "已报名·待家长确认", confirmed: "家长已确认", rejected: "未通过", cancelled: "已取消" };
const TABS = [
  { path: "/", icon: "🎯", label: "接单" },
  { path: "/orders", icon: "📋", label: "订单" },
  { path: "/income", icon: "💰", label: "收入" },
  { path: "/me", icon: "👤", label: "我的" },
];

/* ---------------- 状态 ---------------- */
const state = { unread: 0, dict: null, rules: null, bar: null, actions: {}, orderCache: new Map(), calMonth: "", calDay: "", calView: "month", services: [] };
let ROUTER = null;

/* ---------------- DOM 助手 ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const bodyEl = () => document.querySelector("[data-route]");
const hdrEl = () => document.getElementById("hdr");
const tabbarEl = () => document.getElementById("tabbar");
const shellEl = () => document.querySelector(".m-shell");
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const pct = (v) => (Number(v || 0) * 100).toFixed(1) + "%";
const identityText = (v) => IDENTITY[v] || "教员";

function setBody(html) {
  const el = bodyEl();
  el.innerHTML = html;
  el.scrollTop = 0;
}

/* ---------------- 通用数据 ---------------- */
async function getDict() {
  if (!state.dict) state.dict = await api.get("/api/meta/dictionary");
  return state.dict;
}
async function getRules() {
  if (!state.rules) {
    const list = await api.get("/api/meta/rules-public");
    state.rules = {};
    for (const r of list || []) state.rules[r.key] = r.value;
  }
  return state.rules;
}
async function refreshUnread() {
  if (!session.token) return;
  try {
    const d = await api.get("/api/messages");
    state.unread = d.unread || 0;
  } catch (err) {
    if (err && err.status === 401) showLogin();
  }
}

/* ---------------- 页头 / 底栏 / 操作条 ---------------- */
function bellHtml() {
  return '<button class="icon-btn" data-go="/messages" aria-label="消息中心" title="消息中心">💬' +
    (state.unread ? '<span class="dot"></span>' : "") + "</button>";
}

function layout() {
  const t = tabbarEl();
  const hasTab = t && t.style.display !== "none";
  bodyEl().style.paddingBottom = state.bar ? "104px" : hasTab ? "" : "28px";
}

function chrome({ title = "", sub = "", back = false, tab = null, right = "", plain = false, loc = "" }) {
  const h = hdrEl();
  h.className = "m-header" + (plain ? " plain" : "");
  const bits = [];
  if (back) bits.push('<button class="back-btn" data-back aria-label="返回上一页">‹</button>');
  if (loc) bits.push(loc);
  else bits.push('<div class="grow"><h1>' + esc(title) + "</h1>" + (sub ? '<div class="sub">' + esc(sub) + "</div>" : "") + "</div>");
  if (right) bits.push(right);
  else if (tab && !loc) bits.push(bellHtml());
  h.innerHTML = bits.join("");

  const t = tabbarEl();
  if (tab) {
    t.style.display = "grid";
    t.innerHTML = TABS.map((it) =>
      '<button data-go="' + it.path + '" class="' + (tab === it.path ? "active" : "") + '" aria-current="' + (tab === it.path ? "page" : "false") + '">' +
      '<span class="ico" aria-hidden="true">' + it.icon + "</span>" + it.label + "</button>"
    ).join("");
  } else {
    t.style.display = "none";
    t.innerHTML = "";
  }
  layout();
}

function clearBar() {
  if (state.bar) {
    state.bar.remove();
    state.bar = null;
  }
  layout();
}

function mountBar(html) {
  clearBar();
  const el = document.createElement("div");
  el.className = "action-bar";
  el.innerHTML = html;
  shellEl().appendChild(el);
  state.bar = el;
  layout();
  return el;
}

function setActions(map) {
  state.actions = map || {};
}

function onError(err) {
  if (err && err.status === 401) {
    showLogin();
    return;
  }
  toastErr((err && err.message) || "操作失败，请稍后重试");
}

async function runAction(el) {
  const fn = state.actions[el.dataset.act];
  if (!fn || el.disabled) return;
  const html = el.innerHTML;
  if (el.tagName === "BUTTON") {
    el.disabled = true;
    el.innerHTML = "处理中…";
  }
  try {
    await fn(el);
  } catch (err) {
    onError(err);
  } finally {
    if (el.isConnected) {
      el.disabled = false;
      el.innerHTML = html;
    }
  }
}

/* ---------------- 登录层 ---------------- */
/** 登录方式：code（手机号 + 验证码）/ account（用户名 + 密码） */
let loginMode = "code";

function loginHtml() {
  const modeCode = loginMode === "code";
  return '' +
    '<div class="brandmark" aria-hidden="true">🎓</div>' +
    "<h2>教员端登录</h2>" +
    '<p class="lead">接单大厅 · 服务上架 · 定位打卡 · 等级权益 · 收入提现<br>演示账号 <b>13900000201</b> 或用户名 <b>zhang</b>（张老师 · 已审核 · 在线），口令 a123456</p>' +
    '<div class="segmented mt16" role="tablist">' +
    '<button type="button" class="' + (modeCode ? "on" : "") + '" data-lg="mode-code">手机号验证码</button>' +
    '<button type="button" class="' + (!modeCode ? "on" : "") + '" data-lg="mode-account">用户名密码</button>' +
    "</div>" +
    '<div class="card mt16" style="margin-bottom:0">' +
    (modeCode
      ? ('<div class="field"><label for="lg-phone">手机号</label>' +
        '<input class="input" id="lg-phone" type="tel" inputmode="numeric" maxlength="11" value="13900000201" autocomplete="tel"></div>' +
        '<div class="field"><label for="lg-code">验证码</label><div class="code-row">' +
        '<input class="input" id="lg-code" inputmode="numeric" maxlength="6" placeholder="6 位数字" autocomplete="one-time-code">' +
        '<button class="btn btn-ghost" type="button" data-lg="send">获取验证码</button></div></div>')
      : ('<div class="field"><label for="lg-account">用户名</label>' +
        '<input class="input" id="lg-account" type="text" maxlength="32" value="zhang" autocomplete="username" placeholder="用户名或手机号"></div>' +
        '<div class="field"><label for="lg-pwd">密码</label>' +
        '<input class="input" id="lg-pwd" type="password" maxlength="64" value="a123456" autocomplete="current-password" placeholder="登录密码"></div>' +
        '<div class="form-hint">用户名由平台开通时分配（如 zhang）；也可直接填手机号。</div>')) +
    '<label class="login-check mt8"><input type="checkbox" id="lg-agree" checked>' +
    "<span>我已阅读并同意《用户协议》《隐私政策》《退款规则》，同意平台按公示规则派单与结算</span></label>" +
    '<button class="btn btn-primary btn-block mt16" type="button" data-lg="' + (modeCode ? "login" : "account-login") + '">' +
    (modeCode ? "登录 / 注册" : "登录") + "</button>" +
    (modeCode ? '<button class="btn btn-sm btn-ghost btn-block mt8" type="button" data-lg="pwd" style="box-shadow:none">使用演示密码登录（a123456）</button>' : "") +
    "</div>" +
    '<p class="tiny faint mt16 center">教员须通过资质审核后方可上线接单；忘记密码请联系片区代理重置</p>';
}

function showLogin() {
  clearBar();
  setActions({});
  const old = document.querySelector(".login-layer");
  if (old) old.remove();
  const el = document.createElement("div");
  el.className = "login-layer";
  el.innerHTML = loginHtml();
  shellEl().appendChild(el);
  hdrEl().innerHTML = "";
  tabbarEl().style.display = "none";
  tabbarEl().innerHTML = "";
  bodyEl().innerHTML = "";
  bindLogin(el);
}

function ensureTeacherRole() {
  const role = session.user && session.user.role;
  if (role !== "teacher") {
    session.clear();
    toastErr("该账号不是教员角色" + (role ? "（当前：" + role + "）" : "") + "，请使用教员演示账号 13900000201");
    showLogin();
    return false;
  }
  return true;
}

function bindLogin(root) {
  const phoneEl = $("#lg-phone", root);
  const codeEl = $("#lg-code", root);
  const accountEl = $("#lg-account", root);
  const pwdEl = $("#lg-pwd", root);
  root.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-lg]");
    if (!btn) return;
    const kind = btn.dataset.lg;
    const phone = (phoneEl && phoneEl.value ? phoneEl.value : "").trim();
    const label = btn.textContent;
    const busy = (on, txt) => {
      btn.disabled = on;
      btn.textContent = on ? txt : label;
    };

    // 切换登录方式：重绘登录层，不丢输入（用户名/密码会带上当前值）
    if (kind === "mode-code" || kind === "mode-account") {
      const next = kind === "mode-account" ? "account" : "code";
      if (next === loginMode) return;
      const keepAccount = accountEl ? accountEl.value : "";
      const keepPwd = pwdEl ? pwdEl.value : "";
      loginMode = next;
      showLogin();
      const a2 = document.querySelector("#lg-account");
      const p2 = document.querySelector("#lg-pwd");
      if (a2 && keepAccount) a2.value = keepAccount;
      if (p2 && keepPwd) p2.value = keepPwd;
      const focusEl = document.querySelector(next === "account" ? "#lg-pwd" : "#lg-code");
      if (focusEl) focusEl.focus();
      return;
    }

    if (kind === "send") {
      if (!/^1\d{10}$/.test(phone)) return toastErr("请输入正确的手机号");
      busy(true, "发送中…");
      try {
        const r = await api.post("/api/auth/send-code", { phone });
        codeEl.value = r.devCode || "";
        if (r.devCode) codeEl.focus();
        toast("演示验证码 " + (r.devCode || "") + "，已自动填入");
      } catch (err) {
        onError(err);
      } finally {
        busy(false);
      }
      return;
    }

    if (!$("#lg-agree", root).checked) return toastErr("请先阅读并同意平台协议");
    busy(true, "登录中…");
    try {
      if (kind === "account-login") {
        // 用户名 + 密码：用户名或手机号都可以，走统一的账号密码接口
        const account = (accountEl.value || "").trim();
        const password = pwdEl.value || "";
        if (!account) {
          busy(false);
          return toastErr("请输入用户名或手机号");
        }
        if (!password) {
          busy(false);
          return toastErr("请输入密码");
        }
        await loginByAccount(account, password);
      } else if (kind === "pwd") {
        await loginByPassword(phone, "a123456");
      } else {
        const code = (codeEl.value || "").trim();
        if (!/^\d{4,6}$/.test(code)) {
          busy(false);
          return toastErr("请先获取并填写验证码");
        }
        await loginByCode(phone, code);
      }
      if (!ensureTeacherRole()) return;
      toastOk("登录成功");
      startApp();
    } catch (err) {
      onError(err);
    } finally {
      busy(false);
    }
  });
}

async function startApp() {
  const layer = document.querySelector(".login-layer");
  if (layer) layer.remove();
  await refreshUnread();
  if (!session.token) return;
  if (ROUTER) ROUTER.render();
}

/* ---------------- 通用片段 ---------------- */
function kv(k, v, cls = "") {
  return '<div class="kv ' + cls + '"><span class="k">' + esc(k) + '</span><span class="v">' + v + "</span></div>";
}

function lessonTimeText(o) {
  const start = fmtDate(o.lessonTime, "time");
  if (!o.lessonEnd) return start;
  const end = /^\d{1,2}:\d{2}$/.test(String(o.lessonEnd))
    ? fmtDate(o.lessonTime, "date") + " " + esc(o.lessonEnd)
    : fmtDate(o.lessonEnd, "time");
  return start + " 至 " + end;
}

function qItem(icon, label, value, go) {
  if (!go) {
    return '<div class="q-item" style="cursor:default"><span class="qi" aria-hidden="true">' + icon + "</span>" +
      '<span class="qz">' + esc(label) + '</span><span class="qv">' + esc(value || "") + "</span></div>";
  }
  return '<button class="q-item" data-go="' + go + '"><span class="qi" aria-hidden="true">' + icon + "</span>" +
    '<span class="qz">' + esc(label) + '</span><span class="qv">' + esc(value || "") + '</span>' +
    '<span class="faint" aria-hidden="true">›</span></button>';
}

function notApprovedHtml(err) {
  const msg = (err && err.message) || "资质审核通过后才能使用该功能";
  return '<div class="card">' + emptyHtml(msg, "🪪") +
    '<div class="btn-row"><button class="btn btn-outline btn-sm" data-go="/apply">查看入驻资料</button>' +
    '<button class="btn btn-ghost btn-sm" data-go="/">返回接单中心</button></div></div>';
}

function chipPicker(name, items, selected) {
  const sel = selected || [];
  return '<div class="chip-row" data-picker="' + name + '">' + items.map((it) =>
    '<button type="button" class="chip ' + (sel.includes(it) ? "on" : "") + '" data-pick="' + esc(it) + '" aria-pressed="' + (sel.includes(it) ? "true" : "false") + '">' + esc(it) + "</button>"
  ).join("") + "</div>";
}
function bindPicker(root, name) {
  $$('[data-picker="' + name + '"] [data-pick]', root).forEach((el) => {
    el.addEventListener("click", () => {
      el.classList.toggle("on");
      el.setAttribute("aria-pressed", el.classList.contains("on") ? "true" : "false");
    });
  });
}
function readPicker(root, name) {
  return $$('[data-picker="' + name + '"] .chip.on', root).map((el) => el.dataset.pick);
}

function scheduleToText(arr) {
  return (arr || []).map((r) => WEEK[(Number(r.day) || 1) - 1] + " " + (r.slots || []).join(" / ")).join("\n");
}
function textToSchedule(text) {
  const out = [];
  String(text || "").split(/\n+/).forEach((line) => {
    const t = line.trim();
    const idx = WEEK.findIndex((w) => t.startsWith(w));
    if (idx < 0) return;
    const slots = t.slice(2).split(/[\/、,，\s]+/).filter((s) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(s));
    if (slots.length) out.push({ day: idx + 1, slots });
  });
  return out;
}

function localDateStr(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function todayStr() {
  return localDateStr(new Date().toISOString());
}

/* ---------------- 抢单卡片 ---------------- */
function demandCard(d) {
  const times = (d.lessonTimes || []).map((t) => (t.date || "") + " " + (t.start || "") + "-" + (t.end || "")).join("；");
  const applied = d.appliedStatus;
  return '<article class="card demand-card ' + (d.urgent ? "urgent" : "") + '">' +
    '<div class="row between"><div class="row" style="gap:6px;flex-wrap:wrap">' +
    '<b style="font-size:15px">' + esc(d.subject) + '</b><span class="tag">' + esc(d.stage) + "</span>" +
    (d.urgent ? '<span class="badge danger">加急</span>' : "") + "</div>" +
    '<span class="dist">📍 ' + (d.distanceKm ?? "-") + " km</span></div>" +
    '<div class="times">🕒 ' + esc(times || "时间待沟通") + "</div>" +
    '<div class="small muted ellipsis mt8">📍 ' + esc(d.address || "") + "</div>" +
    (d.remark ? '<div class="tiny faint mt8">备注：' + esc(d.remark) + "</div>" : "") +
    '<div class="dashed-top row between">' +
    "<div><div class=\"tiny faint\">预算</div><div class=\"money\" style=\"font-size:16px\">" + money(d.budget) + "</div></div>" +
    '<div class="row" style="gap:8px"><span class="tiny faint">优先级 ' + Number(d.priority || 0).toFixed(1) + "</span>" +
    (applied
      ? '<span class="badge ' + (applied === "confirmed" ? "green" : applied === "pending" ? "gold" : "gray") + '">' +
        esc(APPLIED_STATUS[applied] || applied) + "</span>"
      : '<button class="btn btn-primary btn-sm" data-act="grab" data-id="' + d.id + '">一键抢单</button>') +
    "</div></div></article>";
}

/* ---------------- 路由：接单中心 ---------------- */
async function homeView() {
  chrome({ loc: '<div class="online-bar"><div class="grow"><div class="ot">接单中心</div><div class="os">正在加载…</div></div></div>', tab: "/" });
  setBody(loadingHtml());
  const d = await api.get("/api/teacher/dashboard");
  const approved = d.auditStatus === "approved";
  let nearby = { list: [], total: 0 };
  let nearbyErr = null;
  if (approved) {
    try {
      nearby = await api.get("/api/teacher/nearby-demands");
    } catch (err) {
      if (err && err.status === 401) throw err;
      nearbyErr = err;
    }
  }
  const o = d.overview || {};
  const sw = d.serviceStatus || {};
  const w = d.wallet || {};

  chrome({
    loc: '<div class="online-bar"><div class="grow"><div class="ot">' + (d.online ? "在线接单中" : "当前离线") + "</div>" +
      '<div class="os">今日 ' + (o.todayLessons || 0) + " 单 · 评分 " + Number(o.ratingAvg || 0).toFixed(1) + " · " + esc(o.levelName || o.level || "-") + "</div></div>" +
      (approved
        ? '<button class="switch ' + (d.online ? "on" : "") + '" data-act="online" role="switch" aria-checked="' + (d.online ? "true" : "false") + '" aria-label="在线接单开关"></button>'
        : '<span class="state">待审核</span>') +
      '<button class="icon-btn" data-go="/services" title="我的服务" aria-label="我的服务">🗂</button>' +
      bellHtml() + "</div>",
    tab: "/",
  });

  const hero = '<div class="hero"><div class="row between"><div><div class="tiny" style="opacity:.85">今日收入</div>' +
    '<div style="font-size:24px;font-weight:800;letter-spacing:-.5px">' + money(o.todayIncome) + "</div></div>" +
    '<div style="text-align:right"><div class="tiny" style="opacity:.85">当前等级</div>' + levelBadge(o.level, o.levelName) + "</div></div>" +
    '<div class="grid">' +
    '<div class="cell"><div class="l">今日服务单量</div><div class="v">' + (o.todayLessons || 0) + "</div></div>" +
    '<div class="cell"><div class="l">服务评分</div><div class="v">' + Number(o.ratingAvg || 0).toFixed(1) + "</div></div>" +
    '<div class="cell"><div class="l">本周课时</div><div class="v">' + (o.weekLessons || 0) + "</div></div>" +
    '<div class="cell"><div class="l">待处理订单</div><div class="v">' + (d.pendingCount || 0) + "</div></div>" +
    "</div></div>";

  const auditCard = approved ? "" :
    '<div class="card"><div class="row between"><div class="row" style="gap:10px"><span style="font-size:20px">🪪</span>' +
      '<div><div class="bold small">资质' + (d.auditStatus === "pending" ? "审核中" : "未通过") + "</div>" +
      '<div class="tiny faint">' + (d.auditStatus === "pending" ? "审核通过后即可上线接单" : "请补充资料后重新提交审核") + "</div></div></div>" +
      '<button class="btn btn-xs btn-ghost" data-go="/apply">查看</button></div></div>';

  const nextLevelCard = d.nextLevel
    ? '<div class="card tight row between" data-go="/level" role="link" tabindex="0" style="cursor:pointer">' +
      '<div class="row" style="gap:10px"><span style="font-size:18px">⬆️</span><div>' +
      '<div class="bold small">再获 ' + d.nextLevel.need + " 成长分升级「" + esc(d.nextLevel.name) + "」</div>" +
      '<div class="tiny faint">等级越高佣金越低、派单权重越大</div></div></div><span class="faint">›</span></div>'
    : '<div class="card tight row between" data-go="/level" role="link" tabindex="0" style="cursor:pointer">' +
      '<div class="row" style="gap:10px"><span style="font-size:18px">🏆</span><div>' +
      '<div class="bold small">已达最高等级「' + esc(o.levelName || "-") + '」</div>' +
      '<div class="tiny faint">查看等级权益与成长分明细</div></div></div><span class="faint">›</span></div>';

  const walletCard = '<div class="card"><div class="card-title"><h3>钱包概览</h3><span class="more" data-go="/income" role="link" tabindex="0">收入明细 ›</span></div>' +
    '<div class="stat-grid three">' +
    '<div class="stat"><div class="label">可提现余额</div><div class="value" style="font-size:16px">' + money(w.balance) + "</div></div>" +
    '<div class="stat"><div class="label">冻结中</div><div class="value" style="font-size:16px">' + money(w.frozen) + "</div></div>" +
    '<div class="stat"><div class="label">累计收入</div><div class="value" style="font-size:16px">' + money(w.totalIncome) + "</div></div>" +
    "</div>" +
    '<button class="btn btn-ghost btn-sm btn-block mt12" data-go="/income">去提现</button></div>';

  const serviceCard = '<div class="card"><div class="card-title"><h3>我的服务状态</h3>' +
    '<span class="more" data-go="/services" role="link" tabindex="0">服务管理 ›</span></div>' +
    kv("服务区域", esc(sw.coverArea || "未设置") + " · 半径 " + (sw.radiusKm ?? "-") + " km") +
    '<div class="kv"><span class="k">可接科目</span><span class="v row wrap" style="gap:4px;justify-content:flex-end">' +
    ((sw.subjects || []).map((s) => '<span class="tag">' + esc(s) + "</span>").join("") || '<span class="faint">未设置</span>') +
    "</span></div>" +
    kv("课时单价", money(sw.price)) +
    '<div class="row between mt12"><span class="tiny faint">' + (d.online ? "当前在线，可接收附近订单推送" : "当前离线，无法抢单") + "</span>" +
    (approved
      ? '<button class="btn btn-xs btn-ghost" data-act="online">' + (d.online ? "下线" : "上线") + "</button>"
      : '<button class="btn btn-xs btn-outline" disabled>审核通过后可上线</button>') +
    "</div></div>";

  const list = nearby.list || [];
  const demandSection = !approved
    ? '<div class="card">' + emptyHtml("资质审核通过后才能看到附近订单", "🔒") +
      '<button class="btn btn-ghost btn-sm btn-block" data-go="/apply">查看入驻资料</button></div>'
    : nearbyErr
      ? '<div class="card">' + emptyHtml((nearbyErr.message || "附近订单加载失败"), "⚠️") +
        '<button class="btn btn-ghost btn-sm btn-block" data-act="reload">重新加载</button></div>'
      : (list.length
        ? list.map((it) => demandCard(it)).join("")
        : '<div class="card">' + emptyHtml("附近暂无匹配订单，稍后刷新看看", "📡") +
          '<button class="btn btn-ghost btn-sm btn-block" data-act="reload">刷新列表</button></div>');

  setBody(hero + auditCard + nextLevelCard +
    '<div class="section-title"><span class="bar"></span>附近家教订单（' + (nearby.total || 0) + "）</div>" +
    demandSection + serviceCard + walletCard +
    (d.notices && d.notices.length
      ? '<div class="card"><div class="card-title"><h3>📢 平台公告</h3></div>' +
        d.notices.map((n) => '<div class="kv" style="display:block"><div class="bold small">' + esc(n.title) + "</div>" +
          '<div class="tiny faint mt8" style="line-height:1.7">' + esc(n.content || "") + "</div></div>").join("") + "</div>"
      : ""));

  setActions({
    online: async () => {
      if (!approved) return toastErr("资质审核通过后才能上线接单");
      const next = !d.online;
      await api.post("/api/teacher/online", { online: next });
      toastOk(next ? "已上线，开始接收订单推送" : "已下线，暂停接收订单");
      ROUTER.render();
    },
    grab: async (el) => {
      const r = await api.post("/api/demands/" + el.dataset.id + "/apply", {});
      toastOk("抢单成功，等待家长确认（优先级 " + Number(r.priority || 0).toFixed(1) + "）");
      ROUTER.render();
    },
    reload: () => ROUTER.render(),
  });
}

/* ---------------- 路由：订单列表 ---------------- */
const ORDER_TABS = [
  { v: "", t: "全部" },
  { v: "awaiting", t: "待确认" },
  { v: "pending", t: "服务中" },
  { v: "completed", t: "已完成" },
  { v: "cancelled", t: "已取消" },
];

function storeOrder(o) {
  state.orderCache.set(String(o.id), o);
  return o;
}

function orderCard(o) {
  storeOrder(o);
  const p = o.parent || {};
  const acts = [];
  // 家长申请取消：这一单要教员先处理，卡片上直接给「退款 / 驳回」
  if (o.cancelRequested) {
    acts.push('<button class="btn btn-primary btn-sm" data-act="cancel-approve" data-id="' + o.id + '">同意退款</button>');
    acts.push('<button class="btn btn-outline btn-sm" data-act="cancel-reject" data-id="' + o.id + '">驳回</button>');
    return '<article class="card" data-go="/order/' + o.id + '" role="link" tabindex="0" style="cursor:pointer;border-color:#f0c987">' +
      '<div class="row between"><div class="row" style="gap:6px"><span class="badge amber">家长申请取消</span>' +
      '<span class="tag">' + esc(o.stage) + "·" + esc(o.subject) + "</span></div>" +
      '<span class="tiny faint">' + fromNow(o.cancelRequestedAt || o.createdAt) + "</span></div>" +
      '<div class="mt12 small">🕒 ' + fmtDate(o.lessonTime, "time") + "</div>" +
      '<div class="mt8 small muted ellipsis">📍 ' + esc(o.address) + "</div>" +
      (o.cancelReason ? '<div class="mt8 tiny" style="color:#b06f00">家长原因：' + esc(o.cancelReason) + "</div>" : "") +
      '<div class="dashed-top row between">' +
      '<div class="row" style="gap:8px">' + avatar(p.nickname, p.avatar, "sm") +
      '<div><div class="small bold">' + esc(p.nickname || "家长") + "</div>" +
      '<div class="tiny faint">待您处理（超时平台自动退款）</div></div></div>' +
      '<div class="center"><div class="tiny faint">待退金额</div><div class="money" style="font-size:16px">' +
      money(Number(o.amount) + Number(o.urgentFee || 0)) + "</div></div></div>" +
      '<div class="btn-row mt12">' + acts.join("") + "</div>" +
      "</article>";
  }
  if (o.status === "pending_class") acts.push('<button class="btn btn-primary btn-sm" data-act="detail" data-id="' + o.id + '">去打卡</button>');
  if (o.status === "in_class") acts.push('<button class="btn btn-primary btn-sm" data-act="detail" data-id="' + o.id + '">结束授课</button>');
  if (o.status === "awaiting_parent_confirm") acts.push('<button class="btn btn-outline btn-sm" disabled>等待家长确认</button>');
  return '<article class="card" data-go="/order/' + o.id + '" role="link" tabindex="0" style="cursor:pointer">' +
    '<div class="row between"><div class="row" style="gap:6px">' + statusBadge(o.status, o.statusText) +
    '<span class="tag">' + esc(o.stage) + "·" + esc(o.subject) + "</span></div>" +
    '<span class="tiny faint">' + fromNow(o.createdAt) + "</span></div>" +
    '<div class="mt12 small">🕒 ' + fmtDate(o.lessonTime, "time") + "</div>" +
    '<div class="mt8 small muted ellipsis">📍 ' + esc(o.address) + "</div>" +
    '<div class="dashed-top row between">' +
    '<div class="row" style="gap:8px">' + avatar(p.nickname, p.avatar, "sm") +
    '<div><div class="small bold">' + esc(p.nickname || "家长") + "</div>" +
    '<div class="tiny faint">信用 ' + esc((p.credit && p.credit.creditLevelName) || "-") + "</div></div></div>" +
    '<div class="center"><div class="tiny faint">' + (o.teacherIncome != null ? "实收课时费" : "课时费") + '</div><div class="money" style="font-size:16px">' +
    money(o.teacherIncome != null ? o.teacherIncome : o.amount) + "</div></div></div>" +
    (acts.length ? '<div class="btn-row mt12">' + acts.join("") + "</div>" : "") +
    "</article>";
}

async function ordersView({ query }) {
  const status = query.status || "";
  const pendingCancel = query.pendingCancel === "1";
  chrome({ title: pendingCancel ? "待处理取消申请" : "我的订单", sub: "上门授课 · 担保结算", tab: "/orders" });
  setBody(loadingHtml());
  const res = await api.get("/api/teacher/orders", pendingCancel ? { pendingCancel: "1" } : status ? { status } : {});
  const list = res.list || [];
  const tabs = '<div class="tabs">' + ORDER_TABS.map((t) =>
    '<button class="' + (!pendingCancel && status === t.v ? "on" : "") + '" data-go="/orders' + (t.v ? "?status=" + t.v : "") + '">' + t.t + "</button>"
  ).join("") +
    '<button class="' + (pendingCancel ? "on" : "") + '" data-go="/orders?pendingCancel=1">待处理取消</button></div>';
  setBody(tabs + (list.length
    ? (pendingCancel ? '<p class="tiny faint mb12">家长提交的取消申请共 ' + list.length + " 单；同意即按规则退款，驳回订单继续履约（超时未处理平台自动退款）。</p>" : "") +
      list.map((o) => orderCard(o)).join("")
    : '<div class="card">' + emptyHtml(pendingCancel ? "暂无待处理的取消申请" : status ? "该分类下暂无订单" : "还没有订单，去接单中心抢一单吧", "📋") +
      '<button class="btn btn-ghost btn-sm btn-block" data-go="/">去接单中心</button></div>'));
  setActions({
    detail: (el) => {
      location.hash = "#/order/" + el.dataset.id;
    },
    "cancel-approve": async (el) => {
      const o = state.orderCache.get(String(el.dataset.id));
      const amount = o ? money(Number(o.amount) + Number(o.urgentFee || 0)) : "";
      const yes = await confirmDialog("同意退款", "同意家长取消订单" + (amount ? "，将按规则退款 " + amount : "") + "？退款后订单结束。", "同意并退款", true);
      if (!yes) return;
      await api.post("/api/teacher/orders/" + encodeURIComponent(el.dataset.id) + "/cancel-approve", {});
      toastOk("已同意取消并退款");
      ROUTER.render();
    },
    "cancel-reject": async (el) => {
      const reason = await promptDialog(
        "驳回取消申请",
        "如：距离上课不足 2 小时，已按约定备好课件",
        { confirmText: "驳回", textarea: false }
      );
      if (reason == null) return;
      if (String(reason).trim().length < 2) return toastErr("请填写驳回理由（至少 2 个字）");
      await api.post("/api/teacher/orders/" + encodeURIComponent(el.dataset.id) + "/cancel-reject", { reason: String(reason).trim() });
      toastOk("已驳回，订单继续履约");
      ROUTER.render();
    },
  });
}

/* ---------------- 路由：订单详情（含打卡 / 结束授课） ---------------- */
function checkinSheet(o) {
  const atTeacherPlace = o.place === "teacher_place";
  const doCheckin = async (lat, lng, label) => {
    try {
      const res = await api.post("/api/orders/" + o.id + "/checkin", { lat, lng });
      // 到教员处上课：双方都打完卡才开课（P66）
      toastOk(atTeacherPlace && !res.bothArrived
        ? "打卡成功，等家长到场打卡后自动开始上课"
        : "打卡成功，" + label + "已开始上课");
      ROUTER.render();
    } catch (err) {
      onError(err);
    }
  };
  sheet(
    atTeacherPlace ? "到场打卡（教学点）" : "上门打卡",
    '<div class="card flat tight"><div class="small bold">' + (atTeacherPlace ? "教学点地址" : "上课地点") + "</div>" +
    '<div class="tiny faint mt8">' + esc(o.address) + "</div>" +
    '<div class="tiny faint mt8">坐标 ' + o.lat + ", " + o.lng + ' · 允许误差 500 米</div></div>' +
    '<p class="small muted mt12" style="line-height:1.75">' +
    (atTeacherPlace
      ? "家长会带孩子到您的教学点：您在这里打卡、家长在其端打卡，<b>双方都完成后课程自动开始</b>；当前家长" +
        (o.parentArrived ? "已到场 ✅" : "尚未打卡 ⏳") + "。"
      : "请在到达学生住址后打卡。系统会校验定位与上课地点的距离，超出阈值将无法打卡并计入风控。") +
    "</p>" +
    '<button type="button" class="btn btn-sm btn-outline btn-block mt12" data-ci="sim">模拟异常定位（偏移 3 公里）</button>',
    [
      { label: "取消" },
      { label: atTeacherPlace ? "我在教学点打卡" : "正常定位打卡", class: "btn-primary", onClick: () => doCheckin(o.lat, o.lng, "本次课程") },
    ]
  );
  const mask = shellEl().querySelector(".mask:last-child");
  const sim = mask && mask.querySelector('[data-ci="sim"]');
  if (sim) {
    sim.addEventListener("click", () => {
      mask.remove();
      doCheckin(Number(o.lat) + 0.027, Number(o.lng), "异常定位");
    });
  }
}

function teacherBar(o) {
  const contact = '<button class="btn btn-outline" data-act="contact" data-id="' + o.id + '">联系家长</button>';
  // 家长申请取消：这条订单的第一优先动作是「退款 / 驳回」
  if (o.cancelRequested) {
    return contact +
      '<button class="btn btn-outline" data-act="cancel-reject" data-id="' + o.id + '">驳回</button>' +
      '<button class="btn btn-primary wide" data-act="cancel-approve" data-id="' + o.id + '">同意退款</button>';
  }
  if (o.status === "awaiting_payment") {
    return contact +
      '<button class="btn btn-outline btn-sm" data-act="cancel" data-id="' + o.id + '">拒单</button>' +
      '<button class="btn btn-primary" disabled>待家长支付</button>';
  }
  if (o.status === "pending_class") {
    return contact +
      '<button class="btn btn-outline btn-sm" data-act="sos" data-id="' + o.id + '" data-no="' + esc(o.orderNo) + '">🚨 求助</button>' +
      '<button class="btn btn-outline btn-sm" data-act="cancel" data-id="' + o.id + '">取消</button>' +
      (o.checkinAt
        ? '<button class="btn btn-primary" disabled>' + (o.place === "teacher_place" ? "等家长打卡" : "已打卡") + "</button>"
        : '<button class="btn btn-primary" data-act="checkin" data-id="' + o.id + '">' +
          (o.place === "teacher_place" ? "教学点打卡" : "上门打卡") + "</button>");
  }
  if (o.status === "in_class") {
    return contact +
      '<button class="btn btn-outline btn-sm" data-act="sos" data-id="' + o.id + '" data-no="' + esc(o.orderNo) + '">🚨 求助</button>' +
      '<button class="btn btn-primary wide" data-act="finish" data-id="' + o.id + '">结束授课</button>';
  }
  if (o.status === "awaiting_parent_confirm") {
    return contact + '<button class="btn btn-primary wide" disabled>等待家长确认</button>';
  }
  if (o.status === "completed" || o.status === "settled") {
    return contact + '<button class="btn btn-outline" data-act="income">收入明细</button>';
  }
  return contact + '<button class="btn btn-primary wide" data-go="/">返回接单中心</button>';
}

async function orderDetailView({ params }) {
  chrome({ title: "订单详情", plain: true, back: true });
  setBody(loadingHtml());
  const o = await api.get("/api/orders/" + encodeURIComponent(params.id));
  storeOrder(o);
  const p = o.parent || {};
  const credit = p.credit || {};
  setBody(
    '<div class="card"><div class="row between"><div>' +
    '<div style="font-size:19px;font-weight:800">' + esc(o.statusText) + "</div>" +
    '<div class="tiny faint mt8">' + esc({
      awaiting_payment: "已确认接单，等待家长完成担保支付后即可按时上门。",
      pending_class: "请按约定时间上门，到达后在 500 米内打卡开始授课。",
      in_class: "课程进行中，授课结束后请点击「结束授课」并等待家长确认。",
      awaiting_parent_confirm: "已结束授课，等待家长确认完成后课时费进入冻结期。",
      completed: "已确认完成，课时费冻结中，冻结期满自动结算到余额。",
      settled: "订单已结算，课时费已到账。",
      cancelled: "订单已取消。",
      refunded: "订单已退款。",
      refunding: "退款处理中。",
    }[o.status] || "") + "</div></div>" + statusBadge(o.status, o.statusText) + "</div>" +
    (o.freeCancelDeadline ? '<div class="tiny faint mt8">家长免费取消截止：' + fmtDate(o.freeCancelDeadline, "time") + "</div>" : "") +
    "</div>" +

    (o.cancelRequested
      ? '<div class="card" style="border-color:#f0c987"><div class="card-title"><h3>家长申请取消</h3>' +
        '<span class="more">' + fmtDate(o.cancelRequestedAt, "time") + " 提交</span></div>" +
        '<div class="hint" style="border-color:#f0c987;background:#fff9ec;color:#8a5a00;border-radius:12px">' +
        "家长申请取消，原因：" + esc(o.cancelReason || "未填写") + "。同意即按规则退款，驳回则订单继续履约；超时未处理平台自动退款。</div>" +
        '<div class="btn-row mt12"><button class="btn btn-outline btn-sm" data-act="cancel-reject" data-id="' + o.id + '">驳回</button>' +
        '<button class="btn btn-primary btn-sm" data-act="cancel-approve" data-id="' + o.id + '">同意退款</button></div></div>'
      : "") +
    (o.cancelRejectedAt && !o.cancelRequested
      ? '<div class="card"><div class="card-title"><h3>取消申请记录</h3></div>' +
        kv("最近驳回时间", fmtDate(o.cancelRejectedAt, "time")) +
        kv("驳回理由", esc(o.cancelRejectReason || "-")) + "</div>"
      : "") +

    '<div class="card"><div class="card-title"><h3>学生需求</h3></div>' +
    kv("科目 / 学段", esc(o.subject) + " · " + esc(o.stage)) +
    kv("上课方式", "教员上门授课") +
    kv("期望时间", lessonTimeText(o)) +
    kv("预算 / 课时费", money(o.amount)) +
    kv("上课地址", esc(o.address)) +
    (o.remark ? kv("家长备注", esc(o.remark)) : "") +
    (o.checkinAt ? kv("打卡记录", fmtDate(o.checkinAt, "time") + " · 距上课地点 " + (o.checkinDistance ?? "-") + " 米") : "") +
    "</div>" +

    '<div class="card"><div class="card-title"><h3>家长信息</h3>' +
    '<span class="more" data-act="contact">联系电话 ›</span></div>' +
    '<div class="row" style="gap:12px">' + avatar(p.nickname, p.avatar, "lg") +
    '<div class="grow"><div class="bold">' + esc(p.nickname || "家长") + "</div>" +
    '<div class="row mt8" style="gap:6px;flex-wrap:wrap">' +
    '<span class="badge">' + esc(credit.creditLevelName || "未评级") + "</span>" +
    '<span class="tiny faint">信用分 ' + (credit.creditScore ?? "-") + "</span>" +
    '<span class="tiny faint">评价权重 ' + Number(credit.reviewWeight || 1).toFixed(1) + "×</span></div>" +
    '<div class="tiny faint mt8">完成订单 ' + (credit.completedOrders ?? 0) + " 次 · 取消 " + (credit.cancelCount ?? 0) + " 次</div></div></div>" +
    '<div class="hint green mt12">家长评价权重越高，好评对您的成长分加成越大（4-5 星好评 +5 × 权重）。</div></div>' +

    '<div class="card"><div class="card-title"><h3>结算信息</h3><span class="badge green">🛡 平台担保</span></div>' +
    kv("订单号", esc(o.orderNo)) +
    kv("下单时间", fmtDate(o.createdAt, "time")) +
    '<div class="divider"></div>' +
    kv("课时费", money(o.amount)) +
    (o.urgentFee ? kv("加急费", money(o.urgentFee)) : "") +
    kv("平台服务费", o.serviceFee != null ? money(o.serviceFee) + ' <span class="tiny faint">(' + pct(o.commissionRate) + ")</span>" : '<span class="faint">支付后生成</span>') +
    kv("预计实收", o.teacherIncome != null ? '<span class="money" style="color:var(--brand)">' + money(o.teacherIncome) + "</span>" : '<span class="faint">支付后生成</span>') +
    "</div>"
  );
  mountBar(teacherBar(o));
  setActions({
    sos: async (el) => {
      const yes = await confirmDialog(
        "🚨 紧急求助",
        "将立即通知平台客服与片区负责人处理订单 " + (el.dataset.no || "") + "。仅在人身安全或突发状况时使用。",
        "确认求助",
        true
      );
      if (!yes) return;
      try {
        const r = await api.post("/api/orders/" + el.dataset.id + "/sos", { note: "教员端发起" });
        toastOk(r.message || "求助已提交");
      } catch (err) {
        onError(err);
      }
    },
    contact: () => {
      sheet("联系家长",
        '<div class="row" style="gap:12px">' + avatar(p.nickname, p.avatar, "lg") +
        '<div><div class="bold">' + esc(p.nickname || "家长") + "</div>" +
        '<div class="row mt8" style="gap:6px">' + levelBadge(o.teacher && o.teacher.level, (o.teacher && o.teacher.levelName) || "") +
        '<span class="tiny faint">' + esc(credit.creditLevelName || "") + "</span></div></div></div>" +
        kv("联系电话", esc(p.phone || "-")) +
        kv("上课时间", fmtDate(o.lessonTime, "time")) +
        kv("上课地址", esc(o.address || "-")) +
        '<div class="hint mt12">请勿与家长私下交易。平台外交易将扣除成长分并可能被封禁（-200 分）。</div>',
        [{ label: "我知道了", class: "btn-primary" }]);
    },
    checkin: () => {
      if (o.status !== "pending_class") return toastErr("当前状态不可打卡（" + o.statusText + "）");
      checkinSheet(o);
    },
    finish: async () => {
      const yes = await confirmDialog("结束授课", "确认已完本次授课？结束后将通知家长确认完成，确认后课时费进入 7 天冻结期。", "结束授课");
      if (!yes) return;
      await api.post("/api/orders/" + o.id + "/finish", {});
      toastOk("已结束授课，等待家长确认");
      ROUTER.render();
    },
    cancel: async () => {
      const yes = await confirmDialog("取消 / 拒单", "取消已确认的订单会扣除成长分（未到岗 -50 分）并影响后续派单权重。确认取消？", "确认取消", true);
      if (!yes) return;
      const reason = await promptDialog("请填写取消原因", "如：临时有课无法上门", { value: "" });
      if (!reason) return;
      await api.post("/api/orders/" + o.id + "/cancel", { reason });
      toastOk("订单已取消");
      ROUTER.render();
    },
    "cancel-approve": async () => {
      const paid = money(Number(o.amount) + Number(o.urgentFee || 0));
      const yes = await confirmDialog(
        "同意退款",
        "家长申请取消订单" + (o.cancelReason ? "（原因：" + o.cancelReason + "）" : "") +
          "。同意后将按规则退款（免费取消窗口内全额，否则扣违约金作为您的补偿），退款金额上限 " + paid + "。",
        "同意并退款",
      );
      if (!yes) return;
      const r = await api.post("/api/teacher/orders/" + o.id + "/cancel-approve", {});
      toastOk("已同意取消，退款 ¥" + ((r && r.refundAmount) / 100).toFixed(2));
      ROUTER.render();
    },
    "cancel-reject": async () => {
      const reason = await promptDialog("驳回取消申请", "如：距离上课不足 2 小时，已按约定备好课件", {
        confirmText: "驳回",
        textarea: false,
      });
      if (reason == null) return;
      if (String(reason).trim().length < 2) return toastErr("请填写驳回理由（至少 2 个字）");
      await api.post("/api/teacher/orders/" + o.id + "/cancel-reject", { reason: String(reason).trim() });
      toastOk("已驳回，订单继续履约");
      ROUTER.render();
    },
    income: () => {
      location.hash = "#/income";
    },
  });
}

/* ---------------- 路由：等级权益 ---------------- */
async function levelView() {
  chrome({ title: "我的等级权益", plain: true, back: true });
  setBody(loadingHtml());
  let d;
  try {
    d = await api.get("/api/teacher/level");
  } catch (err) {
    if (err && err.status === 401) throw err;
    setBody(notApprovedHtml(err));
    setActions({});
    return;
  }
  const next = d.nextLevel;
  const rules = d.growthRules || {};
  const violation = rules.violation || {};
  setBody(
    '<div class="level-hero"><div class="row between">' +
    '<div><div class="tiny" style="opacity:.72">当前等级</div>' +
    '<div style="font-size:20px;font-weight:800;margin-top:4px">' + esc(d.levelName) +
    ' <span class="badge-lv">' + esc(d.level) + "</span></div></div>" +
    '<div style="text-align:right"><div class="tiny" style="opacity:.72">成长分</div>' +
    '<div class="score">' + d.growthScore + "</div></div></div>" +
    '<div class="mt12"><div class="progress"><i style="width:' + clamp(d.progress || 0, 0, 100) + '%"></i></div>' +
    '<div class="tiny mt8" style="opacity:.85">' +
    (next ? "距「" + esc(next.name) + "」还差 " + next.need + " 分（" + next.min + " 分）" : "已达最高等级，享受最低佣金与最高派单权重") +
    "</div></div></div>" +

    '<div class="stat-grid three mb16">' +
    '<div class="stat"><div class="label">平台佣金比例</div><div class="value">' + pct(d.commission) + "</div></div>" +
    '<div class="stat"><div class="label">派单权重系数</div><div class="value">' + Number(d.levelWeight || 0).toFixed(1) + "×</div></div>" +
    '<div class="stat"><div class="label">首页展示权重</div><div class="value">' + Number(d.levelWeight || 0).toFixed(1) + "×</div></div>" +
    "</div>" +
    '<p class="tiny faint mb16">首页展示权重与派单权重同源（levelWeight），等级越高越靠前出现在家长端教员列表。</p>' +

    '<div class="card"><div class="card-title"><h3>等级规则对照表</h3><span class="more">当前 ' + esc(d.level) + "</span></div>" +
    '<div class="table-wrap"><table class="table"><thead><tr><th>等级</th><th>成长分</th><th>佣金</th><th>派单权重</th></tr></thead><tbody>' +
    (d.levels || []).map((l) =>
      '<tr style="' + (l.level === d.level ? "background:var(--brand-soft);font-weight:700" : "") + '">' +
      "<td>" + levelBadge(l.level, l.name) + "</td>" +
      '<td class="num">' + l.min + "-" + (l.max >= 999999 ? "∞" : l.max) + "</td>" +
      '<td class="num">' + pct(l.commission) + "</td>" +
      '<td class="num">' + Number(l.weight).toFixed(1) + "</td></tr>"
    ).join("") + "</tbody></table></div></div>" +

    '<div class="card"><div class="card-title"><h3>升级任务引导</h3></div>' +
    kv("完成 1 次有效课时", "+" + (rules.per_lesson ?? 2) + " 分") +
    kv("收到 4-5 星好评", "+" + (rules.good_review_base ?? 5) + " 分 × 家长评价权重") +
    kv("收到 1-2 星差评", "-" + (rules.bad_review_base ?? 5) + " 分 × 家长评价权重") +
    '<div class="divider"></div>' +
    kv("违规：未到岗 / 爽约", (violation.no_show ?? -50) + " 分") +
    kv("违规：虚假定位打卡", (violation.fake_checkin ?? -100) + " 分") +
    kv("违规：私下交易", (violation.private_deal ?? -200) + " 分" + (rules.private_deal_ban ? "（并封禁账号）" : "")) +
    "</div>" +

    '<div class="card"><div class="card-title"><h3>成长分明细</h3><span class="more">最近 ' + (d.logs || []).length + " 条</span></div>" +
    ((d.logs || []).length
      ? d.logs.map((l) =>
        '<div class="kv"><span class="k">' + esc(l.reason) + '<br><span class="tiny faint">' + fmtDate(l.created_at, "time") + "</span></span>" +
        '<span class="v" style="color:' + (l.change >= 0 ? "var(--brand-op-dark)" : "var(--danger)") + '">' +
        (l.change >= 0 ? "+" : "") + l.change + ' <span class="tiny faint">→ ' + l.balance_after + "</span></span></div>"
      ).join("")
      : '<p class="small faint">暂无成长分变动记录</p>') + "</div>" +

    '<div class="card"><div class="card-title"><h3>历史等级变更</h3></div>' +
    ((d.levelLogs || []).length
      ? d.levelLogs.map((l) =>
        '<div class="kv"><span class="k">' + esc(l.from_level) + " → " + esc(l.to_level) +
        '<br><span class="tiny faint">' + esc(l.reason || "") + " · " + fmtDate(l.created_at, "date") + "</span></span>" +
        '<span class="v">' + levelBadge(l.to_level, l.to_level) + "</span></div>"
      ).join("")
      : '<p class="small faint">暂无等级变更记录</p>') + "</div>"
  );
  setActions({});
}

/* ---------------- 路由：收入与钱包 ---------------- */
function withdrawSheet(d) {
  const rule = d.rule || {};
  const wallet = d.wallet || {};
  const min = rule.min_withdraw ?? 10000;
  const feeRate = rule.withdraw_fee_rate ?? 0.006;
  const draft = { amount: 0, account: (session.user && session.user.phone) || "" };
  const html =
    '<div class="card flat tight"><div class="row between"><span class="tiny faint">可提现余额</span>' +
    '<span class="money">' + money(wallet.balance) + "</span></div>" +
    '<div class="row between mt8"><span class="tiny faint">冻结中（' + (rule.freeze_days ?? 7) + ' 天冻结期）</span>' +
    '<span class="money faint">' + money(wallet.frozen) + "</span></div></div>" +
    '<div class="field mt12"><label>提现金额（元）</label>' +
    '<input class="input" data-wd="amount" type="number" min="' + yuan(min) + '" step="1" inputmode="decimal" placeholder="最低 ' + yuan(min) + ' 元"></div>' +
    '<div class="field"><label>收款账号（微信）</label>' +
    '<input class="input" data-wd="account" value="' + esc(draft.account) + '" inputmode="numeric" maxlength="11" placeholder="手机号 / 微信号"></div>' +
    '<div class="hint">最低提现 ' + money(min) + "，手续费 " + (feeRate * 100).toFixed(1) + "%，到账金额 = 提现金额 − 手续费。</div>";

  const submit = async () => {
    const amount = cents(draft.amount);
    if (!(amount > 0)) return toastErr("请输入提现金额");
    if (amount < min) return toastErr("最低提现 " + money(min));
    if (amount > wallet.balance) return toastErr("可提现余额不足");
    if (!draft.account.trim()) return toastErr("请填写收款账号");
    try {
      await api.post("/api/withdrawals", {
        amount,
        channel: "wechat",
        account: draft.account.trim(),
      }, { idem: idemKey("wd") });
      toastOk("提现申请已提交，平台审核后打款");
      ROUTER.render();
    } catch (err) {
      onError(err);
    }
  };

  const s = sheet("申请提现", html, [{ label: "取消" }, { label: "提交申请", class: "btn-primary", onClick: submit }]);
  $$("[data-wd]", s.el).forEach((node) => {
    node.addEventListener("input", () => {
      draft[node.dataset.wd] = node.dataset.wd === "amount" ? Number(node.value) : node.value;
    });
  });
}

async function incomeView() {
  chrome({ title: "收入与钱包", plain: true, back: true });
  setBody(loadingHtml());
  let d;
  try {
    d = await api.get("/api/teacher/income");
  } catch (err) {
    if (err && err.status === 401) throw err;
    setBody(notApprovedHtml(err));
    setActions({});
    return;
  }
  const w = d.wallet || {};
  const rule = d.rule || {};
  const level = d.level || {};
  const completed = await api.get("/api/teacher/orders", { status: "completed" }).catch(() => ({ list: [] }));
  const wds = await api.get("/api/withdrawals").catch(() => ({ list: [] }));
  const orders = (completed.list || []).filter((o) => o.teacherIncome != null);
  const txns = d.txns || [];

  setBody(
    '<div class="hero"><div class="row between">' +
    '<div><div class="tiny" style="opacity:.85">可提现余额</div>' +
    '<div style="font-size:26px;font-weight:800;letter-spacing:-.5px">' + money(w.balance) + "</div></div>" +
    '<button class="btn btn-xs" style="background:rgba(255,255,255,.9);color:var(--brand-dark)" data-act="withdraw">提现</button></div>' +
    '<div class="grid" style="grid-template-columns:repeat(3,1fr)">' +
    '<div class="cell"><div class="l">冻结中</div><div class="v" style="font-size:15px">' + money(w.frozen) + "</div></div>" +
    '<div class="cell"><div class="l">本月收入</div><div class="v" style="font-size:15px">' + money(d.monthIncome) + "</div></div>" +
    '<div class="cell"><div class="l">累计服务费</div><div class="v" style="font-size:15px">' + money(d.totalServiceFee) + "</div></div>" +
    "</div></div>" +

    '<div class="hint green mb16">当前等级「' + esc(level.name || "-") + "」佣金 " + pct(level.commission) +
    "；订单确认完成后冻结 " + (rule.freeze_days ?? 7) + " 天，" + (rule.freeze_days ?? 7) + " 天后自动结算到可提现余额。</div>" +

    '<div class="card"><div class="card-title"><h3>冻结中金额</h3><span class="more">' + (d.frozenOrders || []).length + " 笔</span></div>" +
    ((d.frozenOrders || []).length
      ? d.frozenOrders.map((f) =>
        '<div class="kv"><span class="k">' + esc(f.order_no) + '<br><span class="tiny faint">解冻 ' +
        (f.settle_at ? fmtDate(f.settle_at, "time") : "待定") + "</span></span>" +
        '<span class="v">' + money(f.teacher_income) + "</span></div>").join("")
      : '<p class="small faint">暂无冻结中的课时费</p>') +
    "</div>" +

    '<div class="card"><div class="card-title"><h3>收入明细</h3><span class="more">课时费 / 服务费 / 实收</span></div>' +
    (orders.length
      ? orders.map((o) =>
        '<div class="income-row"><div class="row between"><span class="small bold">' + esc(o.subject) + " · " + esc(o.stage) +
        '</span><span class="am bold" style="color:var(--brand-op-dark)">+' + money(o.teacherIncome) + "</span></div>" +
        '<div class="tiny faint mt8">' + esc(o.orderNo) + " · " + fmtDate(o.lessonTime, "date") + " · " + esc(o.statusText) + "</div>" +
        '<div class="row between mt8"><span class="tiny faint">课时费 ' + money(o.amount) + " − 平台服务费 " + money(o.serviceFee) +
        '</span><span class="tiny faint">实际到账 ' + money(o.teacherIncome) + "</span></div></div>").join("")
      : '<p class="small faint">暂无已完成的课时收入</p>') +
    "</div>" +

    '<div class="card"><div class="card-title"><h3>账户流水</h3><span class="more">最近 ' + txns.length + " 条</span></div>" +
    (txns.length
      ? txns.map((t) =>
        '<div class="income-row"><div class="row between"><span class="small">' + esc(TXN_LABEL[t.type] || t.type) + "</span>" +
        '<span class="am" style="color:' + (t.amount >= 0 ? "var(--brand-op-dark)" : "var(--ink)") + '">' +
        (t.amount >= 0 ? "+" : "-") + money(Math.abs(t.amount)) + "</span></div>" +
        '<div class="tiny faint mt8">' + esc(t.remark || "") + " · " + fmtDate(t.created_at, "time") +
        (t.balance_after != null ? " · 余额 " + money(t.balance_after) : "") + "</div></div>").join("")
      : '<p class="small faint">暂无流水</p>') +
    "</div>" +

    '<div class="card"><div class="card-title"><h3>提现记录</h3><span class="more">手续费 ' + (Number(rule.withdraw_fee_rate || 0) * 100).toFixed(1) + "%</span></div>" +
    ((wds.list || []).length
      ? wds.list.map((r) =>
        '<div class="income-row"><div class="row between"><span class="small">' + money(r.amount) + " → 微信 " + esc(r.account) + "</span>" +
        statusBadge(r.status === "pending" ? "pending" : r.status === "paid" || r.status === "approved" ? "approved" : "rejected", WITHDRAW_STATUS[r.status] || r.status) +
        "</div>" +
        '<div class="tiny faint mt8">手续费 ' + money(r.fee) + " · 实际到账 " + money(r.actual) + " · " + fmtDate(r.created_at, "time") + "</div></div>").join("")
      : '<p class="small faint">暂无提现记录</p>') +
    '<p class="tiny faint mt8">最低提现 ' + money(rule.min_withdraw ?? 10000) + "，提现申请由平台审核后打款。</p></div>"
  );

  setActions({
    withdraw: () => withdrawSheet(d),
  });
}

/* ---------------- 路由：我的服务 ---------------- */
function serviceFormSheet(svc, dict, onSaved) {
  const isNew = !svc;
  const draft = {
    id: svc ? svc.id : null,
    title: svc ? svc.title : "",
    subjects: svc ? String(svc.subjects || "").split(",").filter(Boolean) : [],
    stages: svc ? String(svc.stages || "").split(",").filter(Boolean) : [],
    price: svc ? yuan(svc.price) : "",
    coverRadiusKm: svc ? svc.cover_radius_km : 5,
    description: svc ? svc.description || "" : "",
  };
  const html =
    '<div class="field"><label>服务标题<span class="req">*</span></label>' +
    '<input class="input" data-sv="title" value="' + esc(draft.title) + '" placeholder="如 初中数学一对一上门辅导"></div>' +
    '<div class="field"><label>擅长科目</label>' + chipPicker("svc-subjects", dict.subjects || [], draft.subjects) + "</div>" +
    '<div class="field"><label>适用学段</label>' + chipPicker("svc-stages", dict.stages || [], draft.stages) + "</div>" +
    '<div class="field-row"><div class="field"><label>课时价格（元）<span class="req">*</span></label>' +
    '<input class="input" data-sv="price" type="number" min="1" step="1" value="' + esc(draft.price) + '" placeholder="如 200"></div>' +
    '<div class="field"><label>覆盖半径（km）</label>' +
    '<input class="input" data-sv="coverRadiusKm" type="number" min="1" step="1" value="' + esc(draft.coverRadiusKm) + '"></div></div>' +
    '<div class="field"><label>服务说明</label>' +
    '<textarea class="textarea" data-sv="description" placeholder="教学方式、提分计划、课后反馈等">' + esc(draft.description) + "</textarea></div>" +
    '<div class="hint">上架后家长可在您的详情页直接预约下单；下架不影响已成交订单。</div>';

  const submit = async () => {
    if (!draft.title.trim()) return toastErr("请填写服务标题");
    if (!(Number(draft.price) > 0)) return toastErr("请填写课时价格");
    if (!draft.subjects.length) return toastErr("请至少选择一个科目");
    const body = {
      title: draft.title.trim(),
      subjects: draft.subjects.join(","),
      stages: draft.stages.join(","),
      price: cents(draft.price),
      coverRadiusKm: Number(draft.coverRadiusKm) || 5,
      description: draft.description.trim(),
    };
    try {
      if (draft.id) await api.put("/api/teacher/services/" + draft.id, body);
      else await api.post("/api/teacher/services", body);
      toastOk(draft.id ? "服务已更新" : "服务已上架");
      onSaved();
    } catch (err) {
      onError(err);
    }
  };

  const s = sheet(isNew ? "新增服务" : "编辑服务", html, [{ label: "取消" }, { label: "保存", class: "btn-primary", onClick: submit }]);
  bindPicker(s.el, "svc-subjects");
  bindPicker(s.el, "svc-stages");
  $$("[data-sv]", s.el).forEach((node) => {
    const k = node.dataset.sv;
    node.addEventListener("input", () => {
      draft[k] = k === "price" || k === "coverRadiusKm" ? Number(node.value) : node.value;
    });
  });
  s.el.querySelectorAll('[data-picker="svc-subjects"] [data-pick]').forEach((el) => {
    el.addEventListener("click", () => {
      draft.subjects = readPicker(s.el, "svc-subjects");
    });
  });
  s.el.querySelectorAll('[data-picker="svc-stages"] [data-pick]').forEach((el) => {
    el.addEventListener("click", () => {
      draft.stages = readPicker(s.el, "svc-stages");
    });
  });
}

async function servicesView() {
  chrome({
    title: "我的服务", plain: true, back: true,
    right: '<button class="btn btn-xs btn-ghost" data-act="new">＋ 新增</button>',
  });
  setBody(loadingHtml());
  let list;
  try {
    list = await api.get("/api/teacher/services");
  } catch (err) {
    if (err && err.status === 401) throw err;
    setBody(notApprovedHtml(err));
    setActions({});
    return;
  }
  const dict = await getDict();
  state.services = list || [];
  const on = (list || []).filter((s) => s.status === "on");
  const off = (list || []).filter((s) => s.status !== "on");

  const card = (s) =>
    '<div class="card"><div class="row between"><div class="grow"><div class="row" style="gap:6px;flex-wrap:wrap">' +
    '<b style="font-size:15px">' + esc(s.title) + "</b>" +
    statusBadge(s.status === "on" ? "on" : "off", s.status === "on" ? "上架中" : "已下架") + "</div>" +
    '<div class="row wrap mt8" style="gap:4px">' + String(s.subjects || "").split(",").filter(Boolean).map((x) => '<span class="tag">' + esc(x) + "</span>").join("") +
    String(s.stages || "").split(",").filter(Boolean).map((x) => '<span class="tag">' + esc(x) + "</span>").join("") + "</div>" +
    (s.description ? '<div class="tiny faint mt8">' + esc(s.description) + "</div>" : "") +
    '<div class="tiny faint mt8">覆盖 ' + (s.cover_radius_km ?? "-") + " km</div></div>" +
    '<div class="center"><div class="money" style="font-size:17px;color:var(--brand)">' + money(s.price) + '</div><div class="tiny faint">/课时</div></div></div>' +
    '<div class="btn-row mt12">' +
    '<button class="btn btn-outline btn-sm" data-act="toggle" data-id="' + s.id + '">' + (s.status === "on" ? "下架" : "上架") + "</button>" +
    '<button class="btn btn-ghost btn-sm" data-act="edit" data-id="' + s.id + '">编辑</button>' +
    '<button class="btn btn-outline btn-sm" data-act="del" data-id="' + s.id + '">删除</button>' +
    "</div></div>";

  setBody(
    '<div class="section-title"><span class="bar"></span>上架中（' + on.length + "）</div>" +
    (on.length ? on.map(card).join("") : '<div class="card">' + emptyHtml("还没有上架的服务，家长无法直接预约", "📦") + "</div>") +
    (off.length ? '<div class="section-title mt16"><span class="bar"></span>已下架（' + off.length + "）</div>" + off.map(card).join("") : "") +
    '<button class="btn btn-primary btn-block mt16" data-act="new" style="margin-bottom:24px">＋ 新增服务</button>'
  );

  const map = new Map((list || []).map((s) => [String(s.id), s]));
  setActions({
    new: () => serviceFormSheet(null, dict, () => ROUTER.render()),
    edit: (el) => serviceFormSheet(map.get(el.dataset.id), dict, () => ROUTER.render()),
    toggle: async (el) => {
      const r = await api.post("/api/teacher/services/" + el.dataset.id + "/toggle", {});
      toastOk(r.status === "on" ? "服务已上架" : "服务已下架");
      ROUTER.render();
    },
    del: async (el) => {
      const yes = await confirmDialog("删除服务", "删除后家长无法再预约该服务，已成交订单不受影响。确认删除？", "删除", true);
      if (!yes) return;
      await api.del("/api/teacher/services/" + el.dataset.id);
      toastOk("服务已删除");
      ROUTER.render();
    },
  });
}

/* ---------------- 路由：排课日历 ---------------- */
function monthAdd(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

async function calendarView() {
  chrome({ title: "排课日历", plain: true, back: true });
  setBody(loadingHtml());
  const month = state.calMonth || new Date().toISOString().slice(0, 7);
  state.calMonth = month;
  let d;
  try {
    d = await api.get("/api/teacher/calendar", { month });
  } catch (err) {
    if (err && err.status === 401) throw err;
    setBody(notApprovedHtml(err));
    setActions({});
    return;
  }
  const lessons = d.lessons || [];
  const byDate = new Map();
  lessons.forEach((l) => {
    const key = localDateStr(l.lesson_time);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(l);
  });
  const conflicts = [...byDate.entries()].filter(([, arr]) => {
    const hours = arr.map((l) => new Date(l.lesson_time).getHours());
    return new Set(hours).size < hours.length;
  }).map(([k]) => k);

  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const startPad = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = todayStr();
  const sel = state.calDay || today;

  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push('<div class="cal-cell mute"></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const key = month + "-" + String(day).padStart(2, "0");
    const has = byDate.has(key) && byDate.get(key).length;
    cells.push('<button type="button" class="cal-cell ' + (has ? "has" : "") + " " + (key === today ? "today" : "") + " " +
      (key === sel ? "on" : "") + '" data-act="pick" data-day="' + key + '" aria-label="' + key + (has ? " 有 " + byDate.get(key).length + " 节课" : " 无课") + '">' +
      '<span class="cn">' + day + "</span>" + (has ? '<span class="cdot"></span>' : "") + "</button>");
  }

  const monthView = '<div class="cal-head">' + WEEK.map((w) => "<span>" + w.slice(1) + "</span>").join("") + "</div>" +
    '<div class="cal-grid">' + cells.join("") + "</div>";

  const dayLessons = byDate.get(sel) || [];
  let weekView = "";
  if (state.calView === "week") {
    const base = sel ? new Date(sel + "T00:00:00") : new Date();
    const monday = new Date(base.getTime() - ((base.getDay() + 6) % 7) * 86400000);
    weekView = '<div class="week-grid">' + WEEK.map((w, i) => {
      const dt = new Date(monday.getTime() + i * 86400000);
      const key = localDateStr(dt.toISOString());
      const arr = byDate.get(key) || [];
      return '<div class="week-col"><div class="wd">' + w + "<br>" + key.slice(5) + "</div>" +
        arr.map((l) => '<div class="lesson">' + fmtDate(l.lesson_time, "hm") + "<br>" + esc(l.subject) + "</div>").join("") + "</div>";
    }).join("") + "</div>";
  }

  const detail = '<div class="card"><div class="card-title"><h3>' + esc(sel) + " 课程</h3>" +
    '<span class="more">' + dayLessons.length + " 节</span></div>" +
    (dayLessons.length
      ? dayLessons.map((l) =>
        '<div class="spec-item" data-go="/order/' + l.id + '" role="link" tabindex="0"><div class="grow">' +
        '<div class="row between"><span class="small bold">' + fmtDate(l.lesson_time, "hm") + " " + esc(l.subject) + " · " + esc(l.stage) + "</span>" +
        statusBadge(l.status, {
          awaiting_payment: "待支付", pending_class: "待上门", in_class: "上课中",
          awaiting_parent_confirm: "待家长确认", completed: "已完成", settled: "已结算",
        }[l.status] || l.status) + "</div>" +
        '<div class="tiny faint mt8">' + esc(l.order_no) + "</div>" +
        '<div class="tiny faint mt8">' + esc(l.address || "") + "</div></div>" +
        '<span class="faint" aria-hidden="true">›</span></div>').join("")
      : '<p class="small faint">当天暂无课程安排</p>') + "</div>";

  setBody(
    '<div class="row between mb12"><button class="btn btn-sm btn-outline" data-act="prev">‹ 上个月</button>' +
    '<b style="font-size:16px">' + month.replace("-", " 年 ") + " 月</b>" +
    '<button class="btn btn-sm btn-outline" data-act="next">下个月 ›</button></div>' +
    '<div class="segmented mb16">' +
    '<button class="' + (state.calView === "month" ? "on" : "") + '" data-act="viewMonth">月视图</button>' +
    '<button class="' + (state.calView === "week" ? "on" : "") + '" data-act="viewWeek">周视图</button></div>' +
    '<div class="card">' + (state.calView === "week" ? weekView : monthView) +
    '<p class="tiny faint mt12">圆点表示当天有课程；点击日期查看当天安排。</p></div>' +
    (conflicts.length
      ? '<div class="hint" style="border-radius:12px;margin-bottom:16px">⚠️ 检测到 ' + conflicts.length + " 个日期存在同一时段的多节课程（" +
        esc(conflicts.slice(0, 3).join("、")) + "），请及时与家长协调改期。</div>"
      : "") +
    detail +
    ((d.schedule || []).length
      ? '<div class="card"><div class="card-title"><h3>我的可授课时间</h3><span class="more" data-go="/profile" role="link" tabindex="0">修改 ›</span></div>' +
        (d.schedule || []).map((r) => kv(WEEK[(Number(r.day) || 1) - 1], esc((r.slots || []).join(" / ")))).join("") + "</div>"
      : "")
  );

  setActions({
    pick: (el) => {
      state.calDay = el.dataset.day;
      ROUTER.render();
    },
    prev: () => {
      state.calMonth = monthAdd(month, -1);
      state.calDay = "";
      ROUTER.render();
    },
    next: () => {
      state.calMonth = monthAdd(month, 1);
      state.calDay = "";
      ROUTER.render();
    },
    viewMonth: () => {
      state.calView = "month";
      ROUTER.render();
    },
    viewWeek: () => {
      state.calView = "week";
      ROUTER.render();
    },
  });
}

/* ---------------- 路由：个人中心 ---------------- */
async function meView() {
  chrome({ title: "我的", tab: "/me" });
  setBody(loadingHtml());
  let d;
  try {
    d = await api.get("/api/teacher/profile-page");
  } catch (err) {
    if (err && err.status === 401) throw err;
    setBody(notApprovedHtml(err));
    setActions({
      apply: () => {
        location.hash = "#/apply";
      },
    });
    return;
  }
  const p = d.profile || {};
  const w = d.wallet || {};
  const stats = d.stats || {};
  setBody(
    '<div class="card"><div class="row" style="gap:14px">' + avatar(p.nickname, p.avatar, "xl") +
    '<div class="grow"><div class="row" style="gap:6px;flex-wrap:wrap"><b style="font-size:17px">' + esc(p.nickname || "教员") + "</b>" +
    levelBadge(p.level, p.levelName) + "</div>" +
    '<div class="tiny faint mt8">' + esc(identityText(p.identityType)) + " · " + esc(p.phone || "-") + "</div>" +
    '<div class="row mt8" style="gap:8px;font-size:11px;color:var(--ink-3)">' + stars(p.ratingAvg) +
    "<span>" + Number(p.ratingAvg || 0).toFixed(1) + "（" + (p.ratingCount || 0) + "）</span></div></div>" +
    '<button class="btn btn-xs btn-ghost" data-go="/profile">编辑资料</button></div>' +
    '<div class="stat-grid three mt16">' +
    '<div class="stat"><div class="label">订单</div><div class="value">' + (stats.orders || 0) + "</div></div>" +
    '<div class="stat"><div class="label">服务</div><div class="value">' + (stats.services || 0) + "</div></div>" +
    '<div class="stat"><div class="label">评价</div><div class="value">' + (stats.reviews || 0) + "</div></div>" +
    "</div>" +
    '<div class="row between mt12"><span class="tiny faint">可提现 ' + money(w.balance) + " · 冻结 " + money(w.frozen) + "</span>" +
    '<button class="btn btn-xs btn-ghost" data-go="/income">钱包</button></div></div>' +

    (d.auditStatus !== "approved"
      ? '<div class="card"><div class="bold small">资质' + (d.auditStatus === "pending" ? "审核中" : "未通过") + "</div>" +
        (d.rejectReason ? '<div class="tiny faint mt8">驳回原因：' + esc(d.rejectReason) + "</div>" : "") +
        '<button class="btn btn-ghost btn-sm btn-block mt12" data-go="/apply">查看入驻资料</button></div>'
      : '<div class="card tight row between"><div class="row" style="gap:8px"><span style="font-size:18px">✅</span>' +
        '<div><div class="bold small">资质已通过审核</div><div class="tiny faint">身份证 ' + esc(p.idCard || "-") + "</div></div></div>" +
        '<span class="badge green">已认证</span></div>') +

    '<div class="card"><div class="card-title"><h3>教学资料</h3><span class="more">科目 / 学段 / 覆盖</span></div>' +
    '<div class="row wrap" style="gap:4px">' + (p.subjects || []).map((s) => '<span class="tag">' + esc(s) + "</span>").join("") +
    (p.stages || []).map((s) => '<span class="tag">' + esc(s) + "</span>").join("") + "</div>" +
    kv("课时单价", money(p.hourlyPrice)) +
    kv("服务半径", (p.serviceRadiusKm ?? "-") + " km") +
    kv("覆盖区域", esc(p.coverArea || "未填写")) +
    kv("服务基点", esc(String(p.baseLat ?? "-")) + ", " + esc(String(p.baseLng ?? "-"))) +
    "</div>" +

    '<div class="card"><div class="card-title"><h3>常用功能</h3></div>' +
    qItem("📦", "我的服务", (stats.services || 0) + " 个", "/services") +
    qItem("📅", "排课日历", "查看本月课程", "/calendar") +
    qItem("🏆", "我的等级权益", esc(p.levelName || p.level || ""), "/level") +
    qItem("💰", "收入与钱包", money(w.balance), "/income") +
    qItem("⭐", "评价管理", (p.ratingCount || 0) + " 条评价", "/reviews") +
    qItem("💬", "消息中心", state.unread ? state.unread + " 条未读" : "已读", "/messages") +
    qItem("🪪", "入驻认证", d.auditStatus === "approved" ? "已通过" : "待完善", "/apply") +
    qItem("⚙️", "设置", "协议与账号", "/settings") +
    "</div>" +
    '<button class="btn btn-outline btn-block" data-act="logout" style="margin-bottom:24px">退出登录</button>'
  );
  setActions({
    logout: async () => {
      const yes = await confirmDialog("退出登录", "退出后需重新验证手机号登录。确认退出？", "退出登录", true);
      if (!yes) return;
      try {
        await api.post("/api/auth/logout", {});
      } catch {
        /* 忽略 */
      }
      session.clear();
      showLogin();
    },
  });
}

/* ---------------- 路由：评价管理 ---------------- */
async function reviewsView() {
  chrome({ title: "评价管理", plain: true, back: true });
  setBody(loadingHtml());
  let d;
  try {
    d = await api.get("/api/teacher/reviews");
  } catch (err) {
    if (err && err.status === 401) throw err;
    setBody(notApprovedHtml(err));
    setActions({});
    return;
  }
  const list = d.list || [];
  const appealText = { none: "", pending: "申诉审核中", accepted: "申诉通过", rejected: "申诉未通过" };
  setBody(
    '<div class="card"><div class="row between"><div><div class="tiny faint">综合评分</div>' +
    '<div style="font-size:26px;font-weight:800">' + Number(d.ratingAvg || 0).toFixed(1) + "</div>" + stars(d.ratingAvg) + "</div>" +
    '<div style="text-align:right"><div class="tiny faint">评价数</div><div class="bold" style="font-size:18px">' + (d.ratingCount || 0) + "</div>" +
    '<div class="tiny faint mt8">仅公开展示已发布评价</div></div></div>' +
    '<div class="hint green mt12">好评按家长评价权重加分（4-5 星 +5 × 权重）；差评可提交申诉，审核通过后由平台隐藏。</div></div>' +
    '<div class="section-title"><span class="bar"></span>全部评价（' + list.length + "）</div>" +
    (list.length
      ? list.map((r) =>
        '<div class="card"><div class="row between"><div class="row" style="gap:6px">' + stars(r.score) +
        '<span class="tiny faint">' + esc(r.parentName || "家长") + "</span></div>" +
        '<span class="tiny faint">' + fmtDate(r.created_at, "date") + "</span></div>" +
        (r.content ? '<p class="small mt8" style="line-height:1.7;color:var(--ink-2)">' + esc(r.content) + "</p>" : "") +
        '<div class="row wrap mt8" style="gap:4px">' + (r.tags || []).map((t) => '<span class="tag">' + esc(t) + "</span>").join("") +
        '<span class="tag">权重 ' + (r.weight || 1) + "</span>" +
        '<span class="tag">' + esc(r.order_no || "") + "</span></div>" +
        (r.score <= 3
          ? '<div class="row between mt12"><span class="tiny faint">' + esc(appealText[r.appeal_status] || "") + "</span>" +
            (r.appeal_status === "none"
              ? '<button class="btn btn-outline btn-xs" data-act="appeal" data-id="' + r.id + '">差评申诉</button>'
              : '<span class="badge gray">' + esc(appealText[r.appeal_status] || "-") + "</span>") + "</div>"
          : "") +
        "</div>").join("")
      : '<div class="card">' + emptyHtml("还没有收到评价", "⭐") + "</div>")
  );
  setActions({
    appeal: async (el) => {
      const reason = await promptDialog("差评申诉", "请说明申诉理由（如与事实不符、家长误操作等）", { value: "" });
      if (!reason) return;
      await api.post("/api/teacher/reviews/" + el.dataset.id + "/appeal", { reason });
      toastOk("申诉已提交，平台将在 24 小时内处理");
      ROUTER.render();
    },
  });
}

/* ---------------- 路由：资料修改 ---------------- */
async function profileView() {
  chrome({ title: "资料修改", plain: true, back: true });
  setBody(loadingHtml());
  const [d, dict] = await Promise.all([api.get("/api/teacher/profile"), getDict()]);
  if (!d.applied) {
    setBody('<div class="card">' + emptyHtml("尚未提交入驻资料，请先完成认证", "🪪") +
      '<button class="btn btn-primary btn-sm btn-block" data-go="/apply">去入驻认证</button></div>');
    setActions({});
    return;
  }
  const p = d.profile || {};
  setBody(
    '<div class="card"><div class="card-title"><h3>教学资料</h3><span class="more">修改后立即生效</span></div>' +
    '<form data-form="tprofile">' +
    '<div class="field"><label>擅长科目</label>' + chipPicker("pf-subjects", dict.subjects || [], p.subjects || []) + "</div>" +
    '<div class="field"><label>适用学段</label>' + chipPicker("pf-stages", dict.stages || [], p.stages || []) + "</div>" +
    '<div class="field-row"><div class="field"><label for="pf-price">课时单价（元）</label>' +
    '<input class="input" id="pf-price" name="hourlyPrice" type="number" min="1" step="1" value="' + yuan(p.hourlyPrice) + '"></div>' +
    '<div class="field"><label for="pf-radius">服务半径（km）</label>' +
    '<input class="input" id="pf-radius" name="serviceRadiusKm" type="number" min="1" step="1" value="' + (p.serviceRadiusKm ?? 5) + '"></div></div>' +
    '<div class="field"><label for="pf-area">覆盖区域描述</label>' +
    '<input class="input" id="pf-area" name="coverArea" value="' + esc(p.coverArea || "") + '" placeholder="如 西湖区、拱墅区"></div>' +
    '<div class="field"><label for="pf-baseaddr">授课地址（家长可带孩子来这里上课）</label>' +
    '<input class="input" id="pf-baseaddr" name="baseAddress" value="' + esc(p.baseAddress || "") + '" placeholder="如 西湖区文三路 100 号 3 幢 501；留空表示只支持上门">' +
    '<div class="form-hint">填写后，家长预约时可选「我到教员处」；上课地点用上面的服务基点坐标，请一起填准。</div></div>' +
    '<div class="field-row"><div class="field"><label for="pf-lat">服务基点纬度</label>' +
    '<input class="input" id="pf-lat" name="lat" value="' + (p.baseLat ?? DEFAULT_LAT) + '" inputmode="decimal"></div>' +
    '<div class="field"><label for="pf-lng">服务基点经度</label>' +
    '<input class="input" id="pf-lng" name="lng" value="' + (p.baseLng ?? DEFAULT_LNG) + '" inputmode="decimal"></div></div>' +
    '<button type="button" class="btn btn-sm btn-outline mb16" data-fillcoord>📍 填入默认服务基点（' + DEFAULT_LAT + " / " + DEFAULT_LNG + "）</button>" +
    '<div class="field"><label for="pf-schedule">可授课时间</label>' +
    '<textarea class="textarea" id="pf-schedule" name="schedule" style="min-height:96px" placeholder="每行一个时段，如：周一 09:00-11:00 / 14:00-16:00">' + esc(scheduleToText(p.schedule)) + "</textarea>" +
    '<div class="form-hint">格式：星期 + 时段，多个时段用「/」分隔，每行一个星期。</div></div>' +
    '<div class="field"><label for="pf-intro">自我介绍</label>' +
    '<textarea class="textarea" id="pf-intro" name="intro" placeholder="教学经验、提分案例、教学风格">' + esc(p.intro || "") + "</textarea></div>" +
    // 资质材料放在「保存资料」上面（用户反馈的排版口径），图片按身份类型显示：
    // 身份证正反面始终显示；在职教师看教师资格证、在校大学生看学生证、社会兼职看技能证书
    '<div class="divider"></div>' +
    '<div class="card-title" style="margin-top:2px"><h3>资质材料</h3><span class="more">如需更新请重新提交入驻审核</span></div>' +
    kv("身份证", esc(p.idCard || "-") + (p.idCardVerified ? ' <span class="badge ok">人证一致</span>' : ' <span class="badge gray">未识别</span>')) +
    '<div class="field"><label>证件图片</label><div class="uploader">' +
    [["idCardFrontUrl", "身份证正面"], ["idCardBackUrl", "身份证反面"],
      ...({ in_service: [["teacherCertUrl", "教师资格证"]], student: [["eduCertUrl", "学生证"]], part_time: [["skillCertUrl", "技能证书"]] }[p.identityType] || [])]
      .map(([k, label]) => (p[k] ? imageThumb(p[k], label) : ""))
      .join("") +
    ([["idCardFrontUrl", "idCardBackUrl"],
      ...({ in_service: ["teacherCertUrl"], student: ["eduCertUrl"], part_time: ["skillCertUrl"] }[p.identityType] || [])].some((k) => p[k])
      ? ""
      : '<span class="faint tiny">未上传</span>') +
    "</div></div>" +
    (p.idCardName ? kv("证件识别姓名", esc(p.idCardName)) : "") +
    '<p class="tiny faint mt8">当前身份类型：' + esc(identityText(p.identityType)) +
    "。已通过审核的账号修改资质需重新提交审核，当前接口不支持在线替换已审核资质。</p>" +
    '<button class="btn btn-primary btn-block mt16" type="submit">保存资料</button></form></div>'
  );

  bindPicker(bodyEl(), "pf-subjects");
  bindPicker(bodyEl(), "pf-stages");
  const form = $('[data-form="tprofile"]');
  form.addEventListener("click", (e) => {
    if (!e.target.closest("[data-fillcoord]")) return;
    form.lat.value = DEFAULT_LAT;
    form.lng.value = DEFAULT_LNG;
    toast("已填入默认服务基点");
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = formData(form);
    const subjects = readPicker(bodyEl(), "pf-subjects");
    if (!subjects.length) return toastErr("请至少选择一个科目");
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api.put("/api/teacher/profile", {
        intro: fd.intro,
        subjects: subjects.join(","),
        stages: readPicker(bodyEl(), "pf-stages").join(","),
        hourlyPrice: cents(fd.hourlyPrice),
        serviceRadiusKm: Number(fd.serviceRadiusKm) || 5,
        lat: Number(fd.lat),
        lng: Number(fd.lng),
        coverArea: fd.coverArea,
        baseAddress: fd.baseAddress,
        schedule: textToSchedule(fd.schedule),
      });
      toastOk("资料已更新");
      ROUTER.render();
    } catch (err) {
      onError(err);
    } finally {
      btn.disabled = false;
    }
  });
  setActions({});
}

/* ---------------- 证件上传组件（上传 → 缩略图 → 点击预览 → 可删除） ---------------- */
/** 缩略图：传了 URL 才渲染 img，避免出现破图；点图看大图、点 × 删除 */
function imageThumb(url, label = "") {
  if (!url) return "";
  return '<div class="thumb" data-preview="' + esc(url) + '" title="点击查看大图" aria-label="' + esc(label || "查看大图") + '">' +
    '<img src="' + esc(url) + '" alt="' + esc(label || "证件图片") + '" loading="lazy">' +
    '<button type="button" class="del" data-clear-upload aria-label="删除">×</button></div>';
}

/**
 * 上传字段：一张图三种状态（空 / 上传中 / 已有图）。真实值放在隐藏 input 里，
 * 提交时 formData 读到的就是 `/uploads/xxx.png`；meta 区用来放识别结果或提示。
 */
function uploadFieldHtml({ name, label, value = "", hint = "", required = false, metaId = "", accept = "image/png,image/jpeg,image/webp" }) {
  return '<div class="field" data-upload-field="' + name + '">' +
    '<label>' + esc(label) + (required ? '<span class="req">*</span>' : "") + "</label>" +
    '<input type="hidden" name="' + name + '" value="' + esc(value || "") + '">' +
    '<div class="uploader">' +
    (value ? imageThumb(value, label) : "") +
    '<label class="pick" style="' + (value ? "display:none" : "") + '">' +
    '<span class="ico" aria-hidden="true">📷</span><span>上传图片</span>' +
    '<input type="file" accept="' + accept + '" data-upload-input style="display:none"></label>' +
    '<div class="meta"' + (metaId ? ' id="' + metaId + '"' : "") + ">" + (hint ? esc(hint) : "") + "</div>" +
    "</div></div>";
}

/** 全屏看大图（点遮罩关闭） */
function openImageViewer(url) {
  const mask = document.createElement("div");
  mask.className = "img-viewer";
  mask.innerHTML = '<img src="' + esc(url) + '" alt="查看大图">';
  mask.addEventListener("click", () => mask.remove());
  document.body.appendChild(mask);
}

/** FileReader → dataURL（浏览器原生，不引依赖） */
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败，请重新选择"));
    reader.readAsDataURL(file);
  });
}

/**
 * 绑定上传字段：选图 → 读成 dataURL → POST /api/upload → 回填 URL 并刷新缩略图。
 * onUploaded 里可以继续调识别接口（身份证人像面）。
 */
function bindUploadField(form, name, onUploaded) {
  const field = form.querySelector('[data-upload-field="' + name + '"]');
  if (!field) return;
  const input = field.querySelector("[data-upload-input]");
  const hidden = field.querySelector('input[name="' + name + '"]');
  const pick = field.querySelector(".pick");
  const meta = field.querySelector(".meta");
  const uploader = field.querySelector(".uploader");

  uploader.addEventListener("click", (e) => {
    const preview = e.target.closest("[data-preview]");
    if (preview) return openImageViewer(preview.dataset.preview);
    const clear = e.target.closest("[data-clear-upload]");
    if (clear) {
      hidden.value = "";
      const thumb = uploader.querySelector(".thumb");
      if (thumb) thumb.remove();
      pick.style.display = "";
      if (meta) meta.textContent = "";
    }
  });

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) return toastErr("请选择 PNG / JPG / WEBP 图片");
    if (meta) meta.innerHTML = '<span class="spin">上传中…</span>';
    try {
      const dataUrl = await readFileAsDataUrl(file);
      // 原文件名要一起带上：证件识别 mock 靠「姓名_身份证号」解析，真实通道会忽略它
      const uploaded = await api.post("/api/upload", { filename: file.name, dataUrl });
      hidden.value = uploaded.url;
      const oldThumb = uploader.querySelector(".thumb");
      if (oldThumb) oldThumb.remove();
      pick.insertAdjacentHTML("beforebegin", imageThumb(uploaded.url, file.name));
      pick.style.display = "none";
      if (meta) meta.textContent = "已上传，点击图片可放大核对";
      if (onUploaded) await onUploaded(uploaded, meta);
    } catch (err) {
      if (meta) meta.textContent = "";
      onError(err);
    } finally {
      input.value = "";
    }
  });
}

/* ---------------- 路由：入驻认证 ---------------- */
async function applyView() {
  chrome({ title: "入驻认证", plain: true, back: true });
  setBody(loadingHtml());
  const [d, dict] = await Promise.all([api.get("/api/teacher/profile"), getDict()]);
  const p = d.applied ? d.profile || {} : {};
  const status = p.auditStatus || (d.applied ? "pending" : "none");
  const rules = await getRules().catch(() => ({}));
  const identityTypes = (rules && rules.identityTypes) || [];

  if (status === "approved") {
    setBody(
      '<div class="card"><div class="row between"><div><div class="bold">资质已通过审核</div>' +
      '<div class="tiny faint mt8">认证身份：' + esc(identityText(p.identityType)) + "</div></div>" +
      '<span class="badge green">已认证</span></div>' +
      '<div class="divider"></div>' +
      kv("真实姓名", esc(p.realName || "-")) +
      kv("身份证号", esc(p.idCard || "-")) +
      kv("课时单价", money(p.hourlyPrice)) +
      kv("服务半径", (p.serviceRadiusKm ?? "-") + " km") +
      kv("覆盖区域", esc(p.coverArea || "-")) +
      '<div class="hint green mt12">已通过审核的教员可随时上线接单；如需修改教学资料请前往「资料修改」。</div>' +
      '<button class="btn btn-ghost btn-block mt12" data-go="/profile">前往资料修改</button></div>'
    );
    setActions({});
    return;
  }

  const statusCard = d.applied
    ? '<div class="card"><div class="row between"><div><div class="bold">当前状态：' +
      (status === "pending" ? "审核中" : "未通过") + "</div>" +
      '<div class="tiny faint mt8">' + (status === "pending" ? "平台将在 1-2 个工作日内完成审核" : "请根据驳回原因修改后重新提交") + "</div></div>" +
      statusBadge(status === "pending" ? "pending" : "rejected", status === "pending" ? "待审核" : "已驳回") + "</div>" +
      (p.rejectReason ? '<div class="hint mt12" style="border-color:#f7c9c9;background:var(--danger-soft);color:var(--danger)">驳回原因：' + esc(p.rejectReason) + "</div>" : "") +
      "</div>"
    : "";

  setBody(
    statusCard +
    '<div class="card"><div class="card-title"><h3>身份类型</h3><span class="more">影响等级与派单</span></div>' +
    '<div class="segmented" data-picker="identity">' +
    (identityTypes.length ? identityTypes : [
      { value: "student", label: "在校大学生" },
      { value: "in_service", label: "在职教师" },
      { value: "part_time", label: "社会兼职教员" },
    ]).map((it) => '<button type="button" class="' + ((p.identityType || "student") === it.value ? "on" : "") +
      '" data-identity="' + it.value + '">' + esc(it.label) + "</button>").join("") + "</div></div>" +

    '<div class="card"><div class="card-title"><h3>基本资料</h3></div>' +
    '<form data-form="apply">' +
    '<div class="field-row"><div class="field"><label for="ap-name">真实姓名<span class="req">*</span></label>' +
    '<input class="input" id="ap-name" name="realName" value="' + esc(p.realName || "") + '" placeholder="与身份证一致"></div>' +
    '<div class="field"><label for="ap-id">身份证号<span class="req">*</span></label>' +
    '<input class="input" id="ap-id" name="idCard" maxlength="18" value="" placeholder="18 位身份证号"></div></div>' +
    '<div class="form-hint" style="margin-top:-6px;margin-bottom:14px">平台不回显已提交的身份证号，重新提交审核时请再次输入完整号码。</div>' +
    '<div class="field"><label for="ap-intro">自我介绍</label>' +
    '<textarea class="textarea" id="ap-intro" name="intro" placeholder="教学经验、提分案例、教学风格">' + esc(p.intro || "") + "</textarea></div>" +
    '<div class="field"><label>擅长科目<span class="req">*</span></label>' + chipPicker("ap-subjects", dict.subjects || [], p.subjects || []) + "</div>" +
    '<div class="field"><label>适用学段</label>' + chipPicker("ap-stages", dict.stages || [], p.stages || []) + "</div>" +
    '<div class="field-row"><div class="field"><label for="ap-price">课时单价（元）<span class="req">*</span></label>' +
    '<input class="input" id="ap-price" name="hourlyPrice" type="number" min="1" step="1" value="' + (p.hourlyPrice ? yuan(p.hourlyPrice) : "") + '" placeholder="如 200"></div>' +
    '<div class="field"><label for="ap-radius">服务半径（km）</label>' +
    '<input class="input" id="ap-radius" name="serviceRadiusKm" type="number" min="1" step="1" value="' + (p.serviceRadiusKm ?? 5) + '"></div></div>' +
    '<div class="field"><label for="ap-schedule">可授课时间表</label>' +
    '<textarea class="textarea" id="ap-schedule" name="schedule" style="min-height:96px" placeholder="每行一个，如：周一 09:00-11:00 / 14:00-16:00">' + esc(scheduleToText(p.schedule)) + "</textarea>" +
    '<div class="form-hint">格式：星期 + 时段，多个时段用「/」分隔。</div></div>' +
    '<div class="field"><label for="ap-area">覆盖区域描述</label>' +
    '<input class="input" id="ap-area" name="coverArea" value="' + esc(p.coverArea || "") + '" placeholder="如 西湖区文三路周边 5 公里"></div>' +
    '<div class="field"><label for="ap-baseaddr">授课地址（家长可带孩子来这里上课，可不填）</label>' +
    '<input class="input" id="ap-baseaddr" name="baseAddress" value="' + esc(p.baseAddress || "") + '" placeholder="如 西湖区文三路 100 号 3 幢 501">' +
    '<div class="form-hint">填了家长就能选「我到教员处」；上课地点用下面的服务基点坐标。</div></div>' +
    '<div class="field-row"><div class="field"><label for="ap-lat">服务基点纬度</label>' +
    '<input class="input" id="ap-lat" name="lat" value="' + (p.baseLat ?? DEFAULT_LAT) + '" inputmode="decimal"></div>' +
    '<div class="field"><label for="ap-lng">服务基点经度</label>' +
    '<input class="input" id="ap-lng" name="lng" value="' + (p.baseLng ?? DEFAULT_LNG) + '" inputmode="decimal"></div></div>' +
    '<button type="button" class="btn btn-sm btn-outline" data-fillcoord>📍 填入默认基点（' + DEFAULT_LAT + " / " + DEFAULT_LNG + "）</button>" +
    // 资质材料放在提交按钮上面：身份证正反面必传，其余证书按「身份类型」只显示该身份需要的那一张
    '<div class="card-title" style="margin:22px 0 10px"><h3>资质材料</h3><span class="more">身份证必传 · 证书按身份类型</span></div>' +
    '<div class="field-row">' +
    uploadFieldHtml({ name: "idCardFrontUrl", label: "身份证正面（人像面）", value: p.idCardFrontUrl || "", required: true, metaId: "ap-ocr-meta", hint: "必传：上传后自动识别姓名与身份证号，须与上方填写一致" }) +
    uploadFieldHtml({ name: "idCardBackUrl", label: "身份证反面（国徽面）", value: p.idCardBackUrl || "", hint: "建议上传，审核时核对有效期与签发机关" }) +
    "</div>" +
    '<div data-cert="in_service">' +
    uploadFieldHtml({ name: "teacherCertUrl", label: "教师资格证", value: p.teacherCertUrl || "", hint: "在职教师请上传教师资格证，审核通过后才能按在职教师等级派单" }) +
    "</div>" +
    '<div data-cert="student">' +
    uploadFieldHtml({ name: "eduCertUrl", label: "学生证", value: p.eduCertUrl && !String(p.eduCertUrl).startsWith("data:") ? p.eduCertUrl : "", hint: "在校大学生请上传学生证（含注册页），可留空" }) +
    "</div>" +
    '<div data-cert="part_time">' +
    uploadFieldHtml({ name: "skillCertUrl", label: "技能证书", value: p.skillCertUrl || "", hint: "社会兼职请上传技能/职业证书（如普通话等级、竞赛证书），可留空" }) +
    "</div>" +
    '<div class="hint mt12">提交后进入人工审核，审核通过即可上线接单。身份证与证书仅用于平台核验，不对外展示。</div>' +
    '<button class="btn btn-primary btn-block mt16" type="submit">' + (d.applied ? "重新提交审核" : "提交入驻申请") + "</button>" +
    "</form></div>"
  );

  bindPicker(bodyEl(), "ap-subjects");
  bindPicker(bodyEl(), "ap-stages");
  let identity = p.identityType || "student";
  // 资质材料按身份类型只显示对应的那一张证书（身份证正反面始终显示）
  const syncCertBlocks = () => {
    $$("[data-cert]").forEach((box) => {
      box.style.display = box.dataset.cert === identity ? "" : "none";
    });
  };
  syncCertBlocks();
  $$("[data-identity]").forEach((el) => {
    el.addEventListener("click", () => {
      identity = el.dataset.identity;
      $$("[data-identity]").forEach((n) => n.classList.toggle("on", n === el));
      syncCertBlocks();
    });
  });
  const form = $('[data-form="apply"]');
  form.addEventListener("click", (e) => {
    if (!e.target.closest("[data-fillcoord]")) return;
    form.lat.value = DEFAULT_LAT;
    form.lng.value = DEFAULT_LNG;
    toast("已填入默认服务基点");
  });

  // 证件上传：4 类证书 + 身份证正反面。人像面传完立刻识别并校验姓名/号码，不用等提交才报错
  const ocrMeta = $("[data-upload-field='idCardFrontUrl'] .meta");
  const relabel = (el, text, ok) => {
    if (!el) return;
    el.innerHTML = '<span class="' + (ok ? "ok" : "bad") + '">' + esc(text) + "</span>";
  };
  for (const name of ["idCardBackUrl", "eduCertUrl", "teacherCertUrl", "skillCertUrl"]) {
    bindUploadField(form, name);
  }
  bindUploadField(form, "idCardFrontUrl", async (uploaded) => {
    if (!ocrMeta) return;
    ocrMeta.innerHTML = '<span class="spin">识别中…</span>';
    try {
      const r = await api.post("/api/teacher/ocr-idcard", {
        url: uploaded.url,
        realName: String(form.realName.value || "").trim(),
        idCard: String(form.idCard.value || "").trim(),
      });
      if (!r.recognized) {
        relabel(ocrMeta, r.message || "证件未能识别，请换一张更清晰的", false);
        return;
      }
      const who = "识别到：" + r.name + " · " + (r.idCardMasked || "");
      relabel(ocrMeta, r.match && r.match.ok ? who + "（与填写一致）" : who + "；" + (r.message || "与填写不一致"), !!(r.match && r.match.ok));
    } catch (err) {
      ocrMeta.textContent = "";
      onError(err);
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = formData(form);
    if (!String(fd.realName || "").trim()) return toastErr("请填写真实姓名");
    if (!/^\d{17}[\dXx]$/.test(String(fd.idCard || ""))) return toastErr("身份证号格式不正确");
    const subjects = readPicker(bodyEl(), "ap-subjects");
    if (!subjects.length) return toastErr("请至少选择一个擅长科目");
    if (!(Number(fd.hourlyPrice) > 0)) return toastErr("请填写课时单价");
    if (!String(fd.idCardFrontUrl || "").trim()) return toastErr("请上传身份证正面（人像面）");
    if (!String(fd.idCardBackUrl || "").trim()) return toastErr("请上传身份证反面（国徽面）");
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      await api.post("/api/teacher/apply", {
        identityType: identity,
        realName: String(fd.realName).trim(),
        idCard: String(fd.idCard).trim(),
        idCardFrontUrl: fd.idCardFrontUrl || "",
        idCardBackUrl: fd.idCardBackUrl || "",
        eduCertUrl: fd.eduCertUrl || "",
        teacherCertUrl: fd.teacherCertUrl || "",
        skillCertUrl: fd.skillCertUrl || "",
        intro: fd.intro || "",
        subjects: subjects.join(","),
        stages: readPicker(bodyEl(), "ap-stages").join(","),
        hourlyPrice: cents(fd.hourlyPrice),
        serviceRadiusKm: Number(fd.serviceRadiusKm) || 5,
        schedule: textToSchedule(fd.schedule),
        coverArea: fd.coverArea || "",
        baseAddress: fd.baseAddress || "",
        lat: Number(fd.lat),
        lng: Number(fd.lng),
      });
      toastOk("已提交审核，请等待平台核验");
      ROUTER.render();
    } catch (err) {
      onError(err);
      btn.disabled = false;
      btn.textContent = d.applied ? "重新提交审核" : "提交入驻申请";
    }
  });
  setActions({});
}

/* ---------------- 路由：消息 / 设置 / 协议 ---------------- */
const MSG_ICON = { system: "🔔", order: "📋", payment: "💰", risk: "⚠️", notice: "📢" };

async function messagesView() {
  chrome({
    title: "消息中心", plain: true, back: true,
    right: '<div class="row" style="gap:6px"><button class="btn btn-xs btn-ghost" data-act="readAll">全部已读</button>' + bellHtml() + "</div>",
  });
  setBody(loadingHtml());
  const d = await api.get("/api/messages");
  state.unread = d.unread || 0;
  const list = d.list || [];
  setBody(
    '<div class="row between mb12"><span class="section-title" style="margin:0"><span class="bar"></span>共 ' + list.length + " 条</span>" +
    (d.unread ? '<span class="badge danger">' + d.unread + " 条未读</span>" : '<span class="badge gray">全部已读</span>') + "</div>" +
    '<div class="card">' + (list.length
      ? list.map((m) => '<button class="list-item" style="width:100%;background:none;border-left:none;border-right:none;border-top:none;text-align:left;align-items:flex-start" ' +
        'data-act="open" data-id="' + m.id + '" data-link="' + esc(m.link || "") + '" data-read="' + (m.read ? "1" : "0") + '">' +
        '<span style="font-size:19px;line-height:1.2" aria-hidden="true">' + (MSG_ICON[m.type] || "🔔") + "</span>" +
        '<span class="grow" style="min-width:0"><span class="row between" style="gap:8px">' +
        '<span class="title" style="font-weight:' + (m.read ? "600" : "800") + '">' + esc(m.title) + "</span>" +
        (m.read ? "" : '<span class="badge danger" style="flex:0 0 auto">未读</span>') + "</span>" +
        '<span class="meta" style="display:block">' + esc(m.content || "") + "</span>" +
        '<span class="tiny faint" style="display:block;margin-top:4px">' + fromNow(m.created_at) + "</span></span></button>").join("")
      : emptyHtml("暂无消息通知", "💬")) + "</div>"
  );
  setActions({
    open: async (el) => {
      if (el.dataset.read === "0") {
        await api.post("/api/messages/" + el.dataset.id + "/read", {});
        state.unread = Math.max(0, state.unread - 1);
      }
      const link = el.dataset.link;
      if (link && link.startsWith("/")) location.hash = "#" + link;
      else ROUTER.render();
    },
    readAll: async () => {
      await api.post("/api/messages/read-all", {});
      state.unread = 0;
      toastOk("已全部标记为已读");
      ROUTER.render();
    },
  });
}

async function settingsView() {
  chrome({ title: "设置", plain: true, back: true });
  const u = session.user || {};
  setBody(
    '<div class="card"><div class="card-title"><h3>账号</h3></div>' +
    qItem("👤", "资料修改", "", "/profile") +
    qItem("🪪", "入驻认证", "", "/apply") +
    qItem("💬", "消息中心", state.unread ? state.unread + " 条未读" : "已读", "/messages") +
    qItem("💰", "收入与钱包", "", "/income") + "</div>" +
    '<div class="card"><div class="card-title"><h3>关于</h3></div>' +
    qItem("📄", "用户协议", "", "/agreement/user") +
    qItem("🔒", "隐私政策", "", "/agreement/privacy") +
    qItem("↩️", "退款规则", "", "/agreement/refund") +
    '<div class="kv"><span class="k">登录手机号</span><span class="v">' + esc(u.phone || "-") + "</span></div>" +
    '<div class="kv"><span class="k">当前版本</span><span class="v">教员端 v1.0.0</span></div></div>' +
    '<button class="btn btn-outline btn-block" data-act="logout" style="margin-bottom:24px">退出登录</button>'
  );
  setActions({
    logout: async () => {
      const yes = await confirmDialog("退出登录", "退出后需重新验证手机号登录。确认退出？", "退出登录", true);
      if (!yes) return;
      try {
        await api.post("/api/auth/logout", {});
      } catch {
        /* 忽略 */
      }
      session.clear();
      showLogin();
    },
  });
}

async function agreementView({ params }) {
  chrome({ title: "平台协议", plain: true, back: true });
  setBody(loadingHtml());
  const a = await api.get("/api/public/agreements/" + encodeURIComponent(params.key));
  setBody(
    '<div class="card"><div class="card-title"><h3>' + esc(a.title) + "</h3></div>" +
    '<div class="small" style="white-space:pre-wrap;line-height:1.85;color:var(--ink-2)">' + esc(a.content) + "</div></div>"
  );
  setActions({});
}

/* ---------------- 路由注册 ---------------- */
const guard = (fn) => async (ctx) => {
  setActions({});
  clearBar();
  if (!session.token) {
    showLogin();
    return;
  }
  try {
    await fn(ctx);
  } catch (err) {
    if (err && err.status === 401) {
      showLogin();
      return;
    }
    setBody(
      '<div class="empty"><div class="ico">⚠️</div><div>' + esc((err && err.message) || "加载失败") + "</div>" +
      '<button class="btn btn-ghost btn-sm mt16" data-act="retry">重新加载</button></div>'
    );
    setActions({ retry: () => ROUTER && ROUTER.render() });
  }
};

const ROUTES = {
  "/": guard(homeView),
  "/orders": guard(ordersView),
  "/order/:id": guard(orderDetailView),
  "/level": guard(levelView),
  "/income": guard(incomeView),
  "/services": guard(servicesView),
  "/calendar": guard(calendarView),
  "/me": guard(meView),
  "/reviews": guard(reviewsView),
  "/profile": guard(profileView),
  "/apply": guard(applyView),
  "/messages": guard(messagesView),
  "/settings": guard(settingsView),
  "/agreement/:key": guard(agreementView),
};

/* ---------------- 启动 ---------------- */
function bootGlobal() {
  document.addEventListener("click", (e) => {
    const back = e.target.closest("[data-back]");
    if (back) {
      if (history.length > 1) history.back();
      else location.hash = "#/";
      return;
    }
    const act = e.target.closest("[data-act]");
    if (act) {
      e.preventDefault();
      e.stopPropagation();
      runAction(act);
      return;
    }
    const go = e.target.closest("[data-go]");
    if (go) {
      e.preventDefault();
      location.hash = "#" + go.dataset.go;
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const t = e.target;
    if (!t || t.tagName === "BUTTON" || t.tagName === "A" || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
    const go = t.closest("[data-go]");
    if (go) {
      e.preventDefault();
      location.hash = "#" + go.dataset.go;
    }
  });
}

function boot() {
  bootGlobal();
  ROUTER = createRouter(ROUTES, { container: document.querySelector("[data-route]") });
  if (!session.token) {
    showLogin();
    return;
  }
  if (!ensureTeacherRole()) return;
  ROUTER.render();
  refreshUnread();
}

boot();
