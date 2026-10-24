/* ============================================================
   家长端 SPA（哈希路由 · 原生 ES Module）
   流程：定位 → 找教员 / 发需求 → 担保支付 → 上门打卡 → 确认完成 → 评价
   所有金额：后端为「分」整数；展示用 money()/yuan()，提交用 cents()
   ============================================================ */
import { api, session, idemKey, loginByCode, loginByPassword } from "./api.js";
import {
  esc, money, yuan, cents, fmtDate, fromNow, stars, levelBadge, statusBadge,
  avatar, toast, toastOk, toastErr, confirmDialog, promptDialog, sheet,
  createRouter, loadingHtml, emptyHtml, formData,
} from "./ui.js";

/* ---------------- 常量 ---------------- */
const DEFAULT_LAT = 30.2741;
const DEFAULT_LNG = 120.1551;
const POSITIVE_TAGS = ["准时", "耐心", "专业", "讲解清晰", "提分明显", "有责任心"];
const NEGATIVE_TAGS = ["迟到", "敷衍", "讲不清", "频繁改时间", "态度差"];
const IDENTITY = { student: "在校大学生", in_service: "在职教师", part_time: "社会兼职教员" };
const DEMAND_STATUS = { published: "抢单中", paused: "已暂停", revoked: "已撤销", matched: "已确认", closed: "已关闭" };
const TXN_LABEL = {
  pay: "订单支付", refund: "退款到账", lesson_income: "课时费结算", freeze: "课时费冻结",
  unfreeze: "冻结释放", withdraw: "提现", reward: "奖励", agent_share: "片区分成",
};
const MSG_ICON = { system: "🔔", order: "📋", payment: "💰", risk: "⚠️", notice: "📢" };
const TABS = [
  { path: "/", icon: "🏠", label: "首页" },
  { path: "/orders", icon: "📋", label: "订单" },
  { path: "/messages", icon: "💬", label: "消息" },
  { path: "/me", icon: "👤", label: "我的" },
];

/* ---------------- 状态 ---------------- */
const state = {
  unread: 0, dict: null, rules: null, city: "杭州", bar: null, actions: {}, orderCache: new Map(), review: null, teacher: null,
  // 游客态：没有 token 也照常渲染（发布需求页直接可见），只有需要身份的动作才弹登录层
  guest: false,
  // 登录后要接着跑的动作（例如游客点了「发布需求」→ 登录 → 自动继续发布）
  pending: null,
};
let ROUTER = null;

/* ---------------- DOM 助手 ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const CREDIT_LV = { L0: 1, L1: 2, L2: 3, L3: 4 };
const bodyEl = () => document.querySelector("[data-route]");
const hdrEl = () => document.getElementById("hdr");
const tabbarEl = () => document.getElementById("tabbar");
const shellEl = () => document.querySelector(".m-shell");
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const pct = (v) => (Number(v || 0) * 100).toFixed(0) + "%";
const identityText = (v) => IDENTITY[v] || "教员";
const isOn = (el) => !!el?.classList.contains("on");

function setBody(html) {
  const el = bodyEl();
  el.innerHTML = html;
  el.scrollTop = 0;
}

/* ---------------- 浏览器定位（需求 4.1.2 自动定位当前片区） ---------------- */
const GEO_TIMEOUT_MS = 3500;

/** 取得当前位置：成功返回 {lat,lng}；被拒绝/超时/不支持返回 null，由服务端按默认地址回退 */
function locate() {
  if (state.geo !== undefined) return Promise.resolve(state.geo);
  return new Promise((resolve) => {
    const finish = (v) => {
      if (state.geo !== undefined) return;
      state.geo = v;
      resolve(v);
    };
    if (typeof navigator === "undefined" || !navigator.geolocation) return finish(null);
    const timer = setTimeout(() => finish(null), GEO_TIMEOUT_MS);
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          finish({ lat: Number(pos.coords.latitude.toFixed(6)), lng: Number(pos.coords.longitude.toFixed(6)) });
        },
        () => {
          clearTimeout(timer);
          finish(null);
        },
        { timeout: GEO_TIMEOUT_MS, maximumAge: 60000, enableHighAccuracy: false }
      );
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/**
 * 打卡用的定位（P66）：和首页自动定位不同——打卡必须拿到**当前位置**，
 * 不能复用缓存值（否则家长可能用旧坐标「假装到场」），因此单独走一次高精度定位。
 * 被拒绝/超时返回 null，调用方提示「请开启定位权限」。
 */
const CHECKIN_GEO_TIMEOUT_MS = 10000;
function askPosition() {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      toastErr("当前浏览器不支持定位，无法打卡");
      return resolve(null);
    }
    const finish = (v) => {
      if (!v) toastErr("需要授权位置信息才能打卡（请在浏览器/系统设置里允许定位）");
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), CHECKIN_GEO_TIMEOUT_MS);
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          finish({ lat: Number(pos.coords.latitude.toFixed(6)), lng: Number(pos.coords.longitude.toFixed(6)) });
        },
        (err) => {
          clearTimeout(timer);
          finish(null);
          if (err && err.code === 1) toastErr("定位权限被拒绝：打卡需要您的位置");
        },
        { timeout: CHECKIN_GEO_TIMEOUT_MS, maximumAge: 0, enableHighAccuracy: true }
      );
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
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
    state.city = (state.rules.platforms && state.rules.platforms.city) || "杭州";
  }
  return state.rules;
}
async function getReviewTags() {
  try {
    const rules = await getRules();
    const v = (rules && rules.review_scoring) || {};
    return { positive: v.positive_tags || POSITIVE_TAGS, negative: v.negative_tags || NEGATIVE_TAGS };
  } catch {
    return { positive: POSITIVE_TAGS, negative: NEGATIVE_TAGS };
  }
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
function loginHtml() {
  return '' +
    '<div class="login-head"><button class="back-btn" type="button" data-lg="close" aria-label="先随便看看">‹</button></div>' +
    '<div class="brandmark" aria-hidden="true">👨‍👩‍👦</div>' +
    "<h2>家长端登录</h2>" +
    '<p class="lead">地图找教员 · 发布家教需求 · 平台担保支付 · 课后评价<br>登录后即可发布需求、预约教员、查看订单<br>演示账号 <b>13900000301</b>，点击「获取验证码」自动填入</p>' +
    '<div class="card mt16" style="margin-bottom:0">' +
    '<div class="field"><label for="lg-phone">手机号</label>' +
    '<input class="input" id="lg-phone" type="tel" inputmode="numeric" maxlength="11" value="13900000301" autocomplete="tel"></div>' +
    '<div class="field"><label for="lg-code">验证码</label><div class="code-row">' +
    '<input class="input" id="lg-code" inputmode="numeric" maxlength="6" placeholder="6 位数字" autocomplete="one-time-code">' +
    '<button class="btn btn-ghost" type="button" data-lg="send">获取验证码</button></div></div>' +
    '<label class="login-check mt8"><input type="checkbox" id="lg-agree" checked>' +
    "<span>我已阅读并同意《用户协议》《隐私政策》《退款规则》，同意平台按公示规则撮合与结算</span></label>" +
    '<button class="btn btn-primary btn-block mt16" type="button" data-lg="login">登录 / 注册</button>' +
    '<div class="or-line"><span>或</span></div>' +
    '<button class="btn btn-wechat btn-block" type="button" data-lg="wechat">💬 微信一键登录</button>' +
    '<button class="btn btn-sm btn-ghost btn-block mt8" type="button" data-lg="pwd" style="box-shadow:none">使用演示密码登录（a123456）</button>' +
    "</div>" +
    '<p class="tiny faint mt16 center">登录即代表同意平台仅提供信息撮合服务，教员资质由平台人工核验；不登录也能先看需求表单</p>';
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

function ensureParentRole() {
  const role = session.user && session.user.role;
  if (role !== "parent") {
    session.clear();
    toastErr("该账号不是家长角色" + (role ? "（当前：" + role + "）" : "") + "，请使用家长演示账号");
    showLogin();
    return false;
  }
  return true;
}

/* ---------------- 游客态 / 动作前登录 ---------------- */
/** 没有 token 就是游客：页面照常渲染，只有需要身份的动作才弹登录层 */
const isGuest = () => !session.token;

/** 游客可浏览的数据源前缀：登录前后同一个视图，只换接口前缀 */
const apiBase = () => (isGuest() ? "/api/public" : "/api/parent");

/**
 * 动作守卫：游客先弹登录层，并把「登录成功后要接着做的事」记下来。
 * 这样「点发布需求 → 弹登录 → 微信一键登录 → 自动发布」是一条连贯的线，而不是丢掉表单重填。
 */
function requireLogin(pending) {
  if (!isGuest()) return true;
  state.pending = typeof pending === "function" ? pending : null;
  showLogin();
  return false;
}

/** 关闭登录层，回到刚才看到的页面（登录不是墙，只是动作前的一道门） */
function closeLogin() {
  const layer = document.querySelector(".login-layer");
  if (layer) layer.remove();
  state.pending = null;
  if (ROUTER) ROUTER.render();
}

function bindLogin(root) {
  const phoneEl = $("#lg-phone", root);
  const codeEl = $("#lg-code", root);
  root.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-lg]");
    if (!btn) return;
    const kind = btn.dataset.lg;
    const phone = (phoneEl.value || "").trim();
    const label = btn.textContent;
    const busy = (on, txt) => {
      btn.disabled = on;
      btn.textContent = on ? txt : label;
    };

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

    if (kind === "close") {
      closeLogin();
      return;
    }

    if (!$("#lg-agree", root).checked) return toastErr("请先阅读并同意平台协议");
    busy(true, "登录中…");
    try {
      if (kind === "wechat") {
        const r = await api.post("/api/auth/wechat", { code: "demo-" + Math.random().toString(36).slice(2, 8) });
        session.save(r.token, r.user);
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
      if (!ensureParentRole()) return;
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
  state.guest = false;
  await refreshUnread();
  if (!session.token) return;
  if (ROUTER) ROUTER.render();
  // 登录前点的动作（发布需求 / 立即预约）在登录后自动接着做，用户不用把表单重填一遍
  const pending = state.pending;
  state.pending = null;
  if (pending) {
    try {
      await pending();
    } catch (err) {
      onError(err);
    }
  }
}

/* ---------------- 通用片段 ---------------- */
function bannerHtml(banners) {
  if (!banners || !banners.length) return "";
  return '<div class="banner-scroll">' + banners.map((b) =>
    '<div class="banner-card"><div class="bt">' + esc(b.title) + "</div>" +
    '<div class="bp">' + esc(b.content || "平台担保交易，教员资质人工核验") + "</div>" +
    '<span class="em" aria-hidden="true">📚</span></div>'
  ).join("") + "</div>";
}

function noticesHtml(notices) {
  if (!notices || !notices.length) return "";
  return '<div class="card"><div class="card-title"><h3>📢 平台公告</h3></div>' +
    notices.map((n) =>
      '<div class="notice-row">' + (n.pinned ? '<span class="pin">置顶</span>' : "") +
      '<span class="nt"><b>' + esc(n.title) + "</b>" + (n.content ? '<br><span class="faint tiny">' + esc(n.content) + "</span>" : "") + "</span></div>"
    ).join("") + "</div>";
}

function complianceHtml(text) {
  if (!text) return "";
  return '<div class="hint" style="border-radius:12px;margin-bottom:16px">⚠️ ' + esc(text) + "</div>";
}

function mapBoardHtml(teachers, center) {
  const c = center || { lat: DEFAULT_LAT, lng: DEFAULT_LNG };
  const pins = (teachers || []).map((t, i) =>
    '<div class="map-pin" style="' + pinPos(t, c, i) + '" data-go="/teacher/' + t.id + '" role="link" tabindex="0" ' +
    'aria-label="' + esc(t.nickname) + " 距离 " + (t.distanceKm ?? "-") + ' 公里">' +
    '<div class="bubble">' + avatar(t.nickname, t.avatar) + levelBadge(t.level, t.levelName) +
    "<b>" + (t.distanceKm ?? "-") + "km</b></div>" +
    '<div class="stem"></div><div class="foot"></div></div>'
  ).join("");
  return '<div class="map-board mb16">' +
    '<div class="map-pin me" style="left:50%;top:56%"><div class="bubble">我的位置</div><div class="stem"></div><div class="foot"></div></div>' +
    pins +
    '<div class="map-legend"><span>🔵 教员</span><span>🔴 当前位置</span><span>共 ' + (teachers || []).length + " 位</span></div>" +
    "</div>";
}

function pinPos(t, center, i) {
  const lat = Number(t.baseLat ?? center.lat);
  const lng = Number(t.baseLng ?? center.lng);
  const span = 0.05;
  let x = 50 + ((lng - center.lng) / span) * 100;
  let y = 56 - ((lat - center.lat) / span) * 100;
  if (Math.abs(lng - center.lng) < 1e-6 && Math.abs(lat - center.lat) < 1e-6) {
    x += (i % 3) * 13 - 13;
    y -= (i % 2) * 10;
  }
  return "left:" + clamp(x, 10, 90).toFixed(1) + "%;top:" + clamp(y, 14, 88).toFixed(1) + "%";
}

function teacherRow(t, extra = "") {
  const subs = (t.subjects || []).slice(0, 4).map((s) => '<span class="tag">' + esc(s) + "</span>").join(" ");
  return '<article class="card t-row" data-go="/teacher/' + t.id + '" role="link" tabindex="0">' +
    '<div class="row" style="gap:12px;align-items:flex-start">' +
    avatar(t.nickname, t.avatar, "lg") +
    '<div class="grow">' +
    '<div class="row" style="gap:6px"><b style="font-size:15px">' + esc(t.nickname) + "</b>" + levelBadge(t.level, t.levelName) +
    (t.online ? '<span class="badge green">在线</span>' : "") +
    '<span style="margin-left:auto" class="money">' + money(t.hourlyPrice) + '</span>' +
    '<span class="tiny faint">/课时</span></div>' +
    '<div class="row wrap" style="gap:4px;margin-top:6px">' + subs + "</div>" +
    '<div class="row" style="gap:10px;margin-top:7px;font-size:11px;color:var(--ink-3);flex-wrap:wrap">' +
    "<span>⭐ " + Number(t.ratingAvg || 0).toFixed(1) + "（" + (t.ratingCount || 0) + "）</span>" +
    "<span>已授课 " + (t.completedLessons || 0) + " 节</span>" +
    (t.distanceKm != null ? "<span>📍 " + t.distanceKm + " km</span>" : "") +
    "<span>" + esc(identityText(t.identityType)) + "</span>" +
    "</div>" + extra + "</div></div></article>";
}

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

function timeLabel(times) {
  if (!times || !times.length) return "时间待沟通";
  return times.map((t) => (t.date || "") + " " + (t.start || "") + "-" + (t.end || "")).join("；");
}

/* ---------------- 需求表单 ---------------- */
function timeRowHtml(t = {}) {
  return '<div class="time-row" data-time-row>' +
    '<input class="input" type="date" data-t="date" value="' + esc(t.date || "") + '" aria-label="上课日期">' +
    '<input class="input" type="time" data-t="start" value="' + esc(t.start || "09:00") + '" aria-label="开始时间">' +
    '<input class="input" type="time" data-t="end" value="' + esc(t.end || "11:00") + '" aria-label="结束时间">' +
    '<button type="button" class="btn btn-xs btn-outline" data-deltime aria-label="删除该时间段">✕</button></div>';
}

function timesBlockHtml(times = [{}]) {
  const list = times && times.length ? times : [{}];
  return '<div class="time-legend" aria-hidden="true"><span>日期</span><span>开始</span><span>结束</span><span></span></div>' +
    '<div data-times>' + list.map((t) => timeRowHtml(t)).join("") + "</div>" +
    '<button type="button" class="btn btn-sm btn-ghost mt8" data-addtime>＋ 添加时间段</button>';
}

function demandFormHtml({ dict, addrs, urgentFee, urgentMaxFee = null, mode = "quick", defaultId = null }) {
  const stages = (dict.stages || []).map((s) => '<option value="' + esc(s) + '">' + esc(s) + "</option>").join("");
  const subjects = (dict.subjects || []).map((s) => '<option value="' + esc(s) + '">' + esc(s) + "</option>").join("");
  const chosen = addrs.find((a) => String(a.id) === String(defaultId)) || addrs.find((a) => a.is_default) || addrs[0] || null;
  const addrOptions = addrs.map((a) =>
    '<option value="' + a.id + '" ' + (chosen && a.id === chosen.id ? "selected" : "") + ">" + esc(a.label) + " · " + esc(a.address) + "</option>"
  ).join("");
  return '<form data-form="demand" novalidate>' +
    '<div class="field-row">' +
    '<div class="field"><label for="d-stage">学段<span class="req">*</span></label><select class="select" id="d-stage" name="stage">' + stages + "</select></div>" +
    '<div class="field"><label for="d-subject">科目<span class="req">*</span></label><select class="select" id="d-subject" name="subject">' + subjects + "</select></div>" +
    "</div>" +
    '<div class="field"><label>上课形式</label><div class="row" style="gap:6px">' +
    '<button type="button" class="chip on" data-place="home">🏠 教员上门</button>' +
    '<button type="button" class="chip" data-place="teacher_place">📍 我到教员处</button></div>' +
    '<div class="form-hint" data-place-hint>教员到您填写的上课地址授课</div></div>' +
    '<div class="field"><label for="d-address">上课地址<span class="req">*</span></label>' +
    (addrs.length
      ? '<select class="select mb8" data-pickaddr aria-label="选择已存地址">' + addrOptions + '<option value="">✍️ 手动填写新地址</option></select>'
      : "") +
    '<input class="input" id="d-address" name="address" value="' + esc(chosen ? chosen.address : "") + '" ' +
    'placeholder="小区 + 楼幢门牌，如 文三路 128 号 3 幢 502" autocomplete="street-address">' +
    (mode === "quick" ? '<div class="form-hint">选择已存地址可精确定位；手填地址按片区默认坐标（' + DEFAULT_LAT + ", " + DEFAULT_LNG + "）匹配片区。</div>" : "") +
    "</div>" +
    '<div class="field"><label>上课时间<span class="req">*</span></label>' + timesBlockHtml() + "</div>" +
    '<div class="field-row">' +
    '<div class="field"><label for="d-budget">预算（元/课时）<span class="req">*</span></label>' +
    '<input class="input" id="d-budget" name="budget" type="number" min="1" step="1" inputmode="decimal" placeholder="如 200"></div>' +
    '<div class="field"><label for="d-gender">性别偏好</label><select class="select" id="d-gender" name="genderPref">' +
    '<option value="">不限</option><option value="女">女教员</option><option value="男">男教员</option></select></div>' +
    "</div>" +
    '<div class="field"><label for="d-remark">特殊要求</label>' +
    '<textarea class="textarea" id="d-remark" name="remark" placeholder="孩子年级、薄弱知识点、希望的教学风格等"></textarea></div>' +
    '<div class="card flat tight" style="margin-bottom:14px">' +
    '<div class="row between">' +
    '<div><div class="bold small">加急需求</div><div class="tiny faint">优先推送附近教员，加急费最低 ' + money(urgentFee) + "，可自己加价</div></div>" +
    '<button type="button" class="switch" data-urgent role="switch" aria-checked="false" aria-label="加急需求"></button></div>' +
    '<div class="field" data-urgent-fee-box style="display:none;margin:12px 0 0">' +
    '<label for="d-urgent-fee">加急费（元）</label>' +
    '<input class="input" id="d-urgent-fee" name="urgentFeeYuan" type="number" inputmode="decimal" step="0.01" ' +
    'min="' + (urgentFee / 100) + '"' + (urgentMaxFee ? ' max="' + (urgentMaxFee / 100) + '"' : "") +
    ' value="' + (urgentFee / 100).toFixed(2) + '">' +
    '<div class="form-hint">可填 ' + money(urgentFee) + (urgentMaxFee ? " ~ " + money(urgentMaxFee) : "") +
    "；加急费会连同课时费一起计入订单实付金额。</div></div></div>" +
    (mode === "full"
      ? '<div class="field-row"><div class="field"><label for="d-lat">纬度</label>' +
        '<input class="input" id="d-lat" name="lat" value="' + DEFAULT_LAT + '" inputmode="decimal"></div>' +
        '<div class="field"><label for="d-lng">经度</label>' +
        '<input class="input" id="d-lng" name="lng" value="' + DEFAULT_LNG + '" inputmode="decimal"></div></div>' +
        '<button type="button" class="btn btn-sm btn-outline mb16" data-fillcoord>📍 填入默认坐标（' + DEFAULT_LAT + " / " + DEFAULT_LNG + "）</button>"
      : "") +
    '<button type="submit" class="btn btn-primary btn-block">发布需求</button>' +
    "</form>";
}

function bindDemandForm(root, { mode, addrs, onPublished }) {
  const form = $('[data-form="demand"]', root);
  if (!form) return;

  form.addEventListener("click", (e) => {
    if (e.target.closest("[data-addtime]")) {
      $("[data-times]", form).insertAdjacentHTML("beforeend", timeRowHtml({}));
      return;
    }
    const del = e.target.closest("[data-deltime]");
    if (del) {
      const rows = $$("[data-time-row]", form);
      if (rows.length === 1) return toastErr("至少保留一个时间段");
      del.closest("[data-time-row]").remove();
      return;
    }
    const placeBtn = e.target.closest("[data-place]");
    if (placeBtn) {
      $$("[data-place]", form).forEach((n) => n.classList.toggle("on", n === placeBtn));
      const hint = form.querySelector("[data-place-hint]");
      if (hint) {
        hint.textContent = placeBtn.dataset.place === "teacher_place"
          ? "由教员提供授课地址（预约/订单里可见）；下面的地址仅用于匹配片区"
          : "教员到您填写的上课地址授课";
      }
      return;
    }
    const urgent = e.target.closest("[data-urgent]");
    if (urgent) {
      urgent.classList.toggle("on");
      const on = urgent.classList.contains("on");
      urgent.setAttribute("aria-checked", on ? "true" : "false");
      // 加急费输入框只在开启加急时出现，开关关掉不该留下一个可填的金额
      const feeBox = form.querySelector("[data-urgent-fee-box]");
      if (feeBox) feeBox.style.display = on ? "" : "none";
      return;
    }
    if (e.target.closest("[data-fillcoord]")) {
      form.lat.value = DEFAULT_LAT;
      form.lng.value = DEFAULT_LNG;
      toast("已填入片区默认坐标");
    }
  });

  form.addEventListener("change", (e) => {
    const pick = e.target.closest("[data-pickaddr]");
    if (!pick) return;
    const opt = pick.selectedOptions[0];
    if (!pick.value) {
      form.address.value = "";
      form.address.focus();
      return;
    }
    const a = addrs.find((x) => String(x.id) === pick.value);
    if (a) {
      form.address.value = a.address;
      if (mode === "full") {
        form.lat.value = a.lat;
        form.lng.value = a.lng;
      }
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    let payload;
    try {
      payload = readDemandPayload(form, { mode, addrs });
    } catch (err) {
      return toastErr(err.message);
    }
    // 游客点「发布需求」：先把填好的内容留下来，弹登录，登录成功后自动接着发布
    if (isGuest()) {
      requireLogin(async () => {
        const created = await api.post("/api/demands", payload);
        toastOk("需求已发布，正在推送给附近教员");
        onPublished(created);
      });
      return;
    }

    btn.disabled = true;
    btn.textContent = "发布中…";
    try {
      const created = await api.post("/api/demands", payload);
      toastOk("需求已发布，正在推送给附近教员");
      onPublished(created);
    } catch (err) {
      onError(err);
    } finally {
      btn.disabled = false;
      btn.textContent = "发布需求";
    }
  });
}

function readDemandPayload(form, { mode, addrs }) {
  const d = formData(form);
  const address = String(d.address || "").trim();
  if (!address) throw new Error("请填写上课地址");
  if (!(Number(d.budget) > 0)) throw new Error("请填写预算金额（元/课时）");
  const rows = $$("[data-time-row]", form).map((row) => ({
    date: row.querySelector('[data-t="date"]').value,
    start: row.querySelector('[data-t="start"]').value,
    end: row.querySelector('[data-t="end"]').value,
  })).filter((t) => t.date);
  if (!rows.length) throw new Error("请至少选择一个上课日期");
  const bad = rows.find((t) => !t.start || !t.end || t.end <= t.start);
  if (bad) throw new Error("上课时间有误：结束时间需晚于开始时间");

  let lat = DEFAULT_LAT;
  let lng = DEFAULT_LNG;
  let addressId = null;
  const pick = form.querySelector("[data-pickaddr]");
  const pickedId = pick && pick.value ? Number(pick.value) : null;
  if (mode === "full") {
    lat = Number(d.lat);
    lng = Number(d.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("请填写正确的经纬度");
    addressId = pickedId;
  } else if (pickedId) {
    const a = addrs.find((x) => x.id === pickedId);
    if (a && a.address === address) {
      lat = a.lat;
      lng = a.lng;
      addressId = a.id;
    }
  }
  const urgent = isOn(form.querySelector("[data-urgent]"));
  let urgentFee = 0;
  if (urgent) {
    const feeInput = form.querySelector("#d-urgent-fee");
    const yuan = Number(String(d.urgentFeeYuan ?? "").trim() || (feeInput ? feeInput.value : 0));
    if (!(yuan > 0)) throw new Error("请填写加急费（元）");
    const min = Number(feeInput?.min || 0);
    const max = Number(feeInput?.max || 0);
    if (min && yuan < min) throw new Error("加急费不能低于 " + money(cents(min)));
    if (max && yuan > max) throw new Error("加急费最高 " + money(cents(max)));
    urgentFee = cents(yuan);
  }
  return {
    stage: d.stage,
    subject: d.subject,
    mode: (form.querySelector("[data-place].on")?.dataset.place) || "home",
    address,
    lat,
    lng,
    budget: cents(d.budget),
    remark: String(d.remark || "").trim(),
    urgent,
    urgentFee,
    times: rows,
    genderPref: d.genderPref || "",
    addressId,
  };
}

/* ---------------- 订单相关 ---------------- */
function storeOrder(o) {
  state.orderCache.set(String(o.id), o);
  return o;
}

function orderActions() {
  return {
    sos: async (el) => {
      const yes = await confirmDialog(
        "🚨 紧急求助",
        "将立即通知平台客服与片区负责人处理订单 " + (el.dataset.no || "") +
          "。仅在人身安全、纠纷或突发状况时使用，误触可忽略后续联系。",
        "确认求助",
        true
      );
      if (!yes) return;
      try {
        const r = await api.post("/api/orders/" + el.dataset.id + "/sos", { note: "家长端发起" });
        toastOk(r.message || "求助已提交");
      } catch (err) {
        onError(err);
      }
    },
    pay: async (el) => {
      const id = el.dataset.id;
      const amount = Number(el.dataset.amount || 0);
      const yes = await confirmDialog(
        "确认支付 " + money(amount),
        "课时费将进入平台担保账户托管，课程完成并经您确认后才会结算给教员。确认现在支付？",
        "立即支付"
      );
      if (!yes) return;
      await api.post("/api/orders/" + id + "/pay", { channel: "wechat_jsapi" }, { idem: idemKey("pay") });
      toastOk("支付成功，教员将按时上门");
      ROUTER.render();
    },
    cancel: async (el) => {
      const id = el.dataset.id;
      const paid = Number(el.dataset.paid || 0) > 0;
      const yes = await confirmDialog(
        "取消订单",
        paid
          ? "该订单已支付。提交后由教员确认：教员同意则按规则退款（开课前 4 小时内取消会扣 20% 违约金并影响信用分），驳回则订单继续；2 小时内未处理平台自动退款。确认提交取消申请？"
          : "取消后需求将关闭，教员无法再接单。确认取消该订单？",
        paid ? "提交取消申请" : "继续取消",
        true
      );
      if (!yes) return;
      const reason = await promptDialog("请填写取消原因", "如：临时调整孩子的时间安排", { value: "" });
      if (!reason) return;
      const r = await api.post("/api/orders/" + id + "/cancel", { reason });
      toastOk(paid ? "已提交取消申请，等待教员确认（超时自动退款）" : "订单已取消");
      ROUTER.render();
      return r;
    },
    sos: async (el) => {
      const yes = await confirmDialog(
        "🚨 紧急求助",
        "将立即通知平台客服与片区负责人处理订单 " + (el.dataset.no || "") + "。仅在人身安全、纠纷或突发状况时使用，误触请忽略后续联系。",
        "确认求助",
        true
      );
      if (!yes) return;
      try {
        const r = await api.post("/api/orders/" + el.dataset.id + "/sos", { note: "家长端发起" });
        toastOk(r.message || "求助已提交");
      } catch (err) {
        onError(err);
      }
    },
    refund: async (el) => {
      const id = el.dataset.id;
      const yes = await confirmDialog("申请退款", "退款申请将提交平台客服审核，审核通过后原路退款。确认提交申请？", "提交申请", true);
      if (!yes) return;
      const reason = await promptDialog("请填写退款原因", "如：教员未按约定时间上门", { value: "" });
      if (!reason) return;
      await api.post("/api/orders/" + id + "/refund", { reason });
      toastOk("退款申请已提交，客服将在 24 小时内处理");
      ROUTER.render();
    },
    confirm: async (el) => {
      const id = el.dataset.id;
      const yes = await confirmDialog("确认课程已完成", "确认后课时费进入 7 天冻结期，冻结期满结算给教员。确认完成？", "确认完成");
      if (!yes) return;
      await api.post("/api/orders/" + id + "/confirm", {});
      toastOk("已确认完成，感谢您的信任");
      ROUTER.render();
    },
    // 家长到场打卡（P66）：到教员处上课时，家长点「我到场了」→ 浏览器定位 → 上报坐标
    pcheckin: async (el) => {
      const id = el.dataset.id;
      const pos = await askPosition();
      if (!pos) return;
      try {
        await busy(el, async () => {
          const order = await api.post("/api/orders/" + id + "/checkin", { lat: pos.lat, lng: pos.lng });
          toastOk(order.bothArrived ? "双方已到场，课程开始" : "已记录到场，等待教员打卡开课");
          ROUTER.render();
        });
      } catch (err) {
        onError(err);
      }
    },
    review: (el) => {
      location.hash = "#/review/" + el.dataset.id;
    },
    contact: (el) => {
      const o = state.orderCache.get(String(el.dataset.id));
      if (o) contactSheet(o);
    },
    detail: (el) => {
      location.hash = "#/order/" + el.dataset.id;
    },
  };
}

function contactSheet(o) {
  const t = o.teacher || {};
  sheet(
    "联系老师",
    '<div class="row" style="gap:12px">' + avatar(t.nickname, t.avatar, "lg") +
    '<div><div class="bold">' + esc(t.nickname || "-") + "</div>" +
    '<div class="row mt8" style="gap:6px">' + levelBadge(t.level, t.levelName) +
    '<span class="tiny faint">' + esc(identityText(t.identityType)) + "</span></div></div></div>" +
    kv("联系电话", esc(t.phone || "-")) +
    kv("授课方式", esc(o.placeText || "教员上门")) +
    kv("上课时间", fmtDate(o.lessonTime, "time")) +
    kv(o.place === "teacher_place" ? "教员授课地址" : "上课地址", esc(o.address || "-")) +
    '<div class="hint mt12">为保护双方隐私，平台展示脱敏号码；如需即时联系，请通过平台客服协助 400-800-1234。</div>',
    [{ label: "我知道了", class: "btn-primary" }]
  );
}

function orderCard(o) {
  storeOrder(o);
  const t = o.teacher || {};
  const paid = o.status !== "awaiting_payment";
  const acts = [];
  if (o.status === "awaiting_payment") {
    acts.push('<button class="btn btn-outline btn-sm" data-act="cancel" data-id="' + o.id + '" data-paid="0">取消</button>');
    acts.push('<button class="btn btn-primary btn-sm" data-act="pay" data-id="' + o.id + '" data-amount="' + (o.amount + o.urgentFee) + '">去支付</button>');
  } else if (o.status === "pending_class") {
    acts.push('<button class="btn btn-outline btn-sm" data-act="sos" data-id="' + o.id + '" data-no="' + esc(o.orderNo) + '">🚨 紧急求助</button>');
    acts.push('<button class="btn btn-ghost btn-sm" data-act="refund" data-id="' + o.id + '">申请退款</button>');
    acts.push('<button class="btn btn-ghost btn-sm" data-act="contact" data-id="' + o.id + '">联系老师</button>');
  } else if (o.status === "in_class") {
    acts.push('<button class="btn btn-outline btn-sm" data-act="sos" data-id="' + o.id + '" data-no="' + esc(o.orderNo) + '">🚨 紧急求助</button>');
    acts.push('<button class="btn btn-ghost btn-sm" data-act="contact" data-id="' + o.id + '">联系老师</button>');
  } else if (o.status === "awaiting_parent_confirm") {
    acts.push('<button class="btn btn-ghost btn-sm" data-act="contact" data-id="' + o.id + '">联系老师</button>');
    acts.push('<button class="btn btn-primary btn-sm" data-act="confirm" data-id="' + o.id + '">确认完成</button>');
  } else if (o.status === "completed" || o.status === "settled") {
    if (o.hasReview) acts.push('<button class="btn btn-outline btn-sm" disabled>已评价</button>');
    else acts.push('<button class="btn btn-gold btn-sm" data-act="review" data-id="' + o.id + '">去评价</button>');
  } else if (o.status === "refunding") {
    acts.push('<button class="btn btn-outline btn-sm" disabled>退款审核中</button>');
  }
  return '<article class="card" data-go="/order/' + o.id + '" role="link" tabindex="0" style="cursor:pointer">' +
    '<div class="row between"><div class="row" style="gap:6px">' + statusBadge(o.status, o.statusText) +
    '<span class="tag">' + esc(o.stage) + "·" + esc(o.subject) + "</span></div>" +
    '<span class="tiny faint">' + fromNow(o.createdAt) + "</span></div>" +
    '<div class="mt12 small">🕒 ' + fmtDate(o.lessonTime, "time") + "</div>" +
    '<div class="mt8 small muted ellipsis">📍 ' + esc(o.address) + "</div>" +
    '<div class="dashed-top row between">' +
    '<div class="row" style="gap:8px">' + avatar(t.nickname, t.avatar, "sm") +
    '<div><div class="small bold">' + esc(t.nickname || "-") + "</div>" +
    '<div class="tiny faint">' + levelBadge(t.level, t.levelName) + " ⭐" + Number(t.ratingAvg || 0).toFixed(1) + "</div></div></div>" +
    '<div class="center"><div class="tiny faint">' + (paid ? "实付" : "应付") + '</div><div class="money" style="font-size:16px">' +
    money(o.amount + (o.urgentFee || 0)) + "</div></div></div>" +
    (acts.length ? '<div class="btn-row mt12">' + acts.join("") + "</div>" : "") +
    "</article>";
}

/* ---------------- 路由：首页 ---------------- */
async function homeView({ query }) {
  chrome({
    loc: '<div class="loc"><div class="grow"><div class="t1">📍 定位中…</div><div class="t2">家教上门撮合平台</div></div>' + bellHtml() + "</div>",
    tab: "/",
  });
  setBody(loadingHtml());
  const tab = query.tab === "near" ? "near" : "form";
  const geo = await locate();
  const guest = isGuest();
  const [data, addrs, dict] = await Promise.all([
    api.get(guest ? "/api/public/home" : "/api/parent/home", geo || undefined),
    guest ? Promise.resolve([]) : api.get("/api/addresses").catch(() => []),
    getDict(),
  ]);
  const rules = await getRules().catch(() => null);
  state.unread = (data.stats && data.stats.unread) || 0;

  const regionName = ((data.region && data.region.name) || "未开通服务片区").replace(/^杭州·/, "");
  chrome({
    loc: '<div class="loc"><div class="grow"><div class="t1">📍 ' + esc(regionName) + '</div><div class="t2">' +
      esc(state.city) + " · " + (geo ? "已定位当前位置" : "按默认地址推荐") + "</div></div>" +
      '<button class="icon-btn" data-act="relocate" title="重新定位" aria-label="重新定位">🎯</button>' +
      bellHtml() + "</div>",
    tab: "/",
  });

  const teachers = data.teachers || [];
  const ongoing = (data.stats && data.stats.ongoingOrders) || 0;
  const urgentFee = data.urgentFee != null ? data.urgentFee : ((rules && rules.urgent && rules.urgent.fee) || 2000);
  const urgentMaxFee = data.urgentMaxFee != null
    ? data.urgentMaxFee
    : Math.max(urgentFee, (rules && rules.urgent && rules.urgent.max_fee) || urgentFee * 10);

  const tabSwitch = '<div class="segmented mb16">' +
    '<button class="' + (tab === "form" ? "on" : "") + '" data-go="/?tab=form">我要找老师</button>' +
    '<button class="' + (tab === "near" ? "on" : "") + '" data-go="/?tab=near">看附近教员</button></div>';

  // 游客还没有券/订单，这两块属「我的」数据，登录后再出现
  const couponStrip = guest ? "" : '<div class="coupon-strip" data-go="/coupons" role="link" tabindex="0">' +
    '<span class="ci" aria-hidden="true">🎟️</span>' +
    '<span class="ct">优惠券：<span class="cn">' + (data.couponCount || 0) + " 张</span>可用</span>" +
    '<span class="tiny" style="color:#b06f00">去使用 ›</span></div>';

  const ongoingCard = ongoing
    ? '<div class="card tight row between" data-go="/orders" role="link" tabindex="0" style="cursor:pointer">' +
      '<div class="row" style="gap:8px"><span style="font-size:18px">⏳</span><div><div class="bold small">您有 ' + ongoing + ' 个进行中的家教订单</div>' +
      '<div class="tiny faint">点击查看上课时间与打卡状态</div></div></div><span class="faint">›</span></div>'
    : "";

  const formTab =
    '<div class="card"><div class="card-title"><h3>发布家教需求</h3>' +
    '<span class="more" data-go="/demand" role="link" tabindex="0">完整表单 ›</span></div>' +
    demandFormHtml({ dict, addrs, urgentFee, urgentMaxFee, mode: "quick", defaultId: data.defaultAddress && data.defaultAddress.id }) +
    "</div>" +
    couponStrip +
    (ongoingCard || "") +
    noticesHtml(data.notices) +
    complianceHtml(data.compliance);

  const nearTab =
    '<div class="card-title" style="margin-top:0"><h3>附近教员 · 实时在线</h3>' +
    '<span class="more" data-go="/plaza" role="link" tabindex="0">全部教员 ›</span></div>' +
    (teachers.length
      ? mapBoardHtml(teachers, data.location) + teachers.map((t) => teacherRow(t)).join("")
      : '<div class="card">' + emptyHtml("附近暂无在线教员，换个科目或稍后再试", "🗺️") +
        '<div class="btn-row"><button class="btn btn-ghost btn-sm" data-go="/plaza">去广场看看</button>' +
        '<button class="btn btn-ghost btn-sm" data-go="/demand">发布需求等抢单</button></div></div>');

  setBody(bannerHtml(data.banners) + tabSwitch + (tab === "form" ? formTab : nearTab));

  if (tab === "form") {
    bindDemandForm(bodyEl(), {
      mode: "quick",
      addrs,
      onPublished: () => {
        location.hash = "#/demand";
      },
    });
  }
  setActions({
    relocate: () => {
      state.geo = undefined;
      toast("正在重新定位…");
      ROUTER.render();
    },
  });
}

/* ---------------- 路由：教员广场 ---------------- */
function plazaHref(base, patch) {
  const q = { ...base, ...patch };
  const s = Object.keys(q)
    .filter((k) => q[k] !== "" && q[k] !== null && q[k] !== undefined)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(q[k]))
    .join("&");
  return "/plaza" + (s ? "?" + s : "");
}

async function plazaView({ query }) {
  chrome({ title: "教员广场", sub: "按距离 × 等级智能排序", plain: true, back: true });
  const cur = {
    subject: query.subject || "",
    level: query.level || "",
    priceRange: query.price || "",
    radiusKm: query.radius || "5",
    sort: query.sort || "priority",
    view: query.view === "map" ? "map" : "list",
  };
  setBody(loadingHtml());
  const dict = await getDict();
  const priceMap = {
    "": {},
    low: { priceMax: 10000 },
    mid: { priceMin: 10000, priceMax: 20000 },
    high: { priceMin: 20000, priceMax: 30000 },
    top: { priceMin: 30000 },
  };
  const q = { subject: cur.subject, level: cur.level, radiusKm: cur.radiusKm, sort: cur.sort, ...(priceMap[cur.priceRange] || {}) };
  const geo = await locate();
  if (geo && q.lat === undefined) {
    q.lat = geo.lat;
    q.lng = geo.lng;
  }
  const res = await api.get(apiBase() + "/teachers", q);
  const list = res.list || [];
  const base = { subject: cur.subject, level: cur.level, price: cur.priceRange, radius: cur.radiusKm, sort: cur.sort, view: cur.view };

  const chips = (items, key, value) => '<div class="row wrap" style="gap:6px">' + items.map((it) =>
    '<button class="chip ' + (String(value) === String(it.v) ? "on" : "") + '" data-go="' + plazaHref(base, { [key]: it.v }) + '">' + esc(it.t) + "</button>"
  ).join("") + "</div>";

  const filterCard = '<div class="card"><div class="card-title"><h3>筛选</h3>' +
    '<span class="more" data-go="/plaza?view=' + cur.view + '">重置</span></div>' +
    '<div class="tiny faint mb8">科目</div>' +
    chips([{ v: "", t: "全部" }, ...(dict.subjects || []).slice(0, 8).map((s) => ({ v: s, t: s }))], "subject", cur.subject) +
    '<div class="tiny faint mb8 mt12">教员等级</div>' +
    chips([{ v: "", t: "全部" }, { v: "Lv3", t: "优选教员" }, { v: "Lv4", t: "金牌教员" }, { v: "Lv5", t: "名师" }], "level", cur.level) +
    '<div class="tiny faint mb8 mt12">价格区间（元/课时）</div>' +
    chips([{ v: "", t: "不限" }, { v: "low", t: "≤100" }, { v: "mid", t: "100-200" }, { v: "high", t: "200-300" }, { v: "top", t: "300+" }], "price", cur.priceRange) +
    '<div class="tiny faint mb8 mt12">距离半径</div>' +
    chips([{ v: "3", t: "3 km" }, { v: "5", t: "5 km" }, { v: "10", t: "10 km" }, { v: "20", t: "20 km" }], "radius", cur.radiusKm) +
    '<div class="tiny faint mb8 mt12">排序</div>' +
    chips([{ v: "priority", t: "智能推荐" }, { v: "distance", t: "距离最近" }, { v: "price", t: "价格最低" }, { v: "rating", t: "评分最高" }], "sort", cur.sort) +
    "</div>";

  const viewSwitch = '<div class="row between mb12">' +
    '<div class="segmented" style="flex:0 0 auto;width:170px">' +
    '<button class="' + (cur.view === "list" ? "on" : "") + '" data-go="' + plazaHref(base, { view: "list" }) + '">列表</button>' +
    '<button class="' + (cur.view === "map" ? "on" : "") + '" data-go="' + plazaHref(base, { view: "map" }) + '">地图</button>' +
    "</div>" +
    '<span class="tiny faint">共 ' + (res.total || 0) + " 位教员</span></div>";

  const content = cur.view === "map"
    ? (list.length ? mapBoardHtml(list, res.center) + list.map((t) => teacherRow(t)).join("") : '<div class="card">' + emptyHtml("该范围内暂无教员，放大半径试试", "🗺️") + "</div>")
    : (list.length ? list.map((t) => teacherRow(t)).join("") : '<div class="card">' + emptyHtml("没有符合条件的教员，试试放宽筛选", "🔍") + "</div>");

  setBody(filterCard + viewSwitch + content);
  setActions({});
}

/* ---------------- 路由：教员详情 ---------------- */
function levelTableHtml(table, current) {
  if (!table || !table.length) return "";
  const rows = table.map((l) =>
    '<tr style="' + (l.level === current ? "background:var(--brand-soft);font-weight:600" : "") + '">' +
    "<td>" + levelBadge(l.level, l.name) + "</td>" +
    '<td class="num">' + (l.min ?? 0) + "-" + (l.max >= 999999 ? "∞" : l.max) + "</td>" +
    '<td class="num">' + pct(l.commission) + "</td>" +
    '<td class="num">' + Number(l.weight).toFixed(1) + "</td></tr>"
  ).join("");
  return '<div class="card"><div class="card-title"><h3>等级权益对照</h3>' +
    '<span class="more">当前 ' + esc(current) + "</span></div>" +
    '<div class="table-wrap"><table class="table"><thead><tr><th>等级</th><th>成长分</th><th>平台佣金</th><th>派单权重</th></tr></thead>' +
    "<tbody>" + rows + "</tbody></table></div>" +
    '<p class="tiny faint mt8">等级由成长分自动评定：好评累计、完课节数会增加成长分，违规与差评会扣减。</p></div>';
}

function scoreDistHtml(dist, ratingAvg, ratingCount) {
  const total = Object.values(dist || {}).reduce((a, b) => a + b, 0);
  const rows = [5, 4, 3, 2, 1].map((s) => {
    const c = (dist && dist[s]) || 0;
    const w = total ? Math.round((c / total) * 100) : 0;
    return '<div class="star-dist"><span>' + s + " 星</span>" +
      '<div class="progress"><i style="width:' + w + '%"></i></div>' +
      "<span>" + c + "</span></div>";
  }).join("");
  return '<div class="row" style="gap:14px;align-items:center">' +
    '<div class="center" style="flex:0 0 auto"><div style="font-size:28px;font-weight:800;line-height:1.1">' +
    Number(ratingAvg || 0).toFixed(1) + "</div>" + stars(ratingAvg) +
    '<div class="tiny faint mt8">' + (ratingCount || 0) + " 条评价</div></div>" +
    '<div class="grow">' + rows + "</div></div>";
}

function teacherDetailHtml(t) {
  const subs = (t.subjects || []).map((s) => '<span class="chip on" style="pointer-events:none">' + esc(s) + "</span>").join(" ");
  const stgs = (t.stages || []).map((s) => '<span class="tag">' + esc(s) + "</span>").join(" ");
  const services = t.services || [];
  const reviews = t.reviews || [];
  return '<div class="card">' +
    '<div class="row" style="gap:14px;align-items:flex-start">' + avatar(t.nickname, t.avatar, "xl") +
    '<div class="grow"><div class="row" style="gap:6px;flex-wrap:wrap"><b style="font-size:17px">' + esc(t.nickname) + "</b>" +
    levelBadge(t.level, t.levelName) + (t.online ? '<span class="badge green">在线接单</span>' : '<span class="badge gray">休息中</span>') + "</div>" +
    '<div class="row mt8" style="gap:8px;font-size:12px;color:var(--ink-3);flex-wrap:wrap">' +
    stars(t.ratingAvg) + "<span>" + Number(t.ratingAvg || 0).toFixed(1) + "（" + (t.ratingCount || 0) + "）</span>" +
    "<span>" + esc(identityText(t.identityType)) + "</span>" +
    "<span>教龄 " + (t.completedLessons || 0) + " 课时</span></div></div></div>" +
    '<div class="row between mt16" style="align-items:flex-end">' +
    '<div><div class="tiny faint">课时单价</div><div class="money" style="font-size:24px;color:var(--brand)">' + money(t.hourlyPrice) + "</div></div>" +
    '<div class="center"><div class="tiny faint">距您</div><div class="bold">' + (t.distanceKm ?? "-") + ' km</div></div>' +
    '<div class="center"><div class="tiny faint">服务半径</div><div class="bold">' + (t.serviceRadiusKm ?? "-") + ' km</div></div>' +
    "</div></div>" +
    '<div class="card"><div class="card-title"><h3>擅长科目与覆盖</h3></div>' +
    '<div class="row wrap" style="gap:6px">' + subs + "</div>" +
    '<div class="row wrap mt8" style="gap:6px">' + stgs + "</div>" +
    '<div class="divider"></div>' +
    kv("服务覆盖范围", esc(t.coverArea || "未填写")) +
    kv("上门服务半径", (t.serviceRadiusKm || "-") + " km") +
    kv("距离您的直线距离", (t.distanceKm ?? "-") + " km") +
    kv("等级派单权重", Number(t.levelWeight || 0).toFixed(1) + " ×") +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>自我介绍与资质</h3></div>' +
    '<p class="small" style="line-height:1.75;color:var(--ink-2)">' + esc(t.intro || "该教员暂未填写自我介绍") + "</p>" +
    '<div class="hint green mt12">✅ 平台已人工核验身份与学历资料（等级 ' + esc(t.levelName || t.level) + "）</div></div>" +
    (services.length
      ? '<div class="card"><div class="card-title"><h3>可预约服务</h3><span class="more">' + services.length + " 个</span></div>" +
        services.map((s) =>
          '<div class="spec-item"><div class="grow"><div class="bold small">' + esc(s.title) + "</div>" +
          '<div class="tiny faint mt8">' + esc(s.subjects || "") + " · " + esc(s.stages || "") + " · 覆盖 " + (s.cover_radius_km || s.coverRadiusKm || "-") + " km</div>" +
          (s.description ? '<div class="tiny faint mt8">' + esc(s.description) + "</div>" : "") + "</div>" +
          '<div class="center"><div class="money">' + money(s.price) + '</div><button class="btn btn-xs btn-primary mt8" data-act="book" data-service="' + s.id + '">预约</button></div></div>'
        ).join("") + "</div>"
      : '<div class="card"><div class="card-title"><h3>可预约服务</h3></div>' + emptyHtml("该教员暂未上架服务，可发布需求等待报名", "📝") + "</div>") +
    '<div class="card"><div class="card-title"><h3>评分与评价</h3><span class="more">' + reviews.length + " 条</span></div>" +
    scoreDistHtml(t.scoreDist, t.ratingAvg, t.ratingCount) +
    '<div class="divider"></div>' +
    (reviews.length
      ? reviews.map((r) =>
        '<div class="review-item"><div class="row between"><div class="row" style="gap:6px">' + stars(r.score) +
        '<span class="tiny faint">' + esc(r.parentName || "匿名家长") + "</span></div>" +
        '<span class="tiny faint">' + fmtDate(r.createdAt, "date") + "</span></div>" +
        (r.content ? '<p class="small mt8" style="color:var(--ink-2);line-height:1.7">' + esc(r.content) + "</p>" : "") +
        '<div class="row wrap mt8" style="gap:4px">' + (r.tags || []).map((tg) => '<span class="tag">' + esc(tg) + "</span>").join("") +
        '<span class="tag">权重 ' + (r.weight || 1) + "</span></div></div>"
      ).join("")
      : emptyHtml("暂无评价", "💬")) +
    "</div>" +
    levelTableHtml(t.levelTable, t.level);
}

async function teacherDetailView({ params }) {
  chrome({ title: "教员详情", plain: true, back: true });
  setBody(loadingHtml());
  const [t, addrs] = await Promise.all([
    api.get(apiBase() + "/teachers/" + encodeURIComponent(params.id)),
    isGuest() ? Promise.resolve([]) : api.get("/api/addresses").catch(() => []),
  ]);
  state.teacher = t;
  setBody(teacherDetailHtml(t));
  mountBar(
    '<button class="btn btn-outline" data-act="fav" aria-pressed="' + (t.favorited ? "true" : "false") + '">' +
    (t.favorited ? "♥ 已收藏" : "♡ 收藏") + "</button>" +
    '<button class="btn btn-primary wide" data-act="book">立即预约</button>'
  );
  setActions({
    fav: async (el) => {
      // 收藏是「我的数据」：游客点收藏先弹登录，登录后自动完成收藏
      if (isGuest()) {
        requireLogin(async () => {
          await api.post("/api/my/favorites/" + t.id, {});
          toastOk("已加入收藏");
        });
        return;
      }
      const r = await api.post("/api/my/favorites/" + t.id, {});
      el.textContent = r.favorited ? "♥ 已收藏" : "♡ 收藏";
      el.setAttribute("aria-pressed", r.favorited ? "true" : "false");
      toastOk(r.favorited ? "已加入收藏" : "已取消收藏");
    },
    book: async (el) => {
      const serviceId = el.dataset.service ? Number(el.dataset.service) : null;
      // 立即预约要下单，必须有家长身份：游客先弹登录，登录后直接把预约弹层递上来
      if (isGuest()) {
        requireLogin(async () => {
          const myAddrs = await api.get("/api/addresses").catch(() => []);
          openBooking(t, myAddrs, serviceId);
        });
        return;
      }
      openBooking(t, addrs, serviceId);
    },
  });
}

function openBooking(t, addrs, serviceId) {
  const services = t.services || [];
  if (!services.length) {
    sheet(
      "预约 " + (t.nickname || ""),
      emptyHtml("该教员暂未上架可预约服务", "📝") +
      '<p class="small muted center">您可以先发布家教需求，等待附近教员抢单报名。</p>',
      [{ label: "关闭" }, { label: "去发布需求", class: "btn-primary", onClick: () => { location.hash = "#/demand"; } }]
    );
    return;
  }
  // 授课形式（P67）：由**所选服务**决定——服务声明了「在教员家授课」且教员填了授课地址，家长才看得到该选项
  const svcPlaces = (svc) => (Array.isArray(svc && svc.places) && svc.places.length ? svc.places : ["home"]);
  const canTeacherPlace = (svc) => !!t.acceptAtTeacherPlace && svcPlaces(svc).includes("teacher_place");
  if (!canTeacherPlace(services[0]) && !addrs.length) {
    sheet(
      "预约 " + (t.nickname || ""),
      emptyHtml("您还没有保存上课地址", "📍") + '<p class="small muted center">上门授课需要先添加一个上课地址。</p>',
      [{ label: "取消" }, { label: "去添加地址", class: "btn-primary", onClick: () => { location.hash = "#/addresses"; } }]
    );
    return;
  }
  const first = services.find((s) => String(s.id) === String(serviceId)) || services[0];
  const defAddr = addrs.find((a) => a.is_default) || addrs[0] || null;
  const draft = {
    serviceId: first.id,
    addressId: defAddr ? defAddr.id : null,
    lessonTime: "",
    remark: "",
    // 选中的服务支持在教员家、且没有家长地址时，默认就是「到教员处」
    place: canTeacherPlace(first) && !defAddr ? "teacher_place" : "home",
  };
  const placeHintFor = (svc, place) =>
    place === "teacher_place" ? "教员授课地址：" + (t.baseAddress || "") : "教员到您选择的上课地址授课";
  const placeBlock = (svc) => {
    const opts = svcPlaces(svc);
    const atHome = opts.includes("home");
    const atTp = canTeacherPlace(svc);
    if (!atHome && !atTp) return "";
    // 只有一种可选时不必给选择器，直接说明
    if (!(atHome && atTp)) {
      return '<div class="field"><label>授课形式</label><div class="form-hint">' +
        (atTp ? "该服务仅支持「在教员家授课」：教员授课地址 " + esc(t.baseAddress || "") : "该服务仅支持「上门授课」") +
        "</div></div>";
    }
    return '<div class="field"><label>授课方式</label><div class="row" style="gap:6px">' +
      '<button type="button" class="chip ' + (draft.place === "home" ? "on" : "") + '" data-bk="place" data-v="home">🏠 教员上门</button>' +
      '<button type="button" class="chip ' + (draft.place === "teacher_place" ? "on" : "") + '" data-bk="place" data-v="teacher_place">📍 我到教员处</button>' +
      '</div><div class="form-hint" data-bk-place-hint>' + placeHintFor(svc, draft.place) + "</div></div>";
  };
  const html =
    '<div class="field"><label>选择服务</label><div class="col" style="gap:8px">' +
    services.map((s) =>
      '<button type="button" class="chip ' + (String(draft.serviceId) === String(s.id) ? "on" : "") + '" data-bk="service" data-id="' + s.id + '">' +
      esc(s.title) + " · " + money(s.price) + "/课时" + (Array.isArray(s.places) && s.places.length > 1 ? "（可到老师家）" : "") + "</button>"
    ).join("") + "</div></div>" +
    '<div data-bk-place-wrap>' + placeBlock(first) + "</div>" +
    '<div class="field" data-bk-addr-box' + (draft.place === "teacher_place" ? ' style="display:none"' : "") + '><label>上课地址</label>' +
    (addrs.length
      ? '<select class="select" data-bk="addr">' +
        addrs.map((a) => '<option value="' + a.id + '" ' + (a.id === draft.addressId ? "selected" : "") + ">" + esc(a.label) + " · " + esc(a.address) + "</option>").join("") +
        "</select>"
      : '<div class="form-hint">还没有上课地址，可到「我的 → 地址管理」添加</div>') +
    "</div>" +
    '<div class="field"><label>上课时间</label><input class="input" type="datetime-local" data-bk="time" min="' + minLocalNow() + '"></div>' +
    '<div class="field" style="margin-bottom:0"><label>备注（可选）</label>' +
    '<textarea class="textarea" data-bk="remark" placeholder="孩子年级、薄弱环节、希望重点提升的内容"></textarea></div>' +
    '<div class="hint mt12">课时费 ' + money(first.price) + " 支付后进入平台担保账户；上课确认完成后 T+7 结算给教员。</div>";

  const submit = async () => {
    if (!draft.lessonTime) return toastErr("请选择上课时间");
    if (draft.place === "home" && !draft.addressId) return toastErr("请先添加并选择上课地址");
    try {
      const order = await api.post("/api/orders/from-service", {
        serviceId: draft.serviceId,
        lessonTime: new Date(draft.lessonTime).toISOString(),
        addressId: draft.place === "teacher_place" ? undefined : draft.addressId,
        place: draft.place,
        remark: draft.remark,
      });
      storeOrder(order);
      toastOk("预约已创建，请在订单中完成担保支付");
      location.hash = "#/order/" + order.id;
    } catch (err) {
      onError(err);
    }
  };

  const s = sheet("预约 " + (t.nickname || ""), html, [{ label: "取消" }, { label: "提交预约", class: "btn-primary", onClick: submit }]);
  const el = s.el;
  // 授课方式的 chip 要能随「换服务」重绘，所以单独抽一个绑定函数（P67）
  const bindPlaceChips = () => {
    $$('[data-bk="place"]', el).forEach((node) => {
      node.onclick = () => {
        draft.place = node.dataset.v === "teacher_place" ? "teacher_place" : "home";
        $$('[data-bk="place"]', el).forEach((n) => n.classList.toggle("on", n === node));
        const svc = services.find((x) => String(x.id) === String(draft.serviceId));
        const hint = el.querySelector("[data-bk-place-hint]");
        if (hint) hint.textContent = placeHintFor(svc, draft.place);
        const box = el.querySelector("[data-bk-addr-box]");
        if (box) box.style.display = draft.place === "teacher_place" ? "none" : "";
      };
    });
  };
  $$("[data-bk]", el).forEach((node) => {
    const k = node.dataset.bk;
    if (k === "service") {
      node.addEventListener("click", () => {
        draft.serviceId = Number(node.dataset.id);
        $$('[data-bk="service"]', el).forEach((n) => n.classList.toggle("on", n === node));
        // 换服务后授课形式可能变（P67）：当前选择不被支持时回落到该服务支持的第一种
        const svc = services.find((x) => String(x.id) === String(draft.serviceId));
        const opts = svcPlaces(svc);
        if (!opts.includes(draft.place)) draft.place = opts[0];
        const wrap = el.querySelector("[data-bk-place-wrap]");
        if (wrap) wrap.innerHTML = placeBlock(svc);
        const box = el.querySelector("[data-bk-addr-box]");
        if (box) box.style.display = draft.place === "teacher_place" ? "none" : "";
        bindPlaceChips();
      });
    } else if (k === "addr") {
      node.addEventListener("change", () => { draft.addressId = Number(node.value); });
    } else if (k === "time") {
      node.addEventListener("change", () => { draft.lessonTime = node.value; });
    } else if (k === "remark") {
      node.addEventListener("input", () => { draft.remark = node.value; });
    }
  });
  bindPlaceChips();
}

function minLocalNow() {
  const d = new Date(Date.now() + 3600000);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
}

/* ---------------- 路由：需求发布 / 我的需求 ---------------- */
function demandListHtml(list) {
  if (!list || !list.length) return emptyHtml("还没有发布过家教需求", "📝");
  return list.map((d) => {
    const acts = [];
    if (d.status === "published") acts.push('<button class="btn btn-outline btn-xs" data-act="pause" data-id="' + d.id + '">暂停接单</button>');
    if (d.status === "paused") acts.push('<button class="btn btn-ghost btn-xs" data-act="resume" data-id="' + d.id + '">恢复接单</button>');
    if (d.status === "published" || d.status === "paused") {
      acts.push('<button class="btn btn-outline btn-xs" data-act="revoke" data-id="' + d.id + '">撤销</button>');
    }
    return '<div class="card" data-go="/demand/' + d.id + '" role="link" tabindex="0" style="cursor:pointer">' +
      '<div class="row between"><div class="row" style="gap:6px">' +
      statusBadge(d.status, DEMAND_STATUS[d.status] || d.status) +
      '<span class="tag">' + esc(d.stage) + "·" + esc(d.subject) + "</span>" +
      (d.urgent ? '<span class="badge danger">加急</span>' : "") + "</div>" +
      '<span class="tiny faint">' + fromNow(d.created_at || d.createdAt) + "</span></div>" +
      '<div class="mt12 small">🕒 ' + esc(timeLabel(d.times)) + "</div>" +
      '<div class="mt8 small muted ellipsis">📍 ' + esc(d.address) + "</div>" +
      '<div class="dashed-top row between"><div class="small"><span class="money">' + money(d.budget) + '</span>' +
      '<span class="tiny faint">/课时 · ' + (d.applyCount || 0) + ' 位教员报名</span></div>' +
      (acts.length ? '<div class="row" style="gap:6px">' + acts.join("") + "</div>" : '<span class="tiny faint">查看报名 ›</span>') +
      "</div></div>";
  }).join("");
}

async function demandPage() {
  chrome({ title: "发布需求", sub: "仅上门授课 · 教员抢单报名", plain: true, back: true, right: bellHtml() });
  setBody(loadingHtml());
  const [mine, addrs, dict] = await Promise.all([
    api.get("/api/demands/mine"),
    api.get("/api/addresses").catch(() => []),
    getDict(),
  ]);
  const rules = await getRules().catch(() => null);
  const urgentFee = (rules && rules.urgent && rules.urgent.fee) || 2000;
  const urgentMaxFee = Math.max(urgentFee, (rules && rules.urgent && rules.urgent.max_fee) || urgentFee * 10);
  setBody(
    '<div class="card"><div class="card-title"><h3>发布家教需求</h3><span class="more">填写后附近教员可抢单</span></div>' +
    demandFormHtml({ dict, addrs, urgentFee, urgentMaxFee, mode: "full", defaultId: (addrs.find((a) => a.is_default) || addrs[0] || {}).id }) +
    "</div>" +
    '<div class="section-title"><span class="bar"></span>我的需求（' + (mine || []).length + "）</div>" +
    demandListHtml(mine)
  );

  bindDemandForm(bodyEl(), {
    mode: "full",
    addrs,
    onPublished: () => {
      location.hash = "#/orders";
    },
  });

  const demandAction = (action, id) => api.post("/api/demands/" + id + "/action", { action }).then(() => {
    toastOk("操作成功");
    ROUTER.render();
  });

  setActions({
    pause: (el) => demandAction("pause", el.dataset.id),
    resume: (el) => demandAction("resume", el.dataset.id),
    revoke: async (el) => {
      const yes = await confirmDialog("撤销需求", "撤销后教员无法继续报名，已有报名将全部取消。确认撤销？", "确认撤销", true);
      if (!yes) return;
      await demandAction("revoke", el.dataset.id);
    },
  });
}

async function demandDetailView({ params }) {
  chrome({ title: "需求报名情况", plain: true, back: true });
  setBody(loadingHtml());
  const d = await api.get("/api/demands/" + encodeURIComponent(params.id));
  const apps = d.applications || [];
  const appStatus = { pending: "待确认", confirmed: "已确认", rejected: "未通过", cancelled: "已取消" };
  setBody(
    '<div class="card"><div class="row between"><div class="row" style="gap:6px">' +
    statusBadge(d.status, DEMAND_STATUS[d.status] || d.status) +
    '<span class="tag">' + esc(d.stage) + "·" + esc(d.subject) + "</span>" +
    (d.urgent ? '<span class="badge danger">加急</span>' : "") + "</div>" +
    '<span class="money">' + money(d.budget) + "</span></div>" +
    kv("上课时间", esc(timeLabel(Array.isArray(d.times) ? d.times : []))) +
    kv("上课地址", esc(d.address)) +
    kv("特殊要求", esc(d.remark || "无")) +
    kv("性别偏好", esc(d.gender_pref || "不限")) +
    "</div>" +
    '<div class="section-title"><span class="bar"></span>报名教员（' + apps.length + "）</div>" +
    (apps.length
      ? apps.map((a) => {
        const card = a.teacher || {};
        const canConfirm = a.status === "pending" && d.status === "published";
        return '<div class="card"><div class="row" style="gap:12px;align-items:flex-start">' + avatar(card.nickname, card.avatar, "lg") +
          '<div class="grow"><div class="row" style="gap:6px;flex-wrap:wrap"><b>' + esc(card.nickname || "-") + "</b>" +
          levelBadge(card.level, card.levelName) +
          statusBadge(a.status === "pending" ? "open" : a.status === "confirmed" ? "approved" : "gray", appStatus[a.status] || a.status) + "</div>" +
          '<div class="row mt8" style="gap:10px;font-size:11px;color:var(--ink-3);flex-wrap:wrap">' +
          "<span>⭐ " + Number(card.ratingAvg || 0).toFixed(1) + "</span>" +
          "<span>已授课 " + (card.completedLessons || 0) + " 节</span>" +
          (a.distance_km != null ? "<span>📍 " + a.distance_km + " km</span>" : "") +
          "<span>匹配优先级 " + Number(a.priority || 0).toFixed(1) + "</span></div>" +
          '<div class="row wrap mt8" style="gap:4px">' + (card.subjects || []).map((s) => '<span class="tag">' + esc(s) + "</span>").join("") + "</div>" +
          '</div><div class="money">' + money(card.hourlyPrice) + "</div></div>" +
          '<div class="btn-row mt12">' +
          '<button class="btn btn-outline btn-sm" data-go="/teacher/' + (card.id || "") + '">查看主页</button>' +
          (canConfirm
            ? '<button class="btn btn-primary btn-sm" data-act="confirm" data-app="' + a.id + '" data-demand="' + d.id + '">确认该教员</button>'
            : '<button class="btn btn-outline btn-sm" disabled>' + (appStatus[a.status] || a.status) + "</button>") +
          "</div></div>";
      }).join("")
      : '<div class="card">' + emptyHtml("还没有教员报名，稍后再来看看", "📣") + "</div>")
  );
  setActions({
    confirm: async (el) => {
      const yes = await confirmDialog("确认教员", "确认后系统将生成订单，其余报名自动关闭；请在订单中完成担保支付。", "确认并生成订单");
      if (!yes) return;
      const order = await api.post("/api/demands/" + el.dataset.demand + "/confirm", { applicationId: Number(el.dataset.app) });
      storeOrder(order);
      toastOk("已确认教员，请完成担保支付");
      location.hash = "#/order/" + order.id;
    },
  });
}

/* ---------------- 路由：订单列表 ---------------- */
const ORDER_TABS = [
  { v: "", t: "全部" },
  { v: "awaiting", t: "待接单" },
  { v: "pending", t: "待上课" },
  { v: "in_class", t: "进行中" },
  { v: "completed", t: "已完成" },
  { v: "cancelled", t: "已取消" },
];

async function ordersView({ query }) {
  const status = query.status || "";
  chrome({ title: "我的订单", sub: "平台担保交易 · 课时费托管", tab: "/orders" });
  setBody(loadingHtml());
  const res = await api.get("/api/parent/orders", status ? { status } : {});
  let list = res.list || [];
  if (status === "pending") list = list.filter((o) => o.status !== "in_class");

  const tabs = '<div class="tabs">' + ORDER_TABS.map((t) =>
    '<button class="' + (status === t.v ? "on" : "") + '" data-go="/orders' + (t.v ? "?status=" + t.v : "") + '">' + t.t + "</button>"
  ).join("") + "</div>";

  setBody(tabs + (list.length
    ? list.map((o) => orderCard(o)).join("")
    : '<div class="card">' + emptyHtml(status ? "该分类下暂无订单" : "还没有订单，去找位合适的老师吧", "📋") +
      '<div class="btn-row"><button class="btn btn-ghost btn-sm" data-go="/">去首页找老师</button>' +
      '<button class="btn btn-ghost btn-sm" data-go="/plaza">逛教员广场</button></div></div>'));
  setActions(orderActions());
}

/* ---------------- 路由：订单详情 ---------------- */
function orderTimeline(o) {
  const nodes = [
    { t: "提交订单", d: o.createdAt, on: true },
    { t: "担保支付", d: o.paidAt, on: !!o.paidAt },
    { t: "上门打卡", d: o.checkinAt, on: !!o.checkinAt },
    { t: "教员结束授课", d: o.finishedAt, on: !!o.finishedAt },
    { t: "家长确认完成", d: o.confirmAt, on: !!o.confirmAt },
    { t: "结算完成", d: o.settleAt, on: !!o.settleAt },
  ];
  return '<div class="timeline">' + nodes.map((n) =>
    '<div class="node ' + (n.on ? "done" : "") + '"><div class="t">' + esc(n.t) + "</div>" +
    '<div class="d">' + (n.d ? fmtDate(n.d, "time") : "—") + "</div></div>"
  ).join("") + "</div>";
}

function orderStatusHint(o) {
  const map = {
    awaiting_payment: "等待您完成担保支付，支付后教员将按时上门。",
    pending_class: "教员已接单，请保持电话畅通；教员到达后需在 500 米内打卡开始上课。",
    in_class: "课程进行中，教员已完成定位打卡。",
    awaiting_parent_confirm: "教员已结束授课，请确认完成后课时费进入 7 天冻结期。",
    completed: "订单已完成，课时费处于冻结期，冻结期满自动结算给教员。",
    settled: "订单已结算完成，感谢您的信任。",
    cancelled: "订单已取消。",
    refunding: "退款申请审核中，客服将在 24 小时内处理。",
    refunded: "订单已退款。",
  };
  return map[o.status] || "";
}

function orderDetailHtml(o) {
  const t = o.teacher || {};
  const paid = o.amount + (o.urgentFee || 0);
  const feeReady = o.serviceFee != null;
  // 取消申请状态：等待教员处理 / 已被驳回（家长要知道钱和课现在什么状态）
  const cancelBanner = o.cancelRequested
    ? '<div class="hint mt12" style="border-color:#f0c987;background:#fff9ec;color:#8a5a00;border-radius:12px">' +
      "已提交取消申请（" + fmtDate(o.cancelRequestedAt, "time") + "），等待教员确认：同意即按规则退款，驳回则订单继续；2 小时内未处理平台自动退款。</div>"
    : o.cancelRejectedAt && o.status !== "refunded" && o.status !== "cancelled"
      ? '<div class="hint mt12" style="border-color:#f7c9c9;background:var(--danger-soft);color:var(--danger);border-radius:12px">' +
        "教员已于 " + fmtDate(o.cancelRejectedAt, "time") + " 驳回取消申请，理由：" + esc(o.cancelRejectReason || "未填写") +
        "。如仍有异议可联系客服申请仲裁。</div>"
      : "";
  return '<div class="card"><div class="row between">' +
    "<div><div style=\"font-size:19px;font-weight:800\">" + esc(o.statusText) + "</div>" +
    '<div class="tiny faint mt8">' + esc(orderStatusHint(o)) + "</div></div>" +
    statusBadge(o.status, o.statusText) + "</div>" +
    (o.freeCancelDeadline ? '<div class="tiny faint mt8">免费取消截止：' + fmtDate(o.freeCancelDeadline, "time") + "</div>" : "") +
    cancelBanner +
    '<div class="divider"></div>' + orderTimeline(o) + "</div>" +

    '<div class="card"><div class="card-title"><h3>教员信息</h3>' +
    '<span class="more" data-go="/teacher/' + t.id + '" role="link" tabindex="0">主页 ›</span></div>' +
    '<div class="row" style="gap:12px">' + avatar(t.nickname, t.avatar, "lg") +
    '<div class="grow"><div class="row" style="gap:6px"><b>' + esc(t.nickname || "-") + "</b>" + levelBadge(t.level, t.levelName) + "</div>" +
    '<div class="row mt8" style="gap:8px;font-size:11px;color:var(--ink-3)">' + stars(t.ratingAvg) +
    "<span>" + Number(t.ratingAvg || 0).toFixed(1) + "（" + (t.ratingCount || 0) + "）</span>" +
    "<span>" + esc(identityText(t.identityType)) + "</span></div>" +
    '<div class="row wrap mt8" style="gap:4px">' + (t.subjects || []).map((s) => '<span class="tag">' + esc(s) + "</span>").join("") + "</div></div></div></div>" +

    '<div class="card"><div class="card-title"><h3>上课信息</h3></div>' +
    kv("科目 / 学段", esc(o.subject) + " · " + esc(o.stage)) +
    kv("授课方式", esc(o.placeText || "教员上门")) +
    kv("上课时间", lessonTimeText(o)) +
    kv(o.place === "teacher_place" ? "教员授课地址" : "详细地址", esc(o.address)) +
    kv("课时单价", money(o.amount)) +
    (o.remark ? kv("备注", esc(o.remark)) : "") +
    // 双方到场打卡（P66）：到教员处上课时，两边各打一次卡，都到齐才开课
    (o.place === "teacher_place"
      ? kv("到场打卡",
        '<span class="tiny">家长 ' + (o.parentArrived ? "✅ " + fmtDate(o.parentCheckinAt, "time") : "⏳ 未打卡") +
        "　/　教员 " + (o.teacherArrived ? "✅ " + fmtDate(o.checkinAt, "time") : "⏳ 未打卡") +
        (o.bothArrived ? "　·　双方已到齐" : "") + "</span>")
      : "") +
    (o.checkinAt ? kv("打卡记录", fmtDate(o.checkinAt, "time") + " / 距上课地点 " + (o.checkinDistance ?? "-") + " 米") : "") +
    "</div>" +

    '<div class="card"><div class="card-title"><h3>订单信息</h3>' +
    '<span class="badge green">🛡 平台担保</span></div>' +
    kv("订单号", esc(o.orderNo)) +
    kv("下单时间", fmtDate(o.createdAt, "time")) +
    '<div class="divider"></div>' +
    kv("课时费", money(o.amount)) +
    (o.urgentFee ? kv("加急费", money(o.urgentFee)) : "") +
    kv("实付金额", '<span class="money" style="color:var(--brand)">' + money(paid) + "</span>") +
    kv("平台服务费", feeReady ? money(o.serviceFee) + ' <span class="tiny faint">(' + pct(o.commissionRate) + ")</span>" : '<span class="faint">支付后生成</span>') +
    kv("教员实收", feeReady ? money(o.teacherIncome) : '<span class="faint">支付后生成</span>') +
    (o.penalty ? kv("违约金", money(o.penalty)) : "") +
    (o.refundAmount ? kv("已退款", money(o.refundAmount)) : "") +
    '<div class="hint mt12">资金由平台担保账户托管，课程确认完成后 T+7 结算给教员；如有纠纷可申请退款或联系客服。</div>' +
    "</div>";
}

function orderBar(o) {
  const canPay = o.status === "awaiting_payment";
  const paid = o.amount + (o.urgentFee || 0);
  if (canPay) {
    return '<button class="btn btn-outline" data-act="cancel" data-id="' + o.id + '" data-paid="' + paid + '">取消订单</button>' +
      '<button class="btn btn-primary wide" data-act="pay" data-id="' + o.id + '" data-amount="' + paid + '">去支付 ' + money(paid) + "</button>";
  }
  if (o.status === "pending_class") {
    // 家长到教员处上课：家长要自己打卡（双方都打完才开课，P66）
    const needCheckin = o.place === "teacher_place" && !o.parentArrived;
    const checkinBtn = o.place === "teacher_place"
      ? (o.parentArrived
        ? '<button class="btn btn-outline btn-sm" disabled>家长已到场</button>'
        : '<button class="btn btn-primary" data-act="pcheckin" data-id="' + o.id + '">📍 我到场了</button>')
      : "";
    return '<button class="btn btn-outline btn-sm" data-act="cancel" data-id="' + o.id + '" data-paid="' + paid + '">取消</button>' +
      '<button class="btn btn-outline btn-sm" data-act="sos" data-id="' + o.id + '" data-no="' + esc(o.orderNo) + '">🚨 求助</button>' +
      checkinBtn +
      (needCheckin ? "" : '<button class="btn btn-outline" data-act="refund" data-id="' + o.id + '">申请退款</button>') +
      '<button class="btn btn-primary" data-act="contact" data-id="' + o.id + '">联系老师</button>';
  }
  if (o.status === "in_class") {
    return '<button class="btn btn-outline btn-sm" data-act="sos" data-id="' + o.id + '" data-no="' + esc(o.orderNo) + '">🚨 求助</button>' +
      '<button class="btn btn-outline" data-act="contact" data-id="' + o.id + '">联系老师</button>' +
      '<button class="btn btn-primary wide" disabled>课程进行中</button>';
  }
  if (o.status === "awaiting_parent_confirm") {
    return '<button class="btn btn-outline" data-act="contact" data-id="' + o.id + '">联系老师</button>' +
      '<button class="btn btn-primary wide" data-act="confirm" data-id="' + o.id + '">确认完成</button>';
  }
  if (o.status === "completed" || o.status === "settled") {
    return '<button class="btn btn-outline" data-act="contact" data-id="' + o.id + '">联系老师</button>' +
      (o.hasReview
        ? '<button class="btn btn-outline" disabled>已评价</button>'
        : '<button class="btn btn-gold wide" data-act="review" data-id="' + o.id + '">去评价</button>');
  }
  if (o.status === "refunding") {
    return '<button class="btn btn-outline" data-act="contact" data-id="' + o.id + '">联系老师</button>' +
      '<button class="btn btn-primary wide" disabled>退款审核中</button>';
  }
  return '<button class="btn btn-outline" data-go="/plaza">再找老师</button>' +
    '<button class="btn btn-primary wide" data-go="/">返回首页</button>';
}

async function orderDetailView({ params }) {
  chrome({ title: "订单详情", plain: true, back: true });
  setBody(loadingHtml());
  const o = await api.get("/api/orders/" + encodeURIComponent(params.id));
  storeOrder(o);
  setBody(orderDetailHtml(o));
  mountBar(orderBar(o));
  setActions(orderActions());
}

/* ---------------- 路由：课后评价 ---------------- */
const SCORE_TEXT = { 1: "很不满意", 2: "不满意", 3: "一般", 4: "满意", 5: "非常满意" };

function reviewHtml(o, tags) {
  const t = o.teacher || {};
  return '<div class="card"><div class="row" style="gap:12px">' + avatar(t.nickname, t.avatar, "lg") +
    '<div class="grow"><div class="row" style="gap:6px"><b>' + esc(t.nickname || "-") + "</b>" + levelBadge(t.level, t.levelName) + "</div>" +
    '<div class="tiny faint mt8">' + esc(o.subject) + " · " + esc(o.stage) + " · " + fmtDate(o.lessonTime, "time") + "</div></div></div></div>" +
    '<div class="card center"><div class="small bold mb12">本次课程满意度</div>' +
    '<div class="stars-input" style="justify-content:center" data-stars role="radiogroup" aria-label="评分">' +
    [1, 2, 3, 4, 5].map((n) => '<i data-star="' + n + '" role="radio" tabindex="0" aria-checked="' + (n === 5 ? "true" : "false") + '" aria-label="' + n + ' 星">★</i>').join("") +
    "</div>" +
    '<div class="small muted mt12" data-score-text>非常满意</div></div>' +
    '<div class="card"><div class="card-title"><h3>评价标签</h3><span class="more">可多选</span></div>' +
    '<div class="tiny faint mb8">做得好的地方</div><div class="row wrap" style="gap:6px" data-tag-group="pos">' +
    tags.positive.map((tg) => '<button class="chip" data-tag="' + esc(tg) + '">' + esc(tg) + "</button>").join("") + "</div>" +
    '<div class="tiny faint mb8 mt12">需要改进的地方</div><div class="row wrap" style="gap:6px" data-tag-group="neg">' +
    tags.negative.map((tg) => '<button class="chip" data-tag="' + esc(tg) + '">' + esc(tg) + "</button>").join("") + "</div></div>" +
    '<div class="card"><div class="card-title"><h3>文字评价</h3></div>' +
    '<textarea class="textarea" data-content maxlength="300" placeholder="说说孩子这节课的收获与感受，帮助更多家长选择老师"></textarea>' +
    '<div class="form-hint">评价提交后将影响教员的成长分与派单权重，请客观评价。</div></div>';
}

async function reviewView({ params }) {
  chrome({ title: "课后评价", plain: true, back: true });
  setBody(loadingHtml());
  const [o, tags] = await Promise.all([api.get("/api/orders/" + encodeURIComponent(params.orderId)), getReviewTags()]);
  storeOrder(o);
  if (o.hasReview) {
    setBody('<div class="card">' + emptyHtml("该订单已完成评价，感谢您的反馈", "✅") +
      '<button class="btn btn-ghost btn-sm btn-block" data-go="/orders">返回订单列表</button></div>');
    setActions({});
    return;
  }
  state.review = { score: 5, tags: new Set(), content: "" };
  setBody(reviewHtml(o, tags));
  mountBar('<button class="btn btn-primary btn-block" data-act="submit">提交评价</button>');

  const starsBox = $("[data-stars]");
  const paint = () => {
    $$("[data-star]", starsBox).forEach((i) => {
      const n = Number(i.dataset.star);
      i.classList.toggle("on", n <= state.review.score);
      i.setAttribute("aria-checked", n === state.review.score ? "true" : "false");
    });
    $("[data-score-text]").textContent = SCORE_TEXT[state.review.score];
  };
  paint();
  starsBox.addEventListener("click", (e) => {
    const s = e.target.closest("[data-star]");
    if (!s) return;
    state.review.score = Number(s.dataset.star);
    paint();
  });
  starsBox.addEventListener("keydown", (e) => {
    const s = e.target.closest("[data-star]");
    if (!s) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      state.review.score = Number(s.dataset.star);
      paint();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = clamp(state.review.score + (e.key === "ArrowRight" ? 1 : -1), 1, 5);
      state.review.score = next;
      paint();
      const target = $$("[data-star]", starsBox).find((i) => Number(i.dataset.star) === next);
      if (target) target.focus();
    }
  });
  $$("[data-tag]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const tg = chip.dataset.tag;
      if (state.review.tags.has(tg)) state.review.tags.delete(tg);
      else state.review.tags.add(tg);
      chip.classList.toggle("on");
    });
  });
  $("[data-content]").addEventListener("input", (e) => {
    state.review.content = e.target.value;
  });

  setActions({
    submit: async () => {
      const yes = await confirmDialog("提交评价", "评价提交后不可修改，将影响教员成长分。确认提交？", "确认提交");
      if (!yes) return;
      await api.post("/api/orders/" + o.id + "/review", {
        score: state.review.score,
        content: state.review.content,
        tags: Array.from(state.review.tags),
      });
      toastOk("评价成功，感谢您的反馈");
      location.hash = "#/orders";
    },
  });
}

/* ---------------- 路由：消息 ---------------- */
async function messagesView() {
  chrome({
    title: "消息中心", plain: true, tab: "/messages",
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

/* ---------------- 路由：我的 ---------------- */
function creditPanelHtml(p) {
  const c = p.credit || {};
  const levels = p.creditLevels || [];
  const next = c.nextLevel;
  const curLv = levels.find((l) => l.level === c.creditLevel);
  let progress = 100;
  if (next && curLv) {
    const span = next.min - curLv.min || 1;
    progress = clamp(Math.round(((c.creditScore - curLv.min) / span) * 100), 0, 100);
  }
  const logs = (p.creditLogs || []).slice(0, 8);
  return '<div class="credit-panel">' +
    '<div class="row between"><div><div class="tiny" style="opacity:.7">我的信用分</div>' +
    '<div class="num">' + (c.creditScore ?? 0) + "</div>" +
    '<div class="tiny mt8" style="opacity:.82">' + esc(c.creditLevelName || c.creditLevel || "-") +
    " · 评价权重 " + Number(c.reviewWeight || 1).toFixed(1) + "×</div></div>" +
    '<div style="text-align:right"><div class="tiny" style="opacity:.7">完成订单</div>' +
    '<div class="bold" style="font-size:18px">' + (c.completedOrders ?? 0) + "</div>" +
    '<div class="tiny mt8" style="opacity:.7">取消 ' + (c.cancelCount ?? 0) + " 次</div></div></div>" +
    (next
      ? '<div class="mt12"><div class="progress"><i style="width:' + progress + '%"></i></div>' +
        '<div class="tiny mt8" style="opacity:.82">再获得 ' + Math.max(0, next.min - (c.creditScore || 0)) + " 分可升级为「" + esc(next.name) + "」，评价权重更高</div></div>"
      : '<div class="tiny mt12" style="opacity:.82">已达最高信用等级，评价权重最高</div>') +
    "</div>" +
    '<div class="card"><div class="card-title"><h3>信用等级规则</h3><span class="more">权重越高评价越有影响力</span></div>' +
    levels.map((l) =>
      '<div class="kv"><span class="k">' + esc(l.name) + "（" + esc(l.level) + "）</span>" +
      '<span class="v">' + l.min + "-" + (l.max >= 999999 ? "∞" : l.max) + " 分 · 权重 " + Number(l.weight).toFixed(1) + "×</span></div>"
    ).join("") +
    '<div class="hint mt12">加分：完成订单 +' + ((p.creditRules && p.creditRules.order_completed) ?? 3) +
    "、主动评价 +" + ((p.creditRules && p.creditRules.review_given) ?? 2) +
    "、当月无取消 +" + ((p.creditRules && p.creditRules.monthly_no_cancel) ?? 5) +
    "；扣分：课前 4 小时内取消 " + ((p.creditRules && p.creditRules.cancel_within_4h) ?? -8) + " 分。</div></div>" +
    '<div class="card"><div class="card-title"><h3>信用分变动明细</h3><span class="more">最近 ' + logs.length + " 条</span></div>" +
    (logs.length
      ? logs.map((l) =>
        '<div class="kv"><span class="k">' + esc(l.reason) + '<br><span class="tiny faint">' + fmtDate(l.created_at, "time") + "</span></span>" +
        '<span class="v" style="color:' + (l.change >= 0 ? "var(--brand-op-dark)" : "var(--danger)") + '">' +
        (l.change >= 0 ? "+" : "") + l.change + ' <span class="tiny faint">→ ' + l.balance_after + "</span></span></div>"
      ).join("")
      : '<p class="small faint">暂无变动记录</p>') + "</div>";
}

function qItem(icon, label, value, go) {
  if (!go) {
    return '<div class="q-item" style="cursor:default">' +
      '<span class="qi" aria-hidden="true">' + icon + "</span>" +
      '<span class="qz">' + esc(label) + "</span>" +
      '<span class="qv">' + esc(value || "") + "</span></div>";
  }
  return '<button class="q-item" data-go="' + go + '">' +
    '<span class="qi" aria-hidden="true">' + icon + "</span>" +
    '<span class="qz">' + esc(label) + "</span>" +
    '<span class="qv">' + esc(value || "") + "</span>" +
    '<span class="faint" aria-hidden="true">›</span></button>';
}

/* ---------------- 头像上传（客户端等比压缩 → /api/upload → /api/parent/avatar） ---------------- */
const AVATAR_MAX = 512;

/**
 * 选一张本地图片，等比缩到 ≤512px 返回 dataURL。
 * 为什么不直接传原图：手机原图 4–8MB 会撞上 2MB 上限；而且头像框最大 68px，
 * 传原图纯属浪费带宽。这里**不裁切**，只等比缩放，进入头像框后由 `object-fit: cover` 自适应显示。
 */
function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return resolve(null);
      if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
        toastErr("只支持 PNG / JPG / WEBP 图片");
        return resolve(null);
      }
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(null);
        img.onload = () => {
          const scale = Math.min(1, AVATAR_MAX / Math.max(img.width || 1, img.height || 1));
          const w = Math.max(1, Math.round((img.width || 1) * scale));
          const h = Math.max(1, Math.round((img.height || 1) * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve({ filename: file.name, dataUrl: canvas.toDataURL("image/jpeg", 0.9) });
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    }, { once: true });
    input.click();
  });
}

/** 换头像：上传 → 落库 → 同步本地登录用户 → 重渲染当前页 */
async function changeAvatar() {
  const picked = await pickImageFile();
  if (!picked) return;
  toast("上传中…");
  const up = await api.post("/api/upload", { filename: picked.filename, dataUrl: picked.dataUrl });
  const r = await api.put("/api/parent/avatar", { avatar: up.url });
  session.user = { ...(session.user || {}), avatar: r.user && r.user.avatar };
  toastOk(r.hasAvatar ? "头像已更新" : "已恢复默认头像");
  ROUTER.render();
}

/** 可点击更换的头像框（右上角相机角标提示） */
function avatarPickHtml(u, cls) {
  return '<div class="avatar-wrap" data-act="avatar" role="button" tabindex="0" aria-label="更换头像" title="点击更换头像">' +
    avatar(u.nickname, u.avatar, cls) +
    '<span class="avatar-pick" aria-hidden="true">📷</span></div>';
}

async function meView() {
  chrome({ title: "我的", tab: "/me" });
  setBody(loadingHtml());
  const p = await api.get("/api/parent/profile");
  const u = p.user || {};
  const stats = p.stats || {};
  const c = p.credit || {};
  setBody(
    '<div class="card"><div class="row" style="gap:14px">' + avatarPickHtml(u, "xl") +
    '<div class="grow"><div class="row" style="gap:6px;flex-wrap:wrap"><b style="font-size:17px">' + esc(u.nickname || "家长") + "</b>" +
    '<span class="level-badge lv' + (CREDIT_LV[c.creditLevel] || 1) + '">' + esc(c.creditLevelName || c.creditLevel || "未评级") + "</span></div>" +
    '<div class="tiny faint mt8">' + esc(u.phone || "-") + " · " + (u.realName ? "已实名" : "未实名认证") + " · " +
    (u.avatar ? "点击头像可更换" : "点击头像上传图片") + "</div>" +
    '<div class="tiny faint mt8">信用分 ' + ((p.credit && p.credit.creditScore) ?? 0) + " · 评价权重 " +
    Number((p.credit && p.credit.reviewWeight) || 1).toFixed(1) + "×</div></div>" +
    '<button class="btn btn-xs btn-ghost" data-go="/profile">编辑资料</button></div>' +
    '<div class="stat-grid three mt16">' +
    '<div class="stat"><div class="label">订单</div><div class="value">' + (stats.orders || 0) + "</div></div>" +
    '<div class="stat"><div class="label">收藏教员</div><div class="value">' + (stats.favorites || 0) + "</div></div>" +
    '<div class="stat"><div class="label">上课地址</div><div class="value">' + (stats.addresses || 0) + "</div></div>" +
    "</div></div>" +
    (p.restricted ? '<div class="hint" style="border-color:#f7c9c9;background:var(--danger-soft);color:var(--danger);border-radius:12px;margin-bottom:16px">⚠️ 因信用分过低，您当前受限：暂不可发布加急需求。请按时履约、及时评价以恢复信用。</div>' : "") +
    creditPanelHtml(p) +
    '<div class="card"><div class="card-title"><h3>常用功能</h3></div>' +
    qItem("📝", "我的需求", "", "/demand") +
    qItem("📍", "地址管理", (stats.addresses || 0) + " 个地址", "/addresses") +
    qItem("♥", "我的收藏", (stats.favorites || 0) + " 位教员", "/favorites") +
    qItem("🎟️", "优惠券", "查看可用券", "/coupons") +
    qItem("💳", "消费记录", "担保交易明细", "/wallet") +
    qItem("🎧", "客服帮助", "投诉与咨询", "/help") +
    qItem("⚙️", "设置", "协议与账号", "/settings") +
    "</div>" +
    '<button class="btn btn-outline btn-block" data-act="logout" style="margin-bottom:24px">退出登录</button>'
  );
  setActions({
    avatar: changeAvatar,
    logout: async () => {
      const yes = await confirmDialog("退出登录", "退出后需重新验证手机号登录。确认退出？", "退出登录", true);
      if (!yes) return;
      try {
        await api.post("/api/auth/logout", {});
      } catch {
        /* 退出失败不影响本地清理 */
      }
      session.clear();
      showLogin();
    },
  });
}

/* ---------------- 路由：地址管理 ---------------- */
function addressFormSheet(addr, onSaved) {
  const draft = {
    id: addr ? addr.id : null,
    label: addr ? addr.label : "家",
    contact: addr ? addr.contact : "",
    phone: addr ? addr.phone : ((session.user && session.user.phone) || ""),
    address: addr ? addr.address : "",
    lat: addr ? addr.lat : DEFAULT_LAT,
    lng: addr ? addr.lng : DEFAULT_LNG,
    isDefault: addr ? !!addr.is_default : false,
  };
  const html =
    '<div class="field"><label>地址标签</label><input class="input" data-ad="label" value="' + esc(draft.label) + '" placeholder="家 / 公司 / 辅导班"></div>' +
    '<div class="field-row"><div class="field"><label>联系人<span class="req">*</span></label>' +
    '<input class="input" data-ad="contact" value="' + esc(draft.contact) + '" placeholder="如 周女士"></div>' +
    '<div class="field"><label>手机号</label><input class="input" data-ad="phone" value="' + esc(draft.phone) + '" inputmode="numeric" maxlength="11"></div></div>' +
    '<div class="field"><label>详细地址<span class="req">*</span></label>' +
    '<input class="input" data-ad="address" value="' + esc(draft.address) + '" placeholder="小区 + 楼幢门牌"></div>' +
    '<div class="field-row"><div class="field"><label>纬度</label><input class="input" data-ad="lat" value="' + draft.lat + '" inputmode="decimal"></div>' +
    '<div class="field"><label>经度</label><input class="input" data-ad="lng" value="' + draft.lng + '" inputmode="decimal"></div></div>' +
    '<button type="button" class="btn btn-sm btn-outline mb12" data-ad="fill">📍 使用默认坐标 ' + DEFAULT_LAT + " / " + DEFAULT_LNG + "</button>" +
    '<label class="login-check"><input type="checkbox" data-ad="isDefault" ' + (draft.isDefault ? "checked" : "") + "><span>设为默认上课地址</span></label>" +
    '<div class="hint mt12">坐标用于就近派单与上门打卡距离校验，手填地址建议使用默认坐标。</div>';

  const save = async () => {
    if (!draft.contact.trim()) return toastErr("请填写联系人");
    if (!draft.address.trim()) return toastErr("请填写详细地址");
    if (!Number.isFinite(draft.lat) || !Number.isFinite(draft.lng)) return toastErr("请填写正确的经纬度");
    const body = {
      label: draft.label.trim() || "家",
      contact: draft.contact.trim(),
      phone: draft.phone.trim(),
      address: draft.address.trim(),
      lat: draft.lat,
      lng: draft.lng,
      isDefault: draft.isDefault,
    };
    try {
      if (draft.id) await api.put("/api/addresses/" + draft.id, body);
      else await api.post("/api/addresses", body);
      toastOk(draft.id ? "地址已更新" : "地址已保存");
      onSaved();
    } catch (err) {
      onError(err);
    }
  };

  const s = sheet(addr ? "编辑地址" : "新增地址", html, [{ label: "取消" }, { label: "保存", class: "btn-primary", onClick: save }]);
  const el = s.el;
  $$("[data-ad]", el).forEach((node) => {
    const k = node.dataset.ad;
    if (k === "fill") {
      node.addEventListener("click", () => {
        draft.lat = DEFAULT_LAT;
        draft.lng = DEFAULT_LNG;
        $('[data-ad="lat"]', el).value = DEFAULT_LAT;
        $('[data-ad="lng"]', el).value = DEFAULT_LNG;
        toast("已填入默认坐标");
      });
      return;
    }
    if (k === "isDefault") {
      node.addEventListener("change", () => { draft.isDefault = node.checked; });
      return;
    }
    node.addEventListener("input", () => {
      draft[k] = k === "lat" || k === "lng" ? Number(node.value) : node.value;
    });
  });
}

async function addressesView() {
  chrome({
    title: "地址管理", plain: true, back: true,
    right: '<button class="btn btn-xs btn-ghost" data-act="new">＋ 新增</button>',
  });
  setBody(loadingHtml());
  const list = await api.get("/api/addresses");
  setBody(
    (list.length
      ? list.map((a) =>
        '<div class="card"><div class="row between"><div class="row" style="gap:6px">' +
        '<span class="badge">' + esc(a.label) + "</span>" +
        (a.is_default ? '<span class="badge gold">默认</span>' : "") + "</div>" +
        '<span class="tiny faint">' + esc(a.contact) + " " + esc(a.phone || "") + "</span></div>" +
        '<div class="mt8 small">' + esc(a.address) + "</div>" +
        '<div class="tiny faint mt8">坐标 ' + a.lat + ", " + a.lng + "</div>" +
        '<div class="btn-row mt12">' +
        (a.is_default ? '<button class="btn btn-outline btn-sm" disabled>默认地址</button>'
          : '<button class="btn btn-outline btn-sm" data-act="default" data-id="' + a.id + '">设为默认</button>') +
        '<button class="btn btn-ghost btn-sm" data-act="edit" data-id="' + a.id + '">编辑</button>' +
        '<button class="btn btn-outline btn-sm" data-act="del" data-id="' + a.id + '">删除</button>' +
        "</div></div>").join("")
      : '<div class="card">' + emptyHtml("还没有上课地址，添加后才能预约上门家教", "📍") + "</div>") +
    '<button class="btn btn-primary btn-block mt16" data-act="new">＋ 新增上课地址</button>'
  );
  const map = new Map(list.map((a) => [String(a.id), a]));
  setActions({
    new: () => addressFormSheet(null, () => ROUTER.render()),
    edit: (el) => addressFormSheet(map.get(el.dataset.id), () => ROUTER.render()),
    default: async (el) => {
      await api.post("/api/addresses/" + el.dataset.id + "/default", {});
      toastOk("已设为默认地址");
      ROUTER.render();
    },
    del: async (el) => {
      const yes = await confirmDialog("删除地址", "删除后无法恢复，历史订单地址不受影响。确认删除？", "删除", true);
      if (!yes) return;
      await api.del("/api/addresses/" + el.dataset.id);
      toastOk("地址已删除");
      ROUTER.render();
    },
  });
}

/* ---------------- 发票申请（需求 4.1.6） ---------------- */
const INVOICE_STATUS = { pending: "待受理", issued: "已开票", rejected: "已驳回" };

function invoiceSheet(order, onSaved) {
  const draft = {
    orderId: order.id,
    titleType: "personal",
    title: (session.user && session.user.nickname) || "",
    taxNo: "",
    email: "",
  };
  const html =
    '<div class="hint mb12">开票订单 <b>' + esc(order.order_no) + "</b> · " + esc(order.subject) + " · " + esc(order.stage) +
    "<br>开票金额 " + money(order.payable) + "（订单实付金额）</div>" +
    '<div class="field"><label>抬头类型</label><div class="segmented" data-iv="type">' +
    '<button type="button" class="on" data-t="personal">个人</button>' +
    '<button type="button" data-t="company">企业</button></div></div>' +
    '<div class="field"><label>发票抬头<span class="req">*</span></label>' +
    '<input class="input" data-iv="title" value="' + esc(draft.title) + '" placeholder="个人姓名或企业全称"></div>' +
    '<div class="field" data-iv-wrap="taxNo" hidden><label>纳税人识别号<span class="req">*</span></label>' +
    '<input class="input" data-iv="taxNo" placeholder="15-20 位税号"></div>' +
    '<div class="field"><label>接收邮箱</label>' +
    '<input class="input" data-iv="email" type="email" inputmode="email" placeholder="用于接收电子发票"></div>' +
    '<div class="hint">提交后由平台财务受理，通常 1 个工作日内开具电子发票；驳回后可修改后重新提交。</div>';

  const save = async () => {
    if (!draft.title.trim()) return toastErr("请填写发票抬头");
    if (draft.titleType === "company" && !draft.taxNo.trim()) return toastErr("企业抬头需填写纳税人识别号");
    try {
      await api.post("/api/invoices", {
        orderId: draft.orderId,
        titleType: draft.titleType,
        title: draft.title.trim(),
        taxNo: draft.taxNo.trim(),
        email: draft.email.trim(),
      });
      toastOk("开票申请已提交，财务将尽快受理");
      onSaved();
    } catch (err) {
      onError(err);
    }
  };

  const s = sheet("申请开票", html, [{ label: "取消" }, { label: "提交申请", class: "btn-primary", onClick: save }]);
  const el = s.el;
  $$("[data-iv]", el).forEach((node) => {
    const k = node.dataset.iv;
    if (!k || k === "type") return;
    node.addEventListener("input", () => { draft[k] = node.value; });
  });
  $$('[data-iv="type"] [data-t]', el).forEach((btn) => {
    btn.addEventListener("click", () => {
      draft.titleType = btn.dataset.t;
      $$('[data-iv="type"] [data-t]', el).forEach((b) => b.classList.toggle("on", b === btn));
      const wrap = $('[data-iv-wrap="taxNo"]', el);
      if (wrap) wrap.hidden = draft.titleType !== "company";
    });
  });
}

/* ---------------- 路由：消费记录 ---------------- */
async function walletView({ query }) {
  chrome({ title: "消费记录", plain: true, back: true });
  setBody(loadingHtml());
  const d = await api.get("/api/wallet");
  const w = d.wallet || {};
  const rule = d.rule || {};
  const filter = query.type || "";
  const all = d.txns || [];
  const list = filter ? all.filter((t) => t.type === filter) : all;
  const tabs = [{ v: "", t: "全部" }, { v: "pay", t: "支付" }, { v: "refund", t: "退款" }];
  const invoiceable = d.invoiceable || [];
  const invoices = d.invoices || [];
  setBody(
    '<div class="card"><div class="row between"><div><div class="tiny faint">账户可用余额</div>' +
    '<div class="money" style="font-size:26px;color:var(--brand)">' + money(w.balance) + "</div></div>" +
    '<div style="text-align:right"><div class="tiny faint">累计入账</div><div class="bold">' + money(w.totalIncome) + "</div>" +
    '<div class="tiny faint mt8">冻结中 ' + money(w.frozen) + "</div></div></div>" +
    '<div class="hint mt12">课时费由平台担保账户托管，课程确认完成后 T+' + (rule.freeze_days ?? 7) + " 结算；退款原路退回。</div></div>" +
    '<div class="tabs">' + tabs.map((t) =>
      '<button class="' + (filter === t.v ? "on" : "") + '" data-go="/wallet' + (t.v ? "?type=" + t.v : "") + '">' + t.t + "</button>"
    ).join("") + "</div>" +
    '<div class="card">' + (list.length
      ? list.map((t) =>
        '<div class="list-item" style="cursor:default"><div class="grow">' +
        '<div class="row between"><span class="title">' + esc(TXN_LABEL[t.type] || t.type) + "</span>" +
        '<span class="money" style="color:' + (t.amount >= 0 ? "var(--brand-op-dark)" : "var(--ink)") + '">' +
        (t.amount >= 0 ? "+" : "-") + money(Math.abs(t.amount)) + "</span></div>" +
        '<div class="meta">' + esc(t.remark || "") + "</div>" +
        '<div class="tiny faint" style="margin-top:4px">' + fmtDate(t.created_at, "time") +
        (t.balance_after != null ? " · 余额 " + money(t.balance_after) : "") + "</div></div></div>").join("")
      : emptyHtml("暂无交易记录", "🧾")) + "</div>" +
    '<div class="card"><div class="card-title"><h3>发票申请</h3>' +
    '<span class="more">' + (invoiceable.length ? invoiceable.length + " 单可开票" : "暂无待开票") + "</span></div>" +
    (invoiceable.length
      ? invoiceable.map((o) =>
        '<div class="list-item" style="cursor:default"><div class="grow">' +
        '<div class="row between"><span class="title">' + esc(o.subject) + " · " + esc(o.stage) + "</span>" +
        '<span class="money">' + money(o.payable) + "</span></div>" +
        '<div class="meta">' + esc(o.order_no) + " · " + fmtDate(o.lesson_time, "time") + "</div></div>" +
        '<button class="btn btn-xs btn-ghost" data-invoice="' + o.id + '">申请开票</button></div>').join("")
      : emptyHtml("暂无可开票订单（已支付且未退款的订单可开票）", "🎫")) + "</div>" +
    '<div class="card"><div class="card-title"><h3>我的开票申请</h3></div>' +
    (invoices.length
      ? invoices.map((i) =>
        '<div class="list-item" style="cursor:default"><div class="grow">' +
        '<div class="row between"><span class="title">' + esc(i.title) + "</span>" +
        '<span class="badge ' + (i.status === "issued" ? "green" : i.status === "rejected" ? "danger" : "gold") + '">' +
        esc(INVOICE_STATUS[i.status] || i.status) + "</span></div>" +
        '<div class="meta">' + esc(i.invoice_no) + " · " + money(i.amount) +
        (i.order_no ? " · 订单 " + esc(i.order_no) : "") + "</div>" +
        '<div class="tiny faint" style="margin-top:4px">' + fmtDate(i.created_at, "time") +
        (i.reject_reason ? " · 驳回原因：" + esc(i.reject_reason) : "") + "</div>" +
        (i.invoice_url ? '<div class="tiny" style="margin-top:4px"><a href="' + esc(i.invoice_url) +
          '" target="_blank" rel="noopener">下载电子发票</a></div>' : "") +
        "</div></div>").join("")
      : emptyHtml("暂无开票申请", "🧾")) + "</div>"
  );
  const invMap = new Map(invoiceable.map((o) => [String(o.id), o]));
  $$("[data-invoice]", bodyEl()).forEach((btn) => {
    btn.addEventListener("click", () => {
      const o = invMap.get(String(btn.dataset.invoice));
      if (o) invoiceSheet(o, () => ROUTER.render());
    });
  });
  setActions({});
}

/* ---------------- 路由：个人资料 ---------------- */
async function profileView() {
  chrome({ title: "个人资料", plain: true, back: true });
  setBody(loadingHtml());
  const p = await api.get("/api/parent/profile");
  const u = p.user || {};
  setBody(
    '<div class="card"><div class="card-title"><h3>账号资料</h3>' +
    '<span class="more">' + (u.realName ? "已实名" : "未实名") + "</span></div>" +
    '<div class="row" style="gap:12px">' + avatarPickHtml(u, "lg") +
    '<div class="grow"><div class="bold">' + esc(u.nickname || "家长") + "</div>" +
    '<div class="tiny faint mt8">' + esc(u.phone || "-") + " · " + (u.avatar ? "点击头像可更换" : "点击头像上传图片") + "</div>" +
    '<div class="tiny faint mt8">' + (u.realName ? "实名：" + esc(u.realName) : "实名后可提升信用与纠纷处理效率") + "</div></div></div></div>" +
    '<div class="card"><div class="card-title"><h3>实名认证</h3></div>' +
    '<form data-form="realname"><div class="field"><label for="rn-name">真实姓名</label>' +
    '<input class="input" id="rn-name" name="realName" value="' + esc(u.realName || "") + '" placeholder="与身份证一致"></div>' +
    '<div class="field"><label for="rn-id">身份证号</label>' +
    '<input class="input" id="rn-id" name="idCard" maxlength="18" placeholder="18 位身份证号"></div>' +
    '<button class="btn btn-primary btn-block" type="submit">提交实名信息</button></form></div>' +
    '<div class="card"><div class="card-title"><h3>登录密码</h3><span class="more">用于密码登录</span></div>' +
    '<form data-form="pwd"><div class="field"><label for="pw">新密码</label>' +
    '<input class="input" id="pw" name="password" type="password" minlength="6" placeholder="至少 6 位"></div>' +
    '<button class="btn btn-outline btn-block" type="submit">设置密码</button></form></div>' +
    '<div class="card"><div class="card-title"><h3>平台协议</h3></div>' +
    qItem("📄", "用户协议", "", "/agreement/user") +
    qItem("🔒", "隐私政策", "", "/agreement/privacy") +
    qItem("↩️", "退款规则", "", "/agreement/refund") + "</div>"
  );

  const rnForm = $('[data-form="realname"]');
  rnForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(rnForm);
    if (!/^\d{17}[\dXx]$/.test(String(d.idCard || ""))) return toastErr("身份证号格式不正确");
    const btn = rnForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api.post("/api/auth/realname", { realName: d.realName, idCard: d.idCard });
      toastOk("实名信息已提交");
      ROUTER.render();
    } catch (err) {
      onError(err);
    } finally {
      btn.disabled = false;
    }
  });

  const pwForm = $('[data-form="pwd"]');
  pwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(pwForm);
    if (String(d.password || "").length < 6) return toastErr("密码至少 6 位");
    const btn = pwForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api.post("/api/auth/password", { password: d.password });
      toastOk("密码已设置，可用密码登录");
      pwForm.reset();
    } catch (err) {
      onError(err);
    } finally {
      btn.disabled = false;
    }
  });
  setActions({ avatar: changeAvatar });
}

/* ---------------- 路由：收藏 / 优惠券 / 客服 / 设置 / 协议 ---------------- */
async function favoritesView() {
  chrome({ title: "我的收藏", plain: true, back: true });
  setBody(loadingHtml());
  const favs = await api.get("/api/my/favorites");
  const ids = (favs || []).map((f) => f.teacher_id).slice(0, 20);
  const results = await Promise.all(ids.map((id) => api.get("/api/parent/teachers/" + id).catch(() => null)));
  const list = results.filter(Boolean);
  setBody(list.length
    ? '<p class="tiny faint mb12">共收藏 ' + (favs || []).length + " 位教员" + ((favs || []).length > 20 ? "，仅展示最近 20 位" : "") + "</p>" +
      list.map((t) => teacherRow(t)).join("")
    : '<div class="card">' + emptyHtml("还没有收藏教员，去广场逛逛吧", "♡") +
      '<button class="btn btn-ghost btn-sm btn-block" data-go="/plaza">去教员广场</button></div>');
  setActions({});
}

async function couponsView() {
  chrome({ title: "优惠券", plain: true, back: true });
  setBody(loadingHtml());
  const [mine, pub] = await Promise.all([api.get("/api/my/coupons"), api.get("/api/public/coupons").catch(() => [])]);
  const claimedIds = new Set((mine || []).map((c) => c.name));
  const claimable = (pub || []).filter((c) => !claimedIds.has(c.name));
  setBody(
    '<div class="section-title"><span class="bar"></span>我的优惠券（' + (mine || []).length + "）</div>" +
    ((mine || []).length
      ? mine.map((c) =>
        '<div class="card tight"><div class="row between"><div><div class="bold">' + esc(c.name) + "</div>" +
        '<div class="tiny faint mt8">满 ' + yuan(c.threshold) + " 元可用 · 有效期至 " + (c.valid_to ? fmtDate(c.valid_to, "date") : "长期") + "</div></div>" +
        '<div style="text-align:right"><div class="money" style="color:var(--gold);font-size:18px">' + money(c.amount) + "</div>" +
        (c.used ? '<span class="badge gray">已使用</span>' : '<span class="badge green">可使用</span>') + "</div></div></div>").join("")
      : '<div class="card">' + emptyHtml("暂无优惠券", "🎟️") + "</div>") +
    '<div class="section-title mt16"><span class="bar"></span>可领取（' + claimable.length + "）</div>" +
    (claimable.length
      ? claimable.map((c) =>
        '<div class="card tight row between"><div><div class="bold">' + esc(c.name) + "</div>" +
        '<div class="tiny faint mt8">满 ' + yuan(c.threshold) + " 元可用" + (c.total ? " · 剩余 " + Math.max(0, c.total - c.claimed) + " 张" : "") + "</div></div>" +
        '<button class="btn btn-sm btn-primary" data-act="claim" data-id="' + c.id + '">领取</button></div>').join("")
      : '<div class="card">' + emptyHtml("暂无可领取的优惠券", "🎟️") + "</div>")
  );
  setActions({
    claim: async (el) => {
      await api.post("/api/coupons/" + el.dataset.id + "/claim", {});
      toastOk("领取成功");
      ROUTER.render();
    },
  });
}

async function helpView() {
  chrome({ title: "客服帮助", plain: true, back: true });
  setBody(
    '<div class="card"><div class="card-title"><h3>联系方式</h3></div>' +
    qItem("📞", "客服热线", "400-800-1234") +
    qItem("🕘", "服务时间", "09:00 - 21:00") +
    qItem("💬", "在线客服", "工作日 5 分钟内响应") + "</div>" +
    '<div class="card"><div class="card-title"><h3>提交投诉 / 咨询</h3></div>' +
    '<form data-form="complaint"><div class="field"><label for="cp-title">问题标题</label>' +
    '<input class="input" id="cp-title" name="title" placeholder="如 教员迟到未上门"></div>' +
    '<div class="field"><label for="cp-content">详细描述</label>' +
    '<textarea class="textarea" id="cp-content" name="content" placeholder="请描述发生的时间、订单号与具体情况"></textarea></div>' +
    '<button class="btn btn-primary btn-block" type="submit">提交给平台客服</button></form>' +
    '<p class="tiny faint mt12">提交后平台将在 24 小时内联系您；涉及退款的纠纷可在订单详情页直接「申请退款」。</p></div>'
  );
  const form = $('[data-form="complaint"]');
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(form);
    if (!String(d.title || "").trim()) return toastErr("请填写问题标题");
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api.post("/api/complaints", { title: d.title, content: d.content });
      toastOk("已提交，客服会尽快联系您");
      form.reset();
    } catch (err) {
      onError(err);
    } finally {
      btn.disabled = false;
    }
  });
  setActions({});
}

async function settingsView() {
  chrome({ title: "设置", plain: true, back: true });
  const u = session.user || {};
  setBody(
    '<div class="card"><div class="card-title"><h3>账号</h3></div>' +
    qItem("👤", "个人资料", "", "/profile") +
    qItem("📍", "地址管理", "", "/addresses") +
    qItem("💳", "消费记录", "", "/wallet") +
    qItem("💬", "消息中心", state.unread ? state.unread + " 条未读" : "已读", "/messages") + "</div>" +
    '<div class="card"><div class="card-title"><h3>关于</h3></div>' +
    qItem("📄", "用户协议", "", "/agreement/user") +
    qItem("🔒", "隐私政策", "", "/agreement/privacy") +
    qItem("↩️", "退款规则", "", "/agreement/refund") +
    '<div class="kv"><span class="k">登录手机号</span><span class="v">' + esc(u.phone || "-") + "</span></div>" +
    '<div class="kv"><span class="k">当前版本</span><span class="v">家长端 v1.0.0</span></div></div>' +
    '<div class="card"><div class="card-title"><h3>账号安全与数据</h3></div>' +
    '<div class="tiny faint mb12">依据《个人信息保护法》，您可以随时注销账号。注销后手机号、姓名、身份证等身份信息将被清除，' +
    "已有订单与资金流水按合规要求留存备查；未完结订单或冻结资金需先处理完毕。</div>" +
    '<button class="btn btn-outline btn-block" data-act="deactivate" style="color:var(--danger);border-color:#ffd7d5">注销账号</button></div>' +
    '<button class="btn btn-outline btn-block" data-act="logout" style="margin-bottom:24px">退出登录</button>'
  );
  setActions({
    deactivate: async () => {
      const yes = await confirmDialog(
        "注销账号",
        "注销后将无法登录，个人身份信息将被清除且不可恢复。是否继续？",
        "确认注销",
        true
      );
      if (!yes) return;
      const word = await promptDialog("二次确认", "请输入「注销」两个字以确认", {
        value: "",
        textarea: false,
        confirmText: "提交注销",
      });
      if (word === null) return;
      if (word.trim() !== "注销") return toastErr("输入不匹配，已取消注销");
      try {
        const r = await api.post("/api/auth/deactivate", {});
        toastOk(r.message || "账号已注销");
        session.clear();
        setTimeout(showLogin, 800);
      } catch (err) {
        onError(err);
      }
    },
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
const guard = (fn, { guest = false } = {}) => async (ctx) => {
  setActions({});
  clearBar();
  // guest: true 的页面（首页发布需求、教员广场、教员详情、协议）游客直接看，
  // 只有点「发布需求 / 立即预约 / 收藏」这类动作时才由 requireLogin() 弹登录层
  if (!session.token && !guest) {
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
  "/": guard(homeView, { guest: true }),
  "/plaza": guard(plazaView, { guest: true }),
  "/teacher/:id": guard(teacherDetailView, { guest: true }),
  "/demand": guard(demandPage),
  "/demand/:id": guard(demandDetailView),
  "/orders": guard(ordersView),
  "/order/:id": guard(orderDetailView),
  "/review/:orderId": guard(reviewView),
  "/messages": guard(messagesView),
  "/me": guard(meView),
  "/addresses": guard(addressesView),
  "/wallet": guard(walletView),
  "/profile": guard(profileView),
  "/favorites": guard(favoritesView),
  "/coupons": guard(couponsView),
  "/help": guard(helpView),
  "/settings": guard(settingsView),
  "/agreement/:key": guard(agreementView, { guest: true }),
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
  state.guest = !session.token;
  // 游客也直接进首页：发布需求表单可见可填，登录层只在点「发布需求 / 立即预约 / 订单 / 消息」时弹
  if (!state.guest && !ensureParentRole()) return;
  ROUTER.render();
  if (session.token) refreshUnread();
}

boot();
