// ============================================================
// 平台管理后台（PC）· 业务逻辑
// 结构：哈希路由 + 左侧分组导航（待办红点）+ 顶栏 + 内容区
// 约定：金额一律为「分」的整数，展示用 money()，输入用 cents()
// ============================================================
import { session, api, loginByPassword, ApiError } from "./api.js";
import {
  esc, money, yuan, cents, fmtDate, fromNow, statusBadge, avatar,
  toast, toastOk, toastErr, confirmDialog, promptDialog, sheet,
  createRouter, loadingHtml, emptyHtml,
} from "./ui.js";

/* ---------------- 中文映射 ---------------- */
const ROLE = { parent: "家长", teacher: "教员", sales: "业务员", agent: "区域代理", admin: "管理员" };
const IDENTITY = { student: "在校大学生", in_service: "在职教师", part_time: "社会兼职教员" };
const ORDER_STATUS = {
  awaiting_payment: "待付款", pending_class: "待上课", in_class: "进行中",
  awaiting_parent_confirm: "待家长确认", completed: "已完成", settled: "已结算",
  cancelled: "已取消", refunding: "退款中", refunded: "已退款",
};
const AUDIT_STATUS = { pending: "待审核", approved: "已通过", rejected: "已驳回" };
const RISK_TYPE = { fake_checkin: "虚假打卡", brush: "刷单", abnormal_location: "定位异常", high_cancel: "高频取消", sos: "🚨 紧急求助" };
const RISK_LEVEL = { low: "低", mid: "中", high: "高" };
const RISK_STATUS = { open: "待处理", reviewing: "审核中", closed: "已关闭" };
const REWARD_TYPE = {
  register: "注册奖", lead: "留资奖", deal: "成交提成",
  daily_champ: "日冠军奖", weekly_champ: "周冠军奖", newbie_first: "新人首单奖",
};
const WITHDRAW_STATUS = { pending: "待审核", approved: "已通过", rejected: "已驳回", paid: "已打款" };
const APPEAL_STATUS = { none: "无申诉", pending: "待仲裁", accepted: "已撤销", rejected: "已驳回" };
const COMPLAINT_STATUS = { open: "待处理", agent_handled: "代理已处理", escalated: "已上报平台", closed: "已结案" };
const COMPLAINT_TYPE = { complaint: "客诉工单", review_appeal: "差评申诉" };
const AUDIENCE = { all: "全部用户", parent: "家长", teacher: "教员", sales: "业务员", agent: "区域代理" };
const PAY_TYPE = { pay: "支付", refund: "退款" };
const CHANNEL = { wechat_jsapi: "微信 JSAPI", wechat_app: "微信 APP", bank: "银行卡", wechat: "微信" };
const PHOTO_LABEL = {
  eduCertUrl: "学历证件", teacherCertUrl: "教师资格证", skillCertUrl: "技能证书",
  idCardFrontUrl: "身份证人像面", idCardBackUrl: "身份证国徽面",
};

const PROVIDER_ROLE_ORDER = ["parent", "teacher", "sales", "agent", "admin"];

 /* ---------------- 通用小工具 ---------------- */
 /** 列表分页每页条数（与后端默认上限一致） */
 const PAGE_SIZE = 300;
const num = (v) => Number(v || 0).toLocaleString("zh-CN");
/** 比例数值 → 百分数（0.25 → 25.0%） */
const pct = (v, digits = 1) => (Number(v || 0) * 100).toFixed(digits).replace(/\.0+$/, "") + "%";
const or = (v, fallback = "—") => (v === null || v === undefined || v === "" ? fallback : v);
const orderStatusBadge = (s) => statusBadge(s, ORDER_STATUS[s] || s);
const payBadge = (s) => statusBadge(s === "paid" ? "paid" : s, WITHDRAW_STATUS[s] || s);

/** 金额大数字（无 ¥ 符号，用于 KPI） */
const moneyNum = (c) => money(c, false);

function kv(k, v) {
  return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v">' + v + "</span></div>";
}

function tableHtml(cols, rows) {
  if (!rows.length) return "";
  return (
    '<div class="table-wrap"><table class="table"><thead><tr>' +
    cols.map((c) => "<th>" + c + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows.map((r) => "<tr>" + r.map((c) => "<td>" + c + "</td>").join("") + "</tr>").join("") +
    "</tbody></table></div>"
  );
}

/** 紧凑翻页器（配合后端 page/pageSize/total） */
function pagerHtml(meta) {
  if (!meta || !meta.pages || meta.pages <= 1) return "";
  const { page, pages, total, pageSize } = meta;
  const btn = (label, p, disabled) =>
    '<button class="btn btn-sm btn-outline" data-act="page" data-p="' + p + '"' + (disabled ? " disabled" : "") + ">" + label + "</button>";
  return (
    '<div class="pc-toolbar" style="justify-content:flex-end;margin:12px 0 0;gap:8px">' +
    '<span class="small faint">第 ' + page + " / " + pages + " 页 · 每页 " + num(pageSize) + " 条 · 共 " + num(total) + " 条</span>" +
    btn("上一页", page - 1, page <= 1) +
    btn("下一页", page + 1, page >= pages) +
    "</div>"
  );
}

function errorHtml(err) {
  return (
    '<div class="pc-card"><div class="empty"><div class="ico">⚠️</div>' +
    esc(err?.message || "加载失败，请稍后重试") +
    '</div><div class="center" style="margin-bottom:8px"><button class="btn btn-sm btn-primary" data-retry>重新加载</button></div></div>'
  );
}

/** 把一段 HTML 画进内容区，返回可绑事件的根节点（下次渲染自动丢弃，避免监听重复） */
function paint(root, html) {
  const box = document.createElement("div");
  box.className = "view";
  box.innerHTML = html;
  root.replaceChildren(box);
  return box;
}

/** 区块级 loading / 空 / 错误 三态加载：fn 取数，render 渲染，返回数据供后续操作复用 */
async function loadData(el, fn, render, options) {
  // 允许 loadData(el, fn, { loading, empty }) 的简写形式（无自定义渲染器）
  let opts = options || {};
  if (render && typeof render !== "function") {
    opts = render;
    render = null;
  }
  const loading = opts.loading || "加载中…";
  const empty = opts.empty || "暂无数据";
  const icon = opts.icon || "📭";
  if (!el) return null;
  el.innerHTML = loadingHtml(loading);
  const run = async () => {
    try {
      const data = await fn();
      const html = typeof render === "function" ? render(data) : typeof data === "string" ? data : "";
      el.innerHTML = html || emptyHtml(empty, icon);
      return data;
    } catch (err) {
      if (err?.status === 401) { handle401(); return null; }
      el.innerHTML = errorHtml(err);
      const b = el.querySelector("[data-retry]");
      if (b) b.onclick = () => run();
      return null;
    }
  };
  return run();
}

/** 按钮忙碌态：禁用并替换文案，结束后恢复（避免重复提交） */
async function busy(btn, fn) {
  if (!btn) return fn();
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "处理中…";
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = html;
  }
}

/** 通用编辑弹窗（PC 居中表单），返回字段值对象或 null */
function formDialog(title, fields, submitText = "保存") {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "mask center";
    const ctrl = (f) => {
      const v = f.value === null || f.value === undefined ? "" : f.value;
      if (f.type === "select") {
        return (
          '<select class="select" data-k="' + f.key + '">' +
          (f.options || [])
            .map((o) => '<option value="' + esc(o.value) + '"' + (String(o.value) === String(v) ? " selected" : "") + ">" + esc(o.label) + "</option>")
            .join("") +
          "</select>"
        );
      }
      if (f.type === "textarea") {
        return '<textarea class="textarea" data-k="' + f.key + '" style="min-height:76px">' + esc(v) + "</textarea>";
      }
      return (
        '<input class="input" data-k="' + f.key + '" type="' + (f.type || "text") + '" value="' + esc(v) + '"' +
        (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : "") + ">"
      );
    };
    mask.innerHTML =
      '<div class="dialog" style="width:min(560px,92vw)">' +
      '<h3 style="font-size:16px;font-weight:700">' + esc(title) + "</h3>" +
      '<div class="form-grid mt16">' +
      fields.map((f) => '<div class="field"><label>' + esc(f.label) + "</label>" + ctrl(f) + "</div>").join("") +
      "</div>" +
      '<div class="btn-row" style="margin-top:20px">' +
      '<button class="btn btn-outline" data-act="cancel">取消</button>' +
      '<button class="btn btn-primary" data-act="save">' + esc(submitText) + "</button>" +
      "</div></div>";
    document.body.appendChild(mask);
    const close = (val) => { mask.remove(); resolve(val); };
    mask.addEventListener("click", (e) => {
      if (e.target === mask || e.target.closest('[data-act="cancel"]')) return close(null);
      if (e.target.closest('[data-act="save"]')) {
        const out = {};
        fields.forEach((f) => {
          const el = mask.querySelector('[data-k="' + f.key + '"]');
          if (!el) return;
          out[f.key] = f.type === "number" ? (el.value === "" ? 0 : Number(el.value)) : el.value;
        });
        close(out);
      }
    });
  });
}

/** 统一的动作绑定：data-act=xxx，异常统一 toast 提示 */
function bindActions(box, map) {
  box.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || !box.contains(btn)) return;
    const fn = map[btn.dataset.act];
    if (!fn) return;
    try {
      await fn(btn, e);
    } catch (err) {
      if (err?.status === 401) return handle401();
      toastErr(err?.message || "操作失败");
    }
  });
}

/* ---------------- 页面状态 ---------------- */
const state = {
  pending: null,     // overview.pending
  metrics: null,     // overview.metrics
  regions: null,     // 片区列表缓存
  levels: null,      // 教员等级（rules-public.teacher_levels）
  rules: null,       // 规则配置缓存（仅系统设置读取 platforms 用）
};

const $route = () => document.querySelector("[data-route]");
const go = (path) => { location.hash = "#" + path; };

async function getRegions(force = false) {
  if (!state.regions || force) state.regions = await api.get("/api/admin/regions");
  return state.regions || [];
}
function regionName(id) {
  const r = (state.regions || []).find((x) => x.id === Number(id));
  return r ? r.name : id ? "片区 #" + id : "—";
}
async function getLevels(force = false) {
  if (!state.levels || force) {
    const list = await api.get("/api/meta/rules-public");
    const lv = (list || []).find((r) => r.key === "teacher_levels");
    state.levels = lv ? lv.value : [];
  }
  return state.levels || [];
}
const LEVEL_NAMES = { Lv1: "见习教员", Lv2: "普通教员", Lv3: "优选教员", Lv4: "金牌教员", Lv5: "名师" };
function levelName(key) {
  const lv = (state.levels || []).find((l) => l.level === key);
  return lv ? lv.name : LEVEL_NAMES[key] || key || "未评级";
}
function levelBadge(key) {
  const map = { Lv1: "lv1", Lv2: "lv2", Lv3: "lv3", Lv4: "lv4", Lv5: "lv5" };
  return '<span class="level-badge ' + (map[key] || "lv1") + '">' + esc(key || "Lv1") + " · " + esc(levelName(key)) + "</span>";
}

/* ---------------- 侧边导航 ---------------- */
const NAV = [
  { grp: "总览", items: [{ path: "/", label: "数据总览", ico: "📊" }] },
  {
    grp: "用户",
    items: [
      { path: "/users", label: "用户管理", ico: "👥" },
      { path: "/audit", label: "教员资质审核", ico: "📝", badge: () => state.pending?.teacherAudits || 0 },
      { path: "/levels", label: "教员等级调整", ico: "🏅" },
      { path: "/agents", label: "区域与代理", ico: "🗺️" },
    ],
  },
  {
    grp: "交易",
    items: [
      { path: "/orders", label: "订单与需求", ico: "🧾" },
      { path: "/refunds", label: "退款工单", ico: "↩️", badge: () => state.pending?.refunds || 0 },
    ],
  },
  { grp: "规则", items: [{ path: "/rules", label: "规则配置中心", ico: "⚙️" }] },
  { grp: "资金", items: [{ path: "/finance", label: "财务资金", ico: "💰", badge: () => state.pending?.withdrawals || 0 }] },
  {
    grp: "风控",
    items: [{
      path: "/risk", label: "风控与审核", ico: "🛡️",
      badge: () => (state.pending?.risks || 0) + (state.pending?.appeals || 0) + (state.pending?.complaints || 0),
    }],
  },
  { grp: "运营", items: [{ path: "/ops", label: "运营工具", ico: "📣" }] },
  { grp: "系统", items: [{ path: "/system", label: "系统设置", ico: "🔧" }] },
];

function sideHtml() {
  return (
    '<div class="brand"><div class="logo">🎓</div><div><b>家教上门撮合</b><small>平台管理后台 · PC</small></div></div>' +
    '<nav class="pc-nav">' +
    NAV.map((g) =>
      '<div class="grp">' + esc(g.grp) + "</div>" +
      g.items.map((it) =>
        '<a href="#' + it.path + '" data-nav="' + it.path + '">' +
        '<span class="ico">' + it.ico + "</span><span>" + esc(it.label) + "</span></a>"
      ).join("")
    ).join("") +
    "</nav>"
  );
}

function refreshBadges() {
  NAV.forEach((g) => g.items.forEach((it) => {
    const a = document.querySelector('#side a[data-nav="' + it.path + '"]');
    if (!a) return;
    const n = it.badge ? it.badge() : 0;
    let b = a.querySelector(".badge-n");
    if (n > 0) {
      if (!b) {
        b = document.createElement("span");
        b.className = "badge-n";
        a.appendChild(b);
      }
      b.textContent = n > 99 ? "99+" : String(n);
    } else if (b) b.remove();
  }));
}

/* ---------------- 顶栏 ---------------- */
function topHtml(meta) {
  const u = session.user || {};
  return (
    "<h2>" + esc(meta.title || "平台管理后台") + "</h2>" +
    '<span class="badge gray" data-crumb>' + esc(meta.sub || "") + "</span>" +
    '<span class="spacer"></span>' +
    '<button class="btn btn-sm btn-outline" data-top="settle">⚖️ 重算结算</button>' +
    '<button class="btn btn-sm btn-outline" data-top="refresh">🔄 刷新</button>' +
    '<div class="top-user">' + avatar(u.nickname || "管", u.avatar) +
    '<div><div class="small bold">' + esc(u.nickname || "管理员") + '</div><div class="tiny faint">' +
    esc(ROLE[u.role] || "管理员") + " · " + esc(u.phone || "") + "</div></div></div>" +
    '<button class="btn btn-sm btn-outline" data-top="password">🔑 修改口令</button>' +
    '<button class="btn btn-sm btn-outline" data-top="logout">退出</button>'
  );
}

function bindTop(top) {
  if (top.dataset.bound === "1") return;
  top.dataset.bound = "1";
  top.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-top]");
    if (!btn) return;
    const act = btn.dataset.top;
    if (act === "refresh") {
      await busy(btn, async () => {
        await syncPending();
        getRouter().render();
        toastOk("已刷新");
      });
    } else if (act === "settle") {
      await runSettle(btn);
    } else if (act === "password") {
      await changeOwnPassword(btn);
    } else if (act === "logout") {
      const ok = await confirmDialog("退出登录", "退出后需要重新输入管理员账号与口令。", "退出");
      if (!ok) return;
      session.clear();

      showLogin();
    }
  });
}

/**
 * 修改本管理员登录口令（与正式实现 POST /api/auth/change-password 同契约）：
 * 先校验旧口令，再要求新口令 ≥8 位且含字母与数字、不得与原口令相同。
 * 成功后服务端返回新令牌——参考实现没有 token_version，所以其它设备上的旧令牌仍有效；
 * 这一点已在 docs/MIGRATION P64 记为与正式实现的差异。
 */
async function changeOwnPassword(btn) {
  const vals = await formDialog(
    "修改登录口令",
    [
      { key: "oldPassword", label: "当前口令", type: "password", placeholder: "输入正在使用的登录口令" },
      { key: "newPassword", label: "新口令", type: "password", placeholder: "至少 8 位，需同时包含字母与数字" },
      { key: "confirmPassword", label: "确认新口令", type: "password", placeholder: "再输入一次新口令" },
    ],
    "保存新口令"
  );
  if (!vals) return;
  const oldPassword = String(vals.oldPassword || "");
  const newPassword = String(vals.newPassword || "");
  if (!oldPassword) return toastErr("请先填写当前口令");
  if (newPassword.length < 8) return toastErr("新口令至少 8 位");
  if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) return toastErr("新口令需同时包含字母与数字");
  if (newPassword === oldPassword) return toastErr("新口令不能与当前口令相同");
  if (newPassword !== String(vals.confirmPassword || "")) return toastErr("两次输入的新口令不一致");
  await busy(btn, async () => {
    try {
      const r = await api.post("/api/auth/change-password", { oldPassword, newPassword });
      if (r.token) session.save(r.token, session.user);
      toastOk("口令已更新，下次请用新口令登录");
    } catch (err) {
      if (err?.status === 401) return handle401();
      toastErr(err?.message || "修改口令失败");
    }
  });
}

/** 渲染骨架（导航 + 顶栏标题），每次路由切换调用 */
function renderChrome(path) {
  const meta = ROUTES[path] || { title: "页面不存在", sub: "" };
  // 键盘用户在侧栏回车跳转后，重绘侧栏会丢失焦点，这里按原路径恢复
  const focusedNav = document.activeElement?.closest?.("#side a[data-nav]")?.dataset.nav;
  const side = document.getElementById("side");
  side.innerHTML = sideHtml();
  const top = document.getElementById("top");
  top.innerHTML = topHtml(meta);
  bindTop(top);
  document.querySelectorAll("#side a[data-nav]").forEach((a) => {
    a.classList.toggle("on", a.dataset.nav === path);
  });
  refreshBadges();
  if (focusedNav) side.querySelector('a[data-nav="' + focusedNav + '"]')?.focus({ preventScroll: true });
  document.title = meta.title ? meta.title + " · 平台管理后台" : "平台管理后台 · 家教上门撮合平台";
}

/* ---------------- 待办计数同步 ---------------- */
async function syncPending() {
  try {
    const d = await api.get("/api/admin/overview");
    state.pending = d.pending;
    state.metrics = d.metrics;
    refreshBadges();
    return d;
  } catch (err) {
    if (err?.status === 401) handle401();
    return null;
  }
}

/* ---------------- 结算 ---------------- */
async function runSettle(btn) {
  const ok = await confirmDialog(
    "手动触发结算",
    "将立即扫描所有已确认完成且已过冻结期的订单并放款给教员，同时写入担保台账与操作日志。",
    "立即结算"
  );
  if (!ok) return;
  await busy(btn, async () => {
    const d = await api.post("/api/admin/settlement/run", { force: true });
    toastOk("结算完成：本次放款 " + num(d.settled) + " 笔，担保余额 " + money(d.escrowBalance));
    await syncPending();
    getRouter().render();
  });
}

/* ---------------- 登录层 ---------------- */
function loginHtml() {
  return (
    '<div class="brand-col">' +
    '<div class="brand-mark"><div class="logo">🎓</div><div><b>家教上门撮合平台</b><small>管理控制台</small></div></div>' +
    "<h1>平台管理后台</h1>" +
    '<p class="lead">统一管理用户与资质、订单与资金、13 组可配置业务规则、区域代理与电子围栏、风控仲裁与运营工具。所有变更即时生效并写入操作日志。</p>' +
    '<div class="feats">' +
    '<div class="feat"><div class="k">⚙️</div><div class="t">规则热更新</div><div class="d">抽佣 / 派单 / 等级 / 结算参数改完即生效</div></div>' +
    '<div class="feat"><div class="k">💰</div><div class="t">担保台账</div><div class="d">逐笔资金流水与两条对账恒等式校验</div></div>' +
    '<div class="feat"><div class="k">🛡️</div><div class="t">风控仲裁</div><div class="d">异常订单、差评申诉、客诉终审一站处理</div></div>' +
    "</div></div>" +
    '<div class="card-col"><form class="login-card" autocomplete="off">' +
    '<div class="card-head"><h2>管理员登录</h2><p>请使用平台管理员账号登录，其他角色账号无法进入后台。</p></div>' +
    '<div class="field"><label for="lg-phone">手机号</label>' +
    '<input class="input" id="lg-phone" name="phone" inputmode="numeric" maxlength="11" value="13900000001" placeholder="请输入 11 位手机号"></div>' +
    '<div class="field"><label for="lg-pwd">登录口令</label>' +
    '<input class="input" id="lg-pwd" name="password" type="password" value="a123456" placeholder="请输入登录口令"></div>' +
    '<div class="login-msg" data-msg></div>' +
    '<button class="btn btn-primary" type="submit" data-submit>登录后台</button>' +
    '<div class="foot"><span>演示账号 13900000001</span><span>统一口令 a123456</span></div>' +
    "</form></div>"
  );
}

function bindLogin(el) {
  const form = el.querySelector("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = el.querySelector("[data-msg]");
    const btn = el.querySelector("[data-submit]");
    const phone = String(form.phone.value || "").trim();
    const password = String(form.password.value || "");
    const fail = (text) => {
      msg.className = "login-msg";
      msg.textContent = text;
      btn.disabled = false;
      btn.innerHTML = "登录后台";
    };
    msg.className = "login-msg";
    msg.textContent = "";
    if (!/^1\d{10}$/.test(phone)) return fail("请输入正确的 11 位手机号");
    if (!password) return fail("请输入登录口令");
    btn.disabled = true;
    btn.innerHTML = "登录中…";
    try {
      const data = await loginByPassword(phone, password, "admin");
      if (data?.user?.role !== "admin") {
        session.clear();
        throw new ApiError("该账号不是平台管理员，无法进入后台", "ROLE_MISMATCH", 403);
      }
      el.remove();
      boot();
      toastOk("欢迎回来，" + (data.user.nickname || "管理员"));
    } catch (err) {
      fail(err?.message || "登录失败，请重试");
    }
  });
}

function showLogin() {
  let el = document.querySelector(".admin-login");
  if (!el) {
    el = document.createElement("div");
    el.className = "admin-login";
    document.body.appendChild(el);
  }
  el.innerHTML = loginHtml();
  bindLogin(el);
  document.getElementById("side").innerHTML = "";
  document.getElementById("top").innerHTML = "";
  $route().innerHTML = "";
  const phone = el.querySelector("#lg-phone");
  if (phone) phone.focus();
}

function handle401() {
  session.clear();

  if (!document.querySelector(".admin-login")) toastErr("登录已失效，请重新登录");
  showLogin();
}

/* ---------------- 通用：证件图 ---------------- */
function certThumb(url, key) {
  const label = PHOTO_LABEL[key] || key;
  if (!url) {
    return '<div class="thumb empty"><div class="ph">—</div><span>' + esc(label) + " 未上传</span></div>";
  }
  return (
    '<button type="button" class="thumb" data-act="photo" data-src="' + esc(url) + '" data-label="' + esc(label) + '">' +
    '<img src="' + esc(url) + '" alt="' + esc(label) + '"><span>' + esc(label) + "</span></button>"
  );
}

/* ---------------- 视图 1：数据总览 ---------------- */
function trendHtml(trend, mode) {
  const max = Math.max(1, ...trend.map((t) => (mode === "gmv" ? t.gmv : t.orders)));
  return (
    '<div class="bars tall trend">' +
    trend.map((t) => {
      const v = mode === "gmv" ? t.gmv : t.orders;
      const h = Math.max(3, Math.round((v / max) * 100));
      const tip = t.date + " · 订单 " + t.orders + " 单 · GMV " + money(t.gmv);
      return (
        '<div class="bar" title="' + esc(tip) + '">' +
        '<i class="' + (mode === "gmv" ? "gmv" : "") + '" style="height:' + h + "%" + (v === 0 ? ";opacity:.28" : "") + '"></i>' +
        "<span>" + esc(t.date.slice(5)) + "</span></div>"
      );
    }).join("") +
    "</div>"
  );
}

async function viewDashboard(root) {
  const box = paint(root, '<div data-body>' + loadingHtml("正在加载数据总览…") + "</div>");
  const body = box.querySelector("[data-body]");
  let data = null;
  try {
    data = await api.get("/api/admin/overview");
  } catch (err) {
    if (err?.status === 401) return handle401();
    body.innerHTML = errorHtml(err);
    body.querySelector("[data-retry]").onclick = () => viewDashboard(root);
    return;
  }
  state.pending = data.pending;
  state.metrics = data.metrics;
  refreshBadges();

  const m = data.metrics;
  const roles = {};
  (data.roleCount || []).forEach((r) => { roles[r.role] = r.c; });
  const roleLine = PROVIDER_ROLE_ORDER.map((r) => ROLE[r] + " " + num(roles[r] || 0)).join(" · ");
  const maxGmv = Math.max(1, ...(data.regionRank || []).map((r) => r.gmv));
  const maxSd = Math.max(1, ...(data.supplyDemand || []).flatMap((s) => [s.teachers, s.demands]));
  const todo = [
    { k: "📝", l: "教员待审", n: data.pending.teacherAudits, to: "/audit" },
    { k: "💰", l: "提现待审", n: data.pending.withdrawals, to: "/finance" },
    { k: "↩️", l: "退款工单", n: data.pending.refunds, to: "/refunds" },
    { k: "⭐", l: "差评申诉", n: data.pending.appeals, to: "/risk" },
    { k: "🛡️", l: "风险事件", n: data.pending.risks, to: "/risk" },
    { k: "📣", l: "投诉工单", n: data.pending.complaints, to: "/risk" },
  ];

  const kpis =
    '<div class="kpi primary rise"><div class="label">👥 总用户</div><div class="value">' + num(m.totalUsers) + '</div>' +
    '<div class="foot">' + esc(roleLine) + "</div></div>" +
    '<div class="kpi rise" style="animation-delay:.03s"><div class="label">⚡ 日活（今日登录）</div><div class="value">' + num(m.dau) + "</div>" +
    '<div class="foot">活跃率 ' + (m.totalUsers ? ((m.dau / m.totalUsers) * 100).toFixed(1) + "%" : "—") + "</div></div>" +
    '<div class="kpi rise" style="animation-delay:.06s"><div class="label">🧾 今日订单</div><div class="value">' + num(m.todayOrders) + "</div>" +
    '<div class="foot">累计支付 GMV ' + money(m.totalGmv) + "</div></div>" +
    '<div class="kpi gold rise" style="animation-delay:.09s"><div class="label">📈 本月 GMV</div><div class="value">' + moneyNum(m.monthGmv) + "<small>元</small></div>" +
    '<div class="foot">按支付时间口径统计</div></div>' +
    '<div class="kpi green rise" style="animation-delay:.12s"><div class="label">🏦 平台营收</div><div class="value">' + moneyNum(m.revenue) + "<small>元</small></div>" +
    '<div class="foot">服务费收入 ' + money(m.serviceFee) + "</div></div>" +
    '<div class="kpi rise" style="animation-delay:.15s"><div class="label">🔒 担保在账</div><div class="value">' + moneyNum(m.escrow) + "<small>元</small></div>" +
    '<div class="foot">已支付未结算 / 未退款资金</div></div>';

  body.innerHTML =
    '<div class="pc-toolbar">' +
    '<span class="faint small">统计口径：自然日（UTC）· 数据实时读取</span><span style="flex:1"></span>' +
    '<button class="btn btn-sm btn-primary" data-act="settle">⚖️ 手动触发结算</button>' +
    '<button class="btn btn-sm btn-outline" data-act="reload">刷新数据</button></div>' +
    '<div class="pc-grid c3 mb16">' + kpis + "</div>" +
    '<div class="pc-grid c2 mb16">' +
    '<div class="pc-card"><h3>📈 近 14 天趋势<span class="more" data-trend-scale></span></h3>' +
    '<div class="row between mb12"><div class="legend">' +
    '<span><i class="dot" style="background:var(--brand)"></i> 订单量（单）</span>' +
    '<span><i class="dot" style="background:var(--gold)"></i> GMV（元）</span></div>' +
    '<div class="segmented" style="width:180px"><button data-mode="orders" class="on">订单量</button><button data-mode="gmv">GMV</button></div></div>' +
    '<div data-trend>' + trendHtml(data.trend, "orders") + "</div></div>" +
    '<div class="pc-card"><h3>🔔 待办清单<span class="more">点击直达处理页</span></h3>' +
    '<div class="todo">' +
    todo.map((t) =>
      '<button data-act="todo" data-to="' + t.to + '"><span class="k">' + t.k + '</span><span class="l">' + t.l +
      '</span><span class="n ' + (t.n ? "" : "zero") + '">' + num(t.n) + "</span></button>"
    ).join("") +
    "</div>" +
    '<div class="hint muted mt12">退款工单与提现审核涉及真实资金流，处理前请核对订单与台账；风险事件关闭会同时解除结算冻结。</div>' +
    "</div></div>" +
    '<div class="pc-grid c2">' +
    '<div class="pc-card"><h3>🏆 区域业绩排行<span class="more">按支付 GMV 排序</span></h3>' +
    tableHtml(
      ["#", "片区", "支付订单", "GMV", "占比"],
      (data.regionRank || []).map((r, i) => [
        '<span class="faint">' + (i + 1) + "</span>",
        "<b>" + esc(r.name) + "</b>",
        '<span class="num">' + num(r.orders) + "</span>",
        '<span class="num">' + money(r.gmv) + "</span>",
        '<div class="row" style="gap:8px"><div class="progress grow"><i style="width:' +
          Math.max(r.gmv ? 2 : 0, Math.round((r.gmv / maxGmv) * 100)) + '%"></i></div><span class="tiny faint num">' +
          (maxGmv ? ((r.gmv / maxGmv) * 100).toFixed(0) : 0) + "%</span></div>",
      ])
    ) + "</div>" +
    '<div class="pc-card"><h3>🌡️ 供需热力<span class="more">在册教员 vs 在招需求</span></h3>' +
    '<div class="legend mb12"><span><i class="dot" style="background:var(--brand)"></i> 在册教员</span>' +
    '<span><i class="dot" style="background:var(--gold)"></i> 在招需求</span></div>' +
    (data.supplyDemand || []).map((s) => {
      const tight = s.demands >= s.teachers;
      return (
        '<div style="margin-bottom:12px">' +
        '<div class="row between"><span class="bold small">' + esc(s.name) + "</span>" +
        '<span class="tag ' + (tight ? "neg" : "pos") + '">' + (tight ? "供不应求" : "供给充足") + "</span></div>" +
        '<div class="row mt8" style="gap:8px"><span class="tiny faint nowrap" style="width:58px">在册教员</span>' +
        '<div class="progress grow"><i style="width:' + Math.round((s.teachers / maxSd) * 100) + '%"></i></div>' +
        '<span class="tiny num" style="width:26px;text-align:right">' + num(s.teachers) + "</span></div>" +
        '<div class="row mt8" style="gap:8px"><span class="tiny faint nowrap" style="width:58px">在招需求</span>' +
        '<div class="progress gold grow"><i style="width:' + Math.round((s.demands / maxSd) * 100) + '%"></i></div>' +
        '<span class="tiny num" style="width:26px;text-align:right">' + num(s.demands) + "</span></div>" +
        "</div>"
      );
    }).join("") + "</div></div>";

  // 趋势口径切换：仅重绘图表，不重新请求
  let mode = "orders";
  const scale = body.querySelector("[data-trend-scale]");
  const setScale = () => {
    const max = Math.max(0, ...data.trend.map((t) => (mode === "gmv" ? t.gmv : t.orders)));
    scale.textContent = mode === "gmv" ? "峰值 " + money(max) : "峰值 " + num(max) + " 单";
  };
  setScale();
  body.querySelectorAll("[data-mode]").forEach((b) => {
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      body.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === b));
      body.querySelector("[data-trend]").innerHTML = trendHtml(data.trend, mode);
      setScale();
    });
  });

  bindActions(box, {
    settle: (btn) => runSettle(btn),
    reload: () => viewDashboard(root),
    todo: (btn) => go(btn.dataset.to),
    photo: (btn) => openPhoto(btn.dataset.src, btn.dataset.label),
  });
}

function openPhoto(src, label) {
  sheet(label || "证件图", '<img src="' + esc(src) + '" alt="' + esc(label || "") + '" style="width:100%;border-radius:12px;background:#f1f4f9">', [
    { label: "关闭", class: "btn-outline", onClick: () => {} },
  ]);
}


/* ============================================================
   用户组：用户管理 / 教员资质审核 / 教员等级调整 / 区域与代理
   ============================================================ */

function userProfileCell(u) {
  if (u.role === "teacher") {
    if (!u.teacher) return '<span class="faint small">未提交入驻资料</span>';
    const t = u.teacher;
    return (
      '<div class="row wrap" style="gap:4px">' +
      levelBadge(t.level) +
      statusBadge(t.auditStatus, AUDIT_STATUS[t.auditStatus] || t.auditStatus) +
      "</div>" +
      '<div class="tiny faint mt8">成长 ' + num(t.growthScore) + " · ★ " + Number(t.ratingAvg || 0).toFixed(1) +
      " · " + (t.online ? '<span style="color:#0a8f66">在线</span>' : "离线") +
      (t.hourlyPrice ? " · " + money(t.hourlyPrice) + "/课时" : "") + "</div>"
    );
  }
  if (u.role === "parent") {
    const p = u.parent || {};
    return (
      '<div class="small">信用 ' + num(p.credit_score) + " 分 " + statusBadge("", p.credit_level || "L0") + "</div>" +
      '<div class="tiny faint mt8">完成 ' + num(p.completed_orders) + " 单" +
      (p.restricted ? ' · <span style="color:#f53f3f">已受限</span>' : "") + "</div>"
    );
  }
  if (u.role === "agent") {
    const a = u.agent || {};
    return (
      '<div class="small">等级 ' + esc(a.level || "—") + " · 服务费分成 " + pct(a.commission_rate) + "</div>" +
      '<div class="tiny faint mt8">管理提成 ' + pct(a.mgmt_rate) + " · 保证金 " + money(a.deposit || 0) + "</div>"
    );
  }
  if (u.role === "sales") {
    const s = u.sales || {};
    return (
      '<div class="small">推广码 <span class="mono">' + esc(s.code || "—") + "</span></div>" +
      '<div class="tiny faint mt8">归属代理 #' + esc(or(s.agent_id)) + " · 入组 " + fmtDate(s.joined_at, "date") + "</div>"
    );
  }
  return '<span class="badge gray">平台管理员</span>';
}

function userActionCell(u) {
  if (u.role === "admin") {
    return '<button class="btn btn-xs btn-outline" disabled title="后端禁止禁用管理员账号">禁用</button>';
  }
  const active = u.status === "active";
  return (
    '<button class="btn btn-xs ' + (active ? "btn-danger" : "btn-primary") + '" data-act="toggle" data-id="' + u.id + '">' +
    (active ? "禁用" : "启用") + "</button>" +
    (u.role === "teacher" ? '<a class="btn btn-xs btn-outline" href="#/levels">等级</a>' : "")
  );
}

function usersTable(list) {
  return tableHtml(
    ["ID", "昵称", "手机号", "角色", "片区", "状态", "档案", "注册时间", "操作"],
    list.map((u) => [
      '<span class="faint num">#' + u.id + "</span>",
      '<div class="bold">' + esc(u.nickname) + "</div>",
      '<span class="mono">' + esc(u.phone || "—") + "</span>",
      '<span class="badge ' + (u.role === "admin" ? "gray" : u.role === "teacher" ? "green" : "") + '">' +
        esc(ROLE[u.role] || u.role) + "</span>",
      esc(regionName(u.regionId)),
      statusBadge(u.status, u.status === "active" ? "正常" : "已禁用"),
      userProfileCell(u),
      '<span class="faint small nowrap">' + fmtDate(u.createdAt, "date") + "</span>",
      '<div class="row" style="gap:6px">' + userActionCell(u) + "</div>",
    ])
  );
}

async function viewUsers(root) {
  try {
    await Promise.all([getRegions(), getLevels()]);
  } catch (err) {
    if (err?.status === 401) return handle401();
  }
  const box = paint(root, `
    <div class="pc-card">
      <h3>👥 用户管理<span class="more" data-count>—</span></h3>
      <form class="pc-toolbar" data-filter autocomplete="off">
        <select class="select" name="role">
          <option value="">全部角色</option>
          ${PROVIDER_ROLE_ORDER.map((r) => `<option value="${r}">${ROLE[r]}</option>`).join("")}
        </select>
        <select class="select" name="status">
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="disabled">已禁用</option>
        </select>
        <input class="input" name="keyword" placeholder="昵称 / 手机号关键字" style="min-width:220px">
        <button class="btn btn-sm btn-primary" type="submit">查询</button>
        <button class="btn btn-sm btn-outline" type="button" data-act="reset">重置</button>
      </form>
      <div data-list></div>
    </div>`);

  const listEl = box.querySelector("[data-list]");
  const countEl = box.querySelector("[data-count]");
  const form = box.querySelector("[data-filter]");
  let rows = [];
  let pageNo = 1;
  let meta = null;

  const load = () =>
    loadData(
      listEl,
      async () => {
        const r = await api.get("/api/admin/users", {
          role: form.role.value,
          status: form.status.value,
          keyword: form.keyword.value.trim(),
          page: pageNo,
          pageSize: PAGE_SIZE,
        });
        rows = r.list || [];
        meta = { page: r.page, pages: r.pages, total: r.total, pageSize: r.pageSize };
        countEl.textContent = "共 " + num(r.total) + " 位用户 · 第 " + r.page + "/" + r.pages + " 页";
        return usersTable(rows) + pagerHtml(meta);
      },
      { loading: "正在加载用户…", empty: "没有符合条件的用户", icon: "🔍" }
    );

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    pageNo = 1;
    load();
  });

  bindActions(box, {
    reset: () => {
      form.reset();
      pageNo = 1;
      load();
    },
    page: (btn) => {
      const p = Number(btn.dataset.p);
      if (!p || !meta || p === meta.page || p < 1 || p > meta.pages) return;
      pageNo = p;
      load();
    },
    toggle: async (btn) => {
      const u = rows.find((x) => x.id === Number(btn.dataset.id));
      if (!u) return;
      const disabling = u.status === "active";
      const ok = await confirmDialog(
        disabling ? "禁用账号" : "启用账号",
        disabling
          ? u.nickname + "（" + (ROLE[u.role] || u.role) + "）将被禁止登录并停止接单，历史订单与资金不受影响。"
          : u.nickname + "（" + (ROLE[u.role] || u.role) + "）将恢复登录与业务权限。",
        disabling ? "确认禁用" : "确认启用",
        disabling
      );
      if (!ok) return;
      let reason = "";
      if (disabling) {
        reason = await promptDialog("禁用原因", "填写禁用原因，将写入操作日志", { textarea: true, confirmText: "提交禁用" });
        if (reason === null) return;
      }
      await busy(btn, async () => {
        await api.post("/api/admin/users/" + u.id + "/toggle", { reason });
        toastOk(disabling ? "账号已禁用" : "账号已启用");
        await load();
      });
    },
  });

  await load();
}

/* ---------------- 教员资质审核 ---------------- */
function auditCard(t) {
  const approved = t.auditStatus === "approved";
  return `
  <div class="pc-card" style="margin-bottom:0">
    <div class="row between mb12">
      <div class="row" style="gap:10px;min-width:0">
        ${avatar(t.nickname, "", "sm")}
        <div style="min-width:0">
          <div class="bold ellipsis">${esc(t.nickname)}</div>
          <div class="tiny faint">${esc(t.phone)} · 注册于 ${fmtDate(t.createdAt, "date")}</div>
        </div>
      </div>
      ${statusBadge(t.auditStatus, AUDIT_STATUS[t.auditStatus] || t.auditStatus)}
    </div>
    ${kv("真实姓名", esc(or(t.realName)))}
    ${kv("身份证（脱敏）", '<span class="mono">' + esc(or(t.idCard)) + "</span>")}
    ${kv("身份类型", esc(IDENTITY[t.identityType] || or(t.identityType)))}
    ${kv("科目 / 学段", esc(or(t.subjects)) + " / " + esc(or(t.stages)))}
    ${kv("课时单价", money(t.hourlyPrice) + ' <span class="faint tiny">/ 课时</span>')}
    ${t.rejectReason ? '<div class="hint danger mt12">驳回原因：' + esc(t.rejectReason) + "</div>" : ""}
    <div class="divider"></div>
    <div class="tiny faint mb8">身份证（正 / 反）${t.idCardVerified ? ' <span class="badge ok">系统已核：人证一致</span>' : ' <span class="badge gray">未做证件识别</span>'}</div>
    <div class="thumbs">
      ${certThumb(t.idCardFrontUrl, "idCardFrontUrl")}
      ${certThumb(t.idCardBackUrl, "idCardBackUrl")}
    </div>
    ${t.idCardName ? '<div class="tiny faint mt8">证件识别姓名：' + esc(t.idCardName) + "（须与填写姓名一致）</div>" : ""}
    <div class="divider"></div>
    <div class="tiny faint mb8">其它证件材料</div>
    <div class="thumbs">
      ${certThumb(t.eduCertUrl, "eduCertUrl")}
      ${certThumb(t.teacherCertUrl, "teacherCertUrl")}
      ${certThumb(t.skillCertUrl, "skillCertUrl")}
    </div>
    <div class="mt12">
      <div class="tiny faint mb8">自我介绍</div>
      <div class="small muted">${esc(or(t.intro, "未填写自我介绍"))}</div>
    </div>
    <div class="divider"></div>
    ${
      approved
        ? '<div class="hint green">该教员资质已通过审核</div>'
        : `<div class="row" style="gap:8px">
             <button class="btn btn-sm btn-primary" data-act="approve" data-id="${t.userId}" data-name="${esc(t.nickname)}">通过审核</button>
             <button class="btn btn-sm btn-danger" data-act="reject" data-id="${t.userId}" data-name="${esc(t.nickname)}">驳回</button>
           </div>`
    }
  </div>`;
}

async function viewAudit(root) {
  const box = paint(root, `
    <div class="pc-card">
      <h3>📝 教员资质审核<span class="more" data-count>—</span></h3>
      <div class="pc-toolbar">
        <div class="segmented" style="max-width:360px" data-filter>
          <button class="on" data-f="pending">待审核</button>
          <button data-f="rejected">已驳回</button>
          <button data-f="all">全部</button>
        </div>
        <span style="flex:1"></span>
        <span class="faint small">材料含身份证脱敏信息，仅用于资质核验</span>
      </div>
      <div data-list></div>
    </div>`);

  const listEl = box.querySelector("[data-list]");
  const countEl = box.querySelector("[data-count]");
  let all = [];
  let filter = "pending";

  const paintList = () => {
    const shown = all.filter((t) => (filter === "all" ? true : t.auditStatus === filter));
    countEl.textContent = "共 " + num(all.length) + " 份材料 · 当前显示 " + num(shown.length) + " 份";
    listEl.innerHTML = shown.length
      ? '<div class="pc-grid c2">' + shown.map(auditCard).join("") + "</div>"
      : emptyHtml(filter === "pending" ? "暂无待审核的教员材料" : "该分类下没有材料", "📝");
  };

  const load = async () => {
    listEl.innerHTML = loadingHtml("正在加载待审材料…");
    try {
      all = (await api.get("/api/admin/teachers/pending")) || [];
      paintList();
    } catch (err) {
      if (err?.status === 401) return handle401();
      listEl.innerHTML = errorHtml(err);
      const b = listEl.querySelector("[data-retry]");
      if (b) b.onclick = load;
    }
  };

  box.querySelectorAll("[data-f]").forEach((b) => {
    b.addEventListener("click", () => {
      filter = b.dataset.f;
      box.querySelectorAll("[data-f]").forEach((x) => x.classList.toggle("on", x === b));
      paintList();
    });
  });

  bindActions(box, {
    photo: (btn) => openPhoto(btn.dataset.src, btn.dataset.label),
    approve: async (btn) => {
      const ok = await confirmDialog(
        "通过资质审核",
        "确认 " + btn.dataset.name + " 的资质材料真实有效？通过后教员可上线接单并参与派单。",
        "通过审核"
      );
      if (!ok) return;
      await busy(btn, async () => {
        await api.post("/api/admin/teachers/" + btn.dataset.id + "/audit", { approve: true });
        toastOk("已通过审核");
        await load();
        await syncPending();
      });
    },
    reject: async (btn) => {
      const reason = await promptDialog(
        "驳回资质审核",
        "填写驳回原因，将通知该教员补充材料（必填）",
        { textarea: true, confirmText: "确认驳回" }
      );
      if (reason === null) return;
      await busy(btn, async () => {
        await api.post("/api/admin/teachers/" + btn.dataset.id + "/audit", { approve: false, reason });
        toastOk("已驳回并通知教员");
        await load();
        await syncPending();
      });
    },
  });

  await load();
}

/* ---------------- 教员等级调整 ---------------- */
async function viewLevels(root) {
  let levels = [];
  try {
    levels = await getLevels();
    await getRegions();
  } catch (err) {
    if (err?.status === 401) return handle401();
  }
  const grpLink = "#/rules?grp=" + encodeURIComponent("教员等级规则");
  const box = paint(root, `
    <div class="pc-card">
      <h3>🏅 等级规则<span class="more">来自规则配置中心 · <a href="${grpLink}">调整抽佣与派单权重 →</a></span></h3>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>等级</th><th>名称</th><th>成长分区间</th><th>平台抽佣</th><th>派单权重</th></tr></thead>
        <tbody>
          ${levels.map((l) => `<tr>
            <td>${levelBadge(l.level)}</td>
            <td>${esc(l.name)}</td>
            <td class="num">${num(l.min)} – ${num(l.max)}</td>
            <td>${pct(l.commission)}</td>
            <td>${l.weight}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>
      <div class="hint mt12">人工调整会把成长分重置为目标等级下限，写入等级变更日志并通知教员；等级决定抽佣比例与派单优先级。</div>
    </div>
    <div class="pc-card">
      <h3>👩‍🏫 教员列表<span class="more" data-count>—</span></h3>
      <div class="pc-toolbar">
        <input class="input" data-kw placeholder="搜索昵称 / 手机号" style="min-width:240px">
        <span class="faint small">共 <span data-total>0</span> 位教员</span>
      </div>
      <div data-list></div>
    </div>`);

  const listEl = box.querySelector("[data-list]");
  const countEl = box.querySelector("[data-count]");
  const kwEl = box.querySelector("[data-kw]");
  const totalEl = box.querySelector("[data-total]");
  let rows = [];

  const paintList = () => {
    const kw = kwEl.value.trim();
    const shown = rows.filter(
      (u) => !kw || String(u.nickname || "").includes(kw) || String(u.phone || "").includes(kw)
    );
    countEl.textContent = "显示 " + num(shown.length) + " / " + num(rows.length) + " 位";
    listEl.innerHTML = shown.length
      ? tableHtml(
          ["教员", "手机号", "当前等级", "成长分", "评分", "审核状态", "调整为"],
          shown.map((u) => {
            const t = u.teacher || {};
            return [
              '<div class="bold">' + esc(u.nickname) + "</div>" +
                '<div class="tiny faint">' + esc(regionName(u.regionId)) + "</div>",
              '<span class="mono">' + esc(u.phone || "—") + "</span>",
              levelBadge(t.level || "Lv1"),
              '<span class="num">' + num(t.growthScore) + "</span>",
              '<span class="num">★ ' + Number(t.ratingAvg || 0).toFixed(1) + "</span>",
              statusBadge(t.auditStatus, AUDIT_STATUS[t.auditStatus] || t.auditStatus || "未入驻"),
              '<div class="row" style="gap:6px">' +
                '<select class="select" data-sel style="width:158px;height:30px;padding:2px 26px 2px 8px;font-size:12px">' +
                levels.map((l) =>
                  '<option value="' + esc(l.level) + '"' + (l.level === t.level ? " selected" : "") + ">" +
                  esc(l.level) + " · " + esc(l.name) + "（抽佣 " + pct(l.commission) + "）</option>"
                ).join("") +
                "</select>" +
                '<button class="btn btn-xs btn-primary" data-act="level" data-id="' + u.id + '" data-name="' + esc(u.nickname) +
                '" data-level="' + esc(t.level || "Lv1") + '">调整</button>' +
              "</div>",
            ];
          })
        )
      : emptyHtml("没有匹配的教员", "🔍");
  };

  const load = async () => {
    listEl.innerHTML = loadingHtml("正在加载教员…");
    try {
      const r = await api.get("/api/admin/users", { role: "teacher" });
      rows = (r.list || []).filter((u) => u.teacher);
      totalEl.textContent = num(rows.length);
      paintList();
    } catch (err) {
      if (err?.status === 401) return handle401();
      listEl.innerHTML = errorHtml(err);
      const b = listEl.querySelector("[data-retry]");
      if (b) b.onclick = load;
    }
  };

  kwEl.addEventListener("input", paintList);

  bindActions(box, {
    level: async (btn) => {
      const tr = btn.closest("tr");
      const sel = tr.querySelector("[data-sel]");
      const level = sel.value;
      const cur = btn.dataset.level;
      if (level === cur) return toastErr("请选择与当前不同的等级");
      const note = await promptDialog("调整等级备注", "填写调整原因，将写入等级变更日志", {
        value: "平台人工调整",
        textarea: false,
        confirmText: "下一步",
      });
      if (note === null) return;
      const ok = await confirmDialog(
        "确认调整等级",
        btn.dataset.name + "：" + cur + " → " + level + "。成长分将重置为 " + level + " 的分数下限，并通知该教员。",
        "确认调整"
      );
      if (!ok) return;
      await busy(btn, async () => {
        await api.post("/api/admin/teachers/" + btn.dataset.id + "/level", { level, note });
        toastOk("等级已调整为 " + level);
        await load();
      });
    },
  });

  await load();
}

/* ---------------- 区域与代理 ---------------- */
async function viewAgents(root) {
  let regions = [];
  let agents = [];
  const box = paint(root, `
    <div class="pc-grid c2">
      <div class="pc-card" style="margin-bottom:0">
        <h3>🗺️ 片区与电子围栏<span class="more" data-region-count>—</span></h3>
        <div data-regions></div>
      </div>
      <div class="pc-card" style="margin-bottom:0">
        <h3>＋ 新建片区</h3>
        <form data-region-form autocomplete="off">
          <div class="form-grid">
            <div class="field"><label>片区名称 <span class="req">*</span></label><input class="input" name="name" placeholder="如 西湖区"></div>
            <div class="field"><label>片区编码</label><input class="input" name="code" placeholder="留空自动生成"></div>
            <div class="field"><label>中心纬度 <span class="req">*</span></label><input class="input" name="centerLat" type="number" step="0.0001" placeholder="30.2741"></div>
            <div class="field"><label>中心经度 <span class="req">*</span></label><input class="input" name="centerLng" type="number" step="0.0001" placeholder="120.1551"></div>
            <div class="field"><label>服务半径（km）</label><input class="input" name="radiusKm" type="number" step="0.5" value="6"></div>
            <div class="field"><label>围栏 JSON</label>
              <div class="row" style="gap:6px">
                <input class="input grow" name="polygon" placeholder="[[lat,lng],…]">
                <button class="btn btn-xs btn-outline" type="button" data-act="genpoly">按中心生成</button>
              </div>
            </div>
          </div>
          <div class="hint muted mt12">围栏（polygon）优先于半径匹配用于片区归属判定；留空则仅按中心点 + 半径归片。</div>
          <div class="row mt12"><button class="btn btn-sm btn-primary" type="submit">创建片区</button></div>
        </form>
      </div>
    </div>
    <div class="pc-card mt16">
      <h3>🤝 区域代理<span class="more" data-agent-count>—</span></h3>
      <div data-agents></div>
    </div>
    <div class="pc-card">
      <h3>＋ 签约新代理</h3>
      <form data-agent-form autocomplete="off">
        <div class="form-grid">
          <div class="field"><label>姓名 <span class="req">*</span></label><input class="input" name="nickname" placeholder="代理联系人姓名"></div>
          <div class="field"><label>手机号 <span class="req">*</span></label><input class="input" name="phone" inputmode="numeric" maxlength="11" placeholder="11 位手机号"></div>
          <div class="field"><label>代理片区 <span class="req">*</span></label><select class="select" name="regionId" data-region-select></select></div>
          <div class="field"><label>代理等级</label><select class="select" name="level"><option value="A">A 级</option><option value="B">B 级</option><option value="C">C 级</option></select></div>
          <div class="field"><label>保证金（元）</label><input class="input" name="deposit" type="number" min="0" step="100" value="0"></div>
          <div class="field"><label>服务费分成（%）</label><input class="input" name="commissionRate" type="number" min="0" max="100" step="1" value="25"></div>
          <div class="field"><label>管理提成（%）</label><input class="input" name="mgmtRate" type="number" min="0" max="100" step="0.5" value="1"></div>
        </div>
        <div class="hint muted mt12">分成比例按订单服务费计提，管理提成按实付金额计提；初始口令由系统生成，创建后一次性展示。</div>
        <div class="row mt12"><button class="btn btn-sm btn-primary" type="submit">签约代理</button></div>
        <div data-agent-result class="mt12"></div>
      </form>
    </div>`);

  const regionEl = box.querySelector("[data-regions]");
  const agentEl = box.querySelector("[data-agents]");
  const regionCount = box.querySelector("[data-region-count]");
  const agentCount = box.querySelector("[data-agent-count]");
  const regionForm = box.querySelector("[data-region-form]");
  const agentForm = box.querySelector("[data-agent-form]");
  const resultEl = box.querySelector("[data-agent-result]");

  const polygonPoints = (raw) => {
    try {
      const arr = JSON.parse(raw || "[]");
      return Array.isArray(arr) ? arr.length : 0;
    } catch {
      return 0;
    }
  };

  const loadRegions = async () => {
    try {
      regions = await getRegions(true);
      regionCount.textContent = "共 " + num(regions.length) + " 个片区";
      regionEl.innerHTML = regions.length
        ? tableHtml(
            ["名称", "编码", "中心坐标", "半径", "围栏"],
            regions.map((r) => [
              "<b>" + esc(r.name) + "</b>",
              '<span class="mono">' + esc(r.code) + "</span>",
              '<span class="mono">' + r.center_lat + ", " + r.center_lng + "</span>",
              '<span class="num">' + r.radius_km + " km</span>",
              polygonPoints(r.polygon)
                ? '<span class="badge green">' + polygonPoints(r.polygon) + " 点</span>"
                : '<span class="badge gray">未设置</span>',
            ])
          )
        : emptyHtml("暂无片区，请先创建", "🗺️");
    } catch (err) {
      if (err?.status === 401) return handle401();
      regionEl.innerHTML = errorHtml(err);
      const b = regionEl.querySelector("[data-retry]");
      if (b) b.onclick = loadRegions;
    }
  };

  const loadAgents = async () => {
    agentEl.innerHTML = loadingHtml("正在加载代理…");
    try {
      agents = (await api.get("/api/admin/agents")) || [];
      agentCount.textContent = "共 " + num(agents.length) + " 位代理";
      agentEl.innerHTML = agents.length
        ? tableHtml(
            ["姓名", "手机号", "片区", "等级", "签约时间", "保证金", "服务费分成", "管理提成", "业务员", "累计分成", "状态", "操作"],
            agents.map((a) => [
              "<b>" + esc(a.nickname) + "</b>",
              '<span class="mono">' + esc(a.phone) + "</span>",
              esc(a.regionName || "—"),
              '<span class="badge gray">' + esc(a.level) + "</span>",
              '<span class="small nowrap">' + fmtDate(a.signed_at, "date") + "</span>",
              '<span class="num">' + money(a.deposit || 0) + "</span>",
              '<span class="num">' + pct(a.commission_rate) + "</span>",
              '<span class="num">' + pct(a.mgmt_rate) + "</span>",
              '<span class="num">' + num(a.salesCount) + " 人</span>",
              '<span class="num bold">' + money(a.totalShare || 0) + "</span>",
              statusBadge(a.userStatus, a.userStatus === "active" ? "正常" : "已禁用"),
              '<div class="row" style="gap:6px;flex-wrap:nowrap">' +
                '<button class="btn btn-xs btn-outline" data-act="agent-detail" data-id="' + a.user_id + '">详情</button>' +
                '<button class="btn btn-xs btn-outline" data-act="agent-edit" data-id="' + a.user_id + '">编辑</button>' +
                '<button class="btn btn-xs btn-ghost" data-act="agent-deposit" data-id="' + a.user_id + '">保证金</button>' +
                '<button class="btn btn-xs ' + (a.userStatus === "active" ? "btn-danger" : "btn-ghost") + '" data-act="agent-toggle" data-id="' + a.user_id + '">' +
                  (a.userStatus === "active" ? "禁用" : "启用") + "</button>" +
              "</div>",
            ])
          )
        : emptyHtml("暂无签约代理", "🤝");
    } catch (err) {
      if (err?.status === 401) return handle401();
      agentEl.innerHTML = errorHtml(err);
      const b = agentEl.querySelector("[data-retry]");
      if (b) b.onclick = loadAgents;
    }
  };

  regionForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = regionForm.querySelector('button[type="submit"]');
    const f = regionForm.elements;
    const body = {
      name: f.name.value.trim(),
      code: f.code.value.trim(),
      centerLat: f.centerLat.value,
      centerLng: f.centerLng.value,
      radiusKm: f.radiusKm.value,
    };
    if (!body.name) return toastErr("请填写片区名称");
    if (body.centerLat === "" || body.centerLng === "") return toastErr("请填写中心坐标");
    const rawPoly = f.polygon.value.trim();
    if (rawPoly) {
      try {
        const parsed = JSON.parse(rawPoly);
        if (!Array.isArray(parsed) || parsed.length < 3) return toastErr("围栏至少需要 3 个坐标点");
        body.polygon = parsed;
      } catch {
        return toastErr("围栏 JSON 格式不正确，例如 [[30.28,120.15],[30.28,120.16],…]");
      }
    }
    await busy(btn, async () => {
      await api.post("/api/admin/regions", body);
      toastOk("片区已创建：" + body.name);
      regionForm.reset();
      regionForm.radiusKm.value = "6";
      await loadRegions();
    });
  });

  agentForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = agentForm.querySelector('button[type="submit"]');
    const body = {
      nickname: agentForm.nickname.value.trim(),
      phone: agentForm.phone.value.trim(),
      regionId: agentForm.regionId.value,
      level: agentForm.level.value,
      deposit: cents(agentForm.deposit.value),
      commissionRate: Number(agentForm.commissionRate.value || 0) / 100,
      mgmtRate: Number(agentForm.mgmtRate.value || 0) / 100,
    };
    if (!body.nickname) return toastErr("请填写代理姓名");
    if (!/^1\d{10}$/.test(body.phone)) return toastErr("请输入正确的 11 位手机号");
    if (!body.regionId) return toastErr("请选择代理片区");
    await busy(btn, async () => {
      const d = await api.post("/api/admin/agents", body);
      resultEl.innerHTML =
        '<div class="hint green">代理「' + esc(body.nickname) + '」创建成功，初始登录口令：<b class="mono">' +
        esc(d.initialPassword || "—") + "</b>（请当面转交并提示首次登录后修改）</div>";
      toastOk("代理已签约，初始口令 " + (d.initialPassword || ""));
      agentForm.reset();
      agentForm.commissionRate.value = "25";
      agentForm.mgmtRate.value = "1";
      await loadAgents();
    });
  });

  bindActions(box, {
    genpoly: (btn) => {
      const lat = Number(regionForm.centerLat.value);
      const lng = Number(regionForm.centerLng.value);
      const r = Number(regionForm.radiusKm.value || 6);
      if (!lat || !lng) return toastErr("请先填写中心经纬度");
      if (!(r > 0)) return toastErr("请填写有效的服务半径");
      const dLat = r / 111.32;
      const dLng = r / (111.32 * Math.cos((lat * Math.PI) / 180));
      const poly = [
        [lat - dLat, lng - dLng],
        [lat - dLat, lng + dLng],
        [lat + dLat, lng + dLng],
        [lat + dLat, lng - dLng],
      ].map((p) => p.map((v) => Number(v.toFixed(5))));
      regionForm.polygon.value = JSON.stringify(poly);
      toastOk("已按中心点 + 半径生成 4 点矩形围栏");
    },

    "agent-detail": async (btn) => {
      await busy(btn, async () => {
        const d = await api.get("/api/admin/agents/" + btn.dataset.id);
        const as = d.assessment;
        const bars =
          '<div class="mt12">' +
          [["本月 GMV", as.gmvRate, money(as.monthGmv) + " / " + money(as.targets.monthly_gmv_target)],
           ["本月订单", as.orderRate, num(as.monthOrders) + " / " + num(as.targets.monthly_orders_target)],
           ["活跃业务员", as.salesRate, num(as.salesCount) + " / " + num(as.targets.active_sales_target)]]
            .map(([label, rate, txt]) =>
              '<div style="margin-bottom:10px"><div class="row between small"><span>' + label +
              '</span><span class="bold">' + txt + ' · ' + rate + "%</span></div>" +
              '<div class="progress" style="margin-top:4px"><i style="width:' + Math.min(100, rate) + '%"></i></div></div>')
            .join("") +
          "</div>";
        const deposits = d.deposits.length
          ? tableHtml(
              ["方向", "金额", "余额", "备注", "时间"],
              d.deposits.map((x) => [
                x.direction === "in" ? '<span class="badge green">缴纳</span>' : '<span class="badge gold">退还</span>',
                '<span class="num">' + money(x.amount) + "</span>",
                '<span class="num bold">' + money(x.balance) + "</span>",
                esc(or(x.remark)),
                '<span class="small faint">' + fmtDate(x.created_at, "time") + "</span>",
              ])
            )
          : '<div class="small faint">暂无保证金变动记录</div>';
        sheet(
          "代理详情 · " + d.agent.nickname,
          kv("手机号", esc(d.agent.phone)) +
            kv("片区", esc(regionName(d.agent.regionId))) +
            kv("等级 / 保证金", esc(d.agent.level) + " · " + money(d.agent.deposit)) +
            kv("服务费分成 / 管理提成", pct(d.agent.commissionRate) + " / " + pct(d.agent.mgmtRate)) +
            kv("签约时间", fmtDate(d.agent.signedAt, "date")) +
            '<div class="divider"></div><div class="small bold">考核完成度</div>' + bars +
            '<div class="divider"></div><div class="small bold mb8">保证金台账</div>' + deposits
        );
      });
    },

    "agent-edit": async (btn) => {
      const a = agents.find((x) => String(x.user_id) === String(btn.dataset.id));
      if (!a) return toastErr("代理不存在");
      const v = await formDialog("编辑代理 · " + a.nickname, [
        { key: "regionId", label: "所属片区", type: "select", value: a.region_id,
          options: regions.map((r) => ({ value: r.id, label: r.name })) },
        { key: "level", label: "代理等级", type: "select", value: a.level,
          options: [{ value: "S", label: "S 级" }, { value: "A", label: "A 级" }, { value: "B", label: "B 级" }, { value: "C", label: "C 级" }] },
        { key: "commissionRate", label: "服务费分成比例（0~1）", type: "number", value: a.commission_rate },
        { key: "mgmtRate", label: "管理提成比例（0~1）", type: "number", value: a.mgmt_rate },
      ]);
      if (!v) return;
      await busy(btn, async () => {
        await api.put("/api/admin/agents/" + btn.dataset.id, {
          regionId: Number(v.regionId), level: v.level,
          commissionRate: Number(v.commissionRate), mgmtRate: Number(v.mgmtRate),
        });
        toastOk("代理信息已更新");
        await Promise.all([loadAgents(), loadRegions()]);
      });
    },

    "agent-toggle": async (btn) => {
      const a = agents.find((x) => String(x.user_id) === String(btn.dataset.id));
      const off = a && a.userStatus === "active";
      const ok = await confirmDialog(
        off ? "禁用代理账号" : "启用代理账号",
        off
          ? "禁用后该代理将无法登录代理端，其名下业务员也会失去归属。确定继续？"
          : "启用后该代理可重新登录代理端并查看片区数据。",
        off ? "禁用" : "启用", off
      );
      if (!ok) return;
      await busy(btn, async () => {
        const r = await api.post("/api/admin/agents/" + btn.dataset.id + "/toggle", {});
        toastOk(r.status === "active" ? "代理已启用" : "代理已禁用");
        await loadAgents();
      });
    },

    "agent-deposit": async (btn) => {
      const a = agents.find((x) => String(x.user_id) === String(btn.dataset.id));
      const v = await formDialog("保证金变动 · " + (a ? a.nickname : ""), [
        { key: "direction", label: "方向", type: "select", value: "in",
          options: [{ value: "in", label: "缴纳（增加保证金）" }, { value: "out", label: "退还（减少保证金）" }] },
        { key: "amount", label: "金额（元）", type: "number", value: 1000 },
        { key: "remark", label: "备注", value: "", placeholder: "如：季度保证金补缴 / 退场结算" },
      ], "提交");
      if (!v) return;
      await busy(btn, async () => {
        await api.post("/api/admin/agents/" + btn.dataset.id + "/deposit", {
          direction: v.direction,
          amount: cents(v.amount),
          remark: v.remark || (v.direction === "in" ? "缴纳保证金" : "退还保证金"),
        });
        toastOk(v.direction === "in" ? "保证金已入账" : "保证金已退还");
        await loadAgents();
      });
    },
  });

  await Promise.all([loadRegions(), loadAgents()]);
}


/* ============================================================
   交易组：订单与需求 / 退款工单
   ============================================================ */

const DEMAND_STATUS = { published: "发布中", paused: "已暂停", revoked: "已撤销", matched: "已匹配", closed: "已关闭" };

function orderDetailHtml(o) {
  const credit = o.parent?.credit;
  return (
    '<div class="row between mb12"><div class="mono bold">' + esc(o.orderNo) + "</div>" + orderStatusBadge(o.status) + "</div>" +
    kv("科目 / 学段", esc(o.subject) + " · " + esc(o.stage)) +
    kv("上课时间", fmtDate(o.lessonTime, "time")) +
    kv("上课地址", esc(or(o.address))) +
    kv("家长", esc(o.parent?.nickname || "—") + ' <span class="faint tiny">' + esc(o.parent?.phone || "") + "</span>") +
    kv("教员", esc(o.teacher?.nickname || "—") + ' <span class="faint tiny">' + esc(o.teacher?.phone || "") + "</span>") +
    kv("家长信用", credit ? num(credit.creditScore) + " 分 · " + esc(credit.creditLevel) + "（评价权重 " + credit.reviewWeight + "）" : "—") +
    '<div class="divider"></div>' +
    kv("实付金额", '<b class="money">' + money(o.amount + (o.urgentFee || 0)) + "</b>") +
    kv("加急费", money(o.urgentFee || 0)) +
    kv("平台服务费", money(o.serviceFee) + ' <span class="faint tiny">抽佣 ' + pct(o.commissionRate) + "</span>") +
    kv("教员实收", money(o.teacherIncome)) +
    kv("代理分成", money(o.agentShare)) +
    '<div class="divider"></div>' +
    kv("支付时间", fmtDate(o.paidAt, "time")) +
    kv("打卡时间", fmtDate(o.checkinAt, "time") + (o.checkinDistance != null ? ' <span class="faint tiny">距地址 ' + Math.round(o.checkinDistance) + " m</span>" : "")) +
    kv("家长确认", fmtDate(o.confirmAt, "time")) +
    kv("结算时间", fmtDate(o.settleAt, "time")) +
    (o.cancelReason ? kv("取消 / 退款原因", esc(o.cancelReason)) : "") +
    (o.refundAmount ? kv("退款金额", money(o.refundAmount)) : "") +
    (o.remark ? '<div class="hint muted mt12">' + esc(o.remark) + "</div>" : "") +
    ((o.payments || []).length
      ? '<div class="divider"></div><div class="tiny faint mb8">支付 / 退款流水</div>' +
        tableHtml(
          ["类型", "金额", "渠道", "交易号", "时间"],
          o.payments.map((p) => [
            PAY_TYPE[p.type] || p.type,
            '<span class="num">' + money(p.amount) + "</span>",
            esc(CHANNEL[p.channel] || p.channel),
            '<span class="mono">' + esc(p.trade_no) + "</span>",
            '<span class="small nowrap">' + fmtDate(p.created_at, "time") + "</span>",
          ])
        )
      : "")
  );
}

async function openOrderSheet(id) {
  const s = sheet("订单详情", loadingHtml("正在加载订单…"), [
    { label: "关闭", class: "btn-outline", onClick: () => {} },
  ]);
  const body = s.el.querySelector(".sheet-body");
  try {
    const o = await api.get("/api/orders/" + id);
    body.innerHTML = orderDetailHtml(o);
  } catch (err) {
    if (err?.status === 401) return handle401();
    body.innerHTML = errorHtml(err);
  }
}

async function viewOrders(root) {
  try {
    await Promise.all([getRegions(), getLevels()]);
  } catch (err) {
    if (err?.status === 401) return handle401();
  }
  const box = paint(root, `
    <div class="pc-card">
      <h3>🧾 订单与需求管理<span class="more" data-count>—</span></h3>
      <div class="tabs" data-tabs>
        <button class="on" data-t="orders">订单管理</button>
        <button data-t="demands">需求池</button>
      </div>
      <div data-pane="orders">
        <form class="pc-toolbar" data-filter autocomplete="off">
          <select class="select" name="status">
            <option value="">全部状态</option>
            ${Object.keys(ORDER_STATUS).map((k) => `<option value="${k}">${ORDER_STATUS[k]}</option>`).join("")}
          </select>
          <select class="select" name="regionId">
            <option value="">全部片区</option>
            ${(state.regions || []).map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}
          </select>
          <input class="input" name="keyword" placeholder="订单号关键字" style="min-width:200px">
          <button class="btn btn-sm btn-primary" type="submit">查询</button>
          <button class="btn btn-sm btn-outline" type="button" data-act="reset">重置</button>
          <button class="btn btn-sm btn-outline" type="button" data-act="export-orders">⬇️ 导出订单</button>
        </form>
        <div data-orders></div>
      </div>
      <div data-pane="demands" hidden>
        <div class="pc-toolbar">
          <span class="faint small">展示最近 200 条家长需求（仅上门模式）</span>
          <button class="btn btn-sm btn-outline" type="button" data-act="expire-apps" style="margin-left:auto">清理超时报名</button>
        </div>
        <div data-demands></div>
      </div>
    </div>`);

  const orderEl = box.querySelector("[data-orders]");
  const demandEl = box.querySelector("[data-demands]");
  const countEl = box.querySelector("[data-count]");
  const form = box.querySelector("[data-filter]");
  let rows = [];
  let orderPage = 1;
  let orderMeta = null;

  const orderTable = (list) =>
    tableHtml(
      ["订单号", "科目 / 学段", "授课方式", "家长", "教员", "实付", "平台服务费", "教员实收", "状态", "下单时间", "操作"],
      list.map((o) => [
        '<span class="mono">' + esc(o.orderNo) + "</span>",
        "<b>" + esc(o.subject) + "</b> · " + esc(o.stage),
        '<span class="tiny">' + esc(o.placeText || "教员上门") + "</span>",
        esc(o.parent?.nickname || "—"),
        esc(o.teacher?.nickname || "—") + (o.teacher ? '<div class="tiny faint">' + levelBadge(o.teacher.level) + "</div>" : ""),
        '<span class="num bold">' + money(o.amount) + "</span>",
        '<span class="num">' + money(o.serviceFee) + "</span>",
        '<span class="num">' + money(o.teacherIncome) + "</span>",
        orderStatusBadge(o.status),
        '<span class="small faint nowrap">' + fmtDate(o.createdAt, "time") + "</span>",
        '<div class="row" style="gap:6px">' +
          '<button class="btn btn-xs btn-outline" data-act="detail" data-id="' + o.id + '">详情</button>' +
          '<button class="btn btn-xs btn-outline" data-act="price" data-id="' + o.id + '" data-amount="' + o.amount +
          '" data-no="' + esc(o.orderNo) + '"' + (o.paidAt ? ' disabled title="已支付订单不可改价，请走退款流程"' : "") + ">改价</button>" +
          '<button class="btn btn-xs btn-danger" data-act="close" data-id="' + o.id + '" data-no="' + esc(o.orderNo) + '"' +
          (["settled", "refunded", "cancelled"].includes(o.status) ? ' disabled title="订单已终结"' : "") + ">关闭</button>" +
        "</div>",
      ])
    );

  const loadOrders = () =>
    loadData(
      orderEl,
      async () => {
        const r = await api.get("/api/admin/orders", {
          status: form.status.value,
          regionId: form.regionId.value,
          keyword: form.keyword.value.trim(),
          page: orderPage,
          pageSize: PAGE_SIZE,
        });
        rows = r.list || [];
        orderMeta = { page: r.page, pages: r.pages, total: r.total, pageSize: r.pageSize };
        countEl.textContent = "共 " + num(r.total) + " 笔订单 · 第 " + r.page + "/" + r.pages + " 页";
        return orderTable(rows) + pagerHtml(orderMeta);
      },
      { loading: "正在加载订单…", empty: "没有符合条件的订单", icon: "🧾" }
    );

  const loadDemands = () =>
    loadData(
      demandEl,
      async () => {
        const list = (await api.get("/api/admin/demands", { page: 1, pageSize: 200 })).list || [];
        return tableHtml(
          ["学段 / 科目", "课时预算", "片区", "家长", "加急", "状态", "发布时间"],
          list.map((d) => [
            "<b>" + esc(d.stage) + "</b> · " + esc(d.subject),
            '<span class="num bold">' + money(d.budget) + "</span>",
            esc(regionName(d.region_id)),
            esc(d.parentName || "—"),
            d.urgent ? '<span class="badge gold">加急 ' + money(d.urgent_fee) + "</span>" : '<span class="faint">—</span>',
            statusBadge(d.status, DEMAND_STATUS[d.status] || d.status),
            '<span class="small faint nowrap">' + fmtDate(d.created_at, "time") + "</span>",
          ])
        );
      },
      { loading: "正在加载需求池…", empty: "暂无需求", icon: "📋" }
    );

  box.querySelectorAll("[data-t]").forEach((b) => {
    b.addEventListener("click", () => {
      box.querySelectorAll("[data-t]").forEach((x) => x.classList.toggle("on", x === b));
      const isOrders = b.dataset.t === "orders";
      box.querySelector('[data-pane="orders"]').hidden = !isOrders;
      box.querySelector('[data-pane="demands"]').hidden = isOrders;
      if (isOrders) loadOrders();
      else loadDemands();
    });
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    orderPage = 1;
    loadOrders();
  });

  bindActions(box, {
    reset: () => {
      form.reset();
      orderPage = 1;
      loadOrders();
    },
    page: (btn) => {
      const p = Number(btn.dataset.p);
      if (!p || !orderMeta || p === orderMeta.page || p < 1 || p > orderMeta.pages) return;
      orderPage = p;
      loadOrders();
    },
    "export-orders": async (btn) => {
      await busy(btn, async () => {
        const f = form.elements;
        const q = new URLSearchParams();
        if (f.status.value) q.set("status", f.status.value);
        if (f.regionId.value) q.set("regionId", f.regionId.value);
        if (f.keyword.value.trim()) q.set("keyword", f.keyword.value.trim());
        const res = await fetch("/api/admin/orders/export?" + q.toString(), {
          headers: { Authorization: "Bearer " + session.token },
        });
        if (res.status === 401) return handle401();
        if (!res.ok) throw new Error("导出失败（HTTP " + res.status + "）");
        const text = await res.text();
        const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "platform-orders-" + new Date().toISOString().slice(0, 10) + ".csv";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1200);
        toastOk("订单报表已导出（含分账明细）");
      });
    },
    "expire-apps": async (btn) => {
      await busy(btn, async () => {
        const r = await api.post("/api/admin/applications/expire", {});
        toastOk(
          r.expired > 0
            ? "已清理 " + r.expired + " 条超时未确认的报名（超时阈值 " + r.timeoutHours + " 小时）"
            : "当前没有超过 " + r.timeoutHours + " 小时未确认的报名"
        );
        await loadDemands();
      });
    },
    detail: (btn) => openOrderSheet(btn.dataset.id),
    price: async (btn) => {
      const val = await promptDialog("人工改价", "输入新的订单实付金额（元）", {
        value: (Number(btn.dataset.amount) / 100).toFixed(2),
        textarea: false,
        confirmText: "下一步",
      });
      if (val === null) return;
      const amount = cents(val);
      if (!(amount > 0)) return toastErr("金额需大于 0");
      const ok = await confirmDialog(
        "确认改价",
        "订单 " + btn.dataset.no + "：" + money(Number(btn.dataset.amount)) + " → " + money(amount) + "。改价会被记入订单备注与操作日志。",
        "确认改价"
      );
      if (!ok) return;
      await busy(btn, async () => {
        await api.post("/api/admin/orders/" + btn.dataset.id + "/price", { amount, note: "后台人工改价" });
        toastOk("改价成功");
        await loadOrders();
      });
    },
    close: async (btn) => {
      const ok = await confirmDialog(
        "关闭订单",
        "订单 " + btn.dataset.no + " 将被置为「已取消」，学员与教员都会收到通知，且不可恢复。",
        "关闭订单",
        true
      );
      if (!ok) return;
      const reason = await promptDialog("关闭原因", "填写关闭原因（将通知家长与教员）", {
        value: "平台关闭",
        textarea: true,
        confirmText: "确认关闭",
      });
      if (reason === null) return;
      await busy(btn, async () => {
        await api.post("/api/admin/orders/" + btn.dataset.id + "/close", { reason });
        toastOk("订单已关闭");
        await loadOrders();
        await syncPending();
      });
    },
  });

  await loadOrders();
}

/* ---------------- 退款工单 ---------------- */
async function viewRefunds(root) {
  const box = paint(root, `
    <div class="pc-card">
      <h3>↩️ 退款工单<span class="more" data-count>—</span></h3>
      <div class="hint">退款审核通过后按订单实付金额原路退回并写入担保台账与支付流水；驳回会恢复订单为「待上课」并通知家长。</div>
      <div class="mt12" data-list></div>
    </div>`);
  const listEl = box.querySelector("[data-list]");
  const countEl = box.querySelector("[data-count]");
  let rows = [];

  const load = () =>
    loadData(
      listEl,
      async () => {
        rows = (await api.get("/api/admin/refunds")) || [];
        countEl.textContent = rows.filter((o) => o.status === "refunding").length + " 笔待处理 / 共 " + rows.length + " 笔";
        return tableHtml(
          ["订单号", "家长", "教员", "实付金额", "退款状态", "退款原因", "申请时间", "操作"],
          rows.map((o) => {
            const pending = o.status === "refunding";
            const refundable = o.refundAmount || o.amount + (o.urgentFee || 0);
            return [
              '<span class="mono">' + esc(o.orderNo) + "</span>",
              esc(o.parent?.nickname || "—"),
              esc(o.teacher?.nickname || "—"),
              '<span class="num bold">' + money(o.amount + (o.urgentFee || 0)) + "</span>",
              orderStatusBadge(o.status),
              '<span class="small">' + esc(or(o.cancelReason, "—")) + "</span>",
              '<span class="small faint nowrap">' + fmtDate(o.createdAt, "time") + "</span>",
              pending
                ? '<div class="row" style="gap:6px">' +
                  '<button class="btn btn-xs btn-primary" data-act="approve" data-id="' + o.id + '" data-no="' + esc(o.orderNo) + '" data-amount="' + refundable + '">同意退款</button>' +
                  '<button class="btn btn-xs btn-danger" data-act="reject" data-id="' + o.id + '" data-no="' + esc(o.orderNo) + '">驳回</button>' +
                  "</div>"
                : '<span class="faint small">已处理</span>',
            ];
          })
        );
      },
      { loading: "正在加载退款工单…", empty: "暂无退款工单", icon: "↩️" }
    );

  bindActions(box, {
    approve: async (btn) => {
      const ok = await confirmDialog(
        "同意退款",
        "订单 " + btn.dataset.no + " 将原路退回 " + money(Number(btn.dataset.amount)) + "，并同步写入担保台账与支付流水。",
        "同意退款",
        true
      );
      if (!ok) return;
      await busy(btn, async () => {
        await api.post("/api/admin/refunds/" + btn.dataset.id + "/review", { approve: true });
        toastOk("退款已通过");
        await load();
        await syncPending();
      });
    },
    reject: async (btn) => {
      const reason = await promptDialog("驳回退款", "填写驳回理由，将通知家长（必填）", {
        textarea: true,
        confirmText: "确认驳回",
      });
      if (reason === null) return;
      await busy(btn, async () => {
        await api.post("/api/admin/refunds/" + btn.dataset.id + "/review", { approve: false, reason });
        toastOk("已驳回退款申请");
        await load();
        await syncPending();
      });
    },
  });

  await load();
}

/* ============================================================
   规则组：规则配置中心（结构化表单 + 热更新）
   ============================================================ */

const RULE_LABELS = {
  max_radius_km: "最大推送半径（km）", push_batch: "单批推送人数", grab_confirm_timeout_hours: "抢单确认超时（小时）",
  distance_factor_min: "距离系数下限", urgent_boost: "加急加权倍数",
  level: "等级标识", name: "名称", min: "下限", max: "上限",
  commission: "平台抽佣比例", weight: "权重",
  order_completed: "完成订单加分", review_given: "主动评价加分", monthly_no_cancel: "月度无取消加分",
  cancel_within_4h: "课前 4 小时取消扣分", no_show: "爽约扣分", malicious_review: "恶意差评扣分", restrict_below: "限制名单阈值",
  per_lesson: "每课时成长分", good_review_base: "好评基础分", bad_review_base: "差评基础分",
  violation: "违规扣分项", private_deal_ban: "引导私单自动封禁",
  lesson_points: "每课时计分", good_base: "好评基数", bad_base: "差评基数", good_threshold: "好评星级阈值",
  bad_threshold: "差评星级阈值", window_hours: "评价时限（小时）",
  positive_tags: "好评标签", negative_tags: "差评标签",
  register: "注册奖（分）", lead: "留资奖（分）", newbie_first: "新人首单奖（分）",
  daily_champ: "日冠军奖（分）", weekly_champ: "周冠军奖（分）",
  deal_tiers: "成交阶梯提成", settle_period: "结算周期", rate: "提成比例",
  fee_share_rate: "服务费分成比例", mgmt_rate: "管理提成比例", bill_day: "月度账单日（日）",
  freeze_days: "冻结天数（T+N）", min_withdraw: "最低提现金额（分）", withdraw_fee_rate: "提现手续费率",
  free_cancel_hours: "免费取消时限（小时）", cancel_penalty_rate: "取消违约金比例",
  max_distance_m: "打卡距离阈值（米）",
  fee: "加急费（分）", enabled: "启用加急",
  high_cancel_count: "高频取消次数阈值", brush_same_device: "同设备刷单阈值", checkin_fail_block: "打卡失败拦截下单",
  city: "运营城市", compliance_notice: "合规提示", service_fee_note: "服务费说明",
};
const labelOf = (k) => RULE_LABELS[k] || k;

function pathTokens(path) {
  return (path.match(/[^.[\]]+/g) || []).map((t) => (/^\d+$/.test(t) ? Number(t) : t));
}
function getPath(root, path) {
  return pathTokens(path).reduce((acc, t) => (acc == null ? acc : acc[t]), root);
}
function setPath(root, path, value) {
  const tokens = pathTokens(path);
  if (!tokens.length) return;
  let cur = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return;
    cur = cur[tokens[i]];
  }
  if (cur == null || typeof cur !== "object") return;
  cur[tokens[tokens.length - 1]] = value;
}

function primitiveField(path, value, label) {
  const t = typeof value;
  if (t === "boolean") {
    return (
      '<div class="field inline"><label>' + esc(label) + "</label>" +
      '<button type="button" class="switch ' + (value ? "on" : "") + '" data-act="switch" data-p="' + path +
      '" aria-pressed="' + (value ? "true" : "false") + '" aria-label="' + esc(label) + '"></button></div>'
    );
  }
  if (value === null) {
    return (
      '<div class="field"><label>' + esc(label) + "</label>" +
      '<input class="input" data-p="' + path + '" data-nullable placeholder="留空表示不限" value=""></div>'
    );
  }
  if (t === "number") {
    return (
      '<div class="field"><label>' + esc(label) + "</label>" +
      '<input class="input" type="number" step="any" data-p="' + path + '" value="' + value + '"></div>'
    );
  }
  return (
    '<div class="field"><label>' + esc(label) + "</label>" +
    '<input class="input" data-p="' + path + '" value="' + esc(value) + '"></div>'
  );
}

/** 一维字符串数组（标签类）→ 文本域，用「、」分隔 */
function listEditor(arr, path, label) {
  const items = Array.isArray(arr) ? arr : [];
  return (
    '<div class="field" style="grid-column:1/-1"><label>' + esc(label) + "</label>" +
    '<textarea class="textarea" data-list="' + path + '">' + esc(items.join("、")) + "</textarea>" +
    '<div class="tiny faint mt8">当前 ' + items.length + " 项，用「、」或逗号分隔；保存时自动去空</div></div>"
  );
}

/** 对象 → 表单栅格；嵌套对象用子块，嵌套数组用子表格 */
function objectEditor(obj, basePath) {
  const entries = Object.entries(obj || {});
  return (
    '<div class="form-grid">' +
    entries.map(([k, v]) => {
      const p = basePath ? basePath + "." + k : k;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return (
          '<div class="field" style="grid-column:1/-1"><label>' + esc(labelOf(k)) + "</label>" +
          '<div class="sub-block">' + objectEditor(v, p) + "</div></div>"
        );
      }
      if (Array.isArray(v)) {
        const objArr = v.length > 0 && v.every((x) => x && typeof x === "object" && !Array.isArray(x));
        if (objArr) {
          return (
            '<div class="field" style="grid-column:1/-1"><label>' + esc(labelOf(k)) + "</label>" +
            arrayTable(v, p) +
            '<div class="mt8"><button type="button" class="btn btn-xs btn-outline" data-act="addrow" data-p="' +
            p + '">＋ 新增一行</button></div></div>'
          );
        }
        return listEditor(v, p, labelOf(k));
      }
      return primitiveField(p, v, labelOf(k));
    }).join("") +
    "</div>"
  );
}

/** 对象数组 → 可增删的表格 */
function arrayTable(arr, basePath) {
  const keys = [];
  arr.forEach((o) => Object.keys(o || {}).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
  if (!keys.length) return emptyHtml("暂无可编辑行", "📋");
  const head = keys.map((k) => "<th>" + esc(labelOf(k)) + "</th>").join("") + "<th>操作</th>";
  const body = arr.map((o, i) => {
    const cells = keys.map((k) => {
      const v = o[k];
      const p = basePath + "[" + i + "]." + k;
      if (v === null || v === undefined) {
        return '<td><input class="input" data-p="' + p + '" data-nullable placeholder="不限" value=""></td>';
      }
      if (typeof v === "boolean") {
        return (
          '<td><button type="button" class="switch ' + (v ? "on" : "") + '" data-act="switch" data-p="' + p +
          '" aria-pressed="' + (v ? "true" : "false") + '" aria-label="' + esc(labelOf(k)) + '"></button></td>'
        );
      }
      if (typeof v === "number") {
        return '<td><input class="input" type="number" step="any" data-p="' + p + '" value="' + v + '"></td>';
      }
      return '<td><input class="input" data-p="' + p + '" value="' + esc(v) + '"></td>';
    });
    const del =
      '<td><button type="button" class="btn btn-xs btn-outline" data-act="delrow" data-p="' +
      basePath + "[" + i + ']">删除</button></td>';
    return "<tr>" + cells.join("") + del + "</tr>";
  });
  return (
    '<div class="table-wrap rule-table"><table class="table"><thead><tr>' + head +
    "</tr></thead><tbody>" + body.join("") + "</tbody></table></div>"
  );
}

/** 按值的类型选择编辑器：数组型 / 对象型 / 嵌套数组 / 基础类型 */
function editorHtml(value) {
  if (Array.isArray(value)) {
    const objArr = value.length > 0 && value.every((v) => v && typeof v === "object" && !Array.isArray(v));
    if (objArr) {
      return (
        arrayTable(value, "") +
        '<div class="mt8"><button type="button" class="btn btn-xs btn-outline" data-act="addrow" data-p="">＋ 新增一行</button></div>'
      );
    }
    return listEditor(value, "", "条目");
  }
  if (value && typeof value === "object") return objectEditor(value, "");
  return primitiveField("", value, "");
}

/** 把表单值收回成规则 JSON（以原结构为骨架，避免类型漂移） */
function collectRule(container, model) {
  const out = JSON.parse(JSON.stringify(model));
  container.querySelectorAll("[data-p]").forEach((el) => {
    // 仅收集表单控件，忽略带 data-p 的按钮（如删除行）
    if (!/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName)) return;
    if (el.tagName === "BUTTON" && !el.classList.contains("switch")) return;
    const p = el.dataset.p;
    if (!p) return;
    if (el.classList.contains("switch")) {
      setPath(out, p, el.classList.contains("on"));
      return;
    }
    const prev = getPath(out, p);
    const raw = String(el.value);
    if (el.hasAttribute("data-nullable")) {
      setPath(out, p, raw.trim() === "" ? null : Number(raw));
      return;
    }
    if (typeof prev === "number") {
      const n = Number(raw);
      setPath(out, p, raw.trim() === "" || Number.isNaN(n) ? prev : n);
      return;
    }
    setPath(out, p, raw);
  });
  container.querySelectorAll("[data-list]").forEach((el) => {
    const p = el.dataset.list;
    const items = String(el.value).split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean);
    if (p) setPath(out, p, items);

  });
  return out;
}

function ruleCardHtml(rule, model) {
  const editable = model.editable !== false;
  return (
    '<div class="pc-card rule-card" data-rule="' + esc(rule.key) + '">' +
    "<h3>" + esc(rule.label) + '<span class="key">' + esc(rule.key) + "</span>" +
    '<span class="rule-tools">' +
    '<span class="badge gold dirty">未保存</span>' +
    (editable ? "" : '<span class="badge gray">只读</span>') +
    '<span class="tiny faint" data-updated>更新于 ' + fmtDate(rule.updated_at, "time") + "</span>" +
    (editable
      ? '<button class="btn btn-xs btn-outline" data-act="reset-rule">重置</button>' +
        '<button class="btn btn-xs btn-primary" data-act="save-rule">保存</button>'
      : "") +
    "</span></h3>" +
    '<div class="rule-body" data-body>' + editorHtml(model.current) + "</div>" +
    "</div>"
  );
}

async function viewRules(root, ctx) {
  const box = paint(root, '<div class="pc-card">' + loadingHtml("正在加载规则配置…") + "</div>");
  let data;
  try {
    data = await api.get("/api/admin/rules");
  } catch (err) {
    if (err?.status === 401) return handle401();
    box.innerHTML = errorHtml(err);
    const b = box.querySelector("[data-retry]");
    if (b) b.onclick = () => viewRules(root, ctx);
    return;
  }

  const groups = data.groups || {};
  const keys = Object.keys(groups);
  if (!keys.length) {
    box.innerHTML = '<div class="pc-card">' + emptyHtml("规则库为空", "⚙️") + "</div>";
    return;
  }
  const wanted = ctx?.query?.grp;
  let active = keys.includes(wanted) ? wanted : keys[0];

  const models = new Map();
  data.rules.forEach((r) => {
    models.set(r.key, {
      original: JSON.parse(JSON.stringify(r.value)),
      current: JSON.parse(JSON.stringify(r.value)),
      editable: r.editable !== 0 && r.editable !== false,
      label: r.label,
    });
  });

  box.innerHTML = `
    <div class="pc-card">
      <h3>⚙️ 规则配置中心<span class="more">共 ${data.rules.length} 组规则 · 保存即热更新</span></h3>
      <div class="hint">这些规则驱动派单、抽佣、等级、信用、奖励与结算，修改即刻生效并写入操作日志（无需重启服务）。数值型字段请填写数字，比例型字段请填 0–1 之间的小数（如 0.25 = 25%）。</div>
      <div class="tabs mt12" data-grp>
        ${keys.map((k) =>
          `<button data-g="${esc(k)}" class="${k === active ? "on" : ""}">${esc(k)} <span class="faint tiny">${(groups[k] || []).length}</span></button>`
        ).join("")}
      </div>
      <div data-rules></div>
    </div>`;

  const listEl = box.querySelector("[data-rules]");

  const paintGroup = () => {
    const rules = groups[active] || [];
    listEl.innerHTML = rules.length
      ? rules.map((r) => ruleCardHtml(r, models.get(r.key))).join("")
      : emptyHtml("该分组暂无规则", "📋");
  };

  const cardOf = (el) => (el ? el.closest("[data-rule]") : null);
  const repaint = (key) => {
    const card = box.querySelector('[data-rule="' + key + '"]');
    if (!card) return;
    const body = card.querySelector("[data-body]");
    body.innerHTML = editorHtml(models.get(key).current);
    card.classList.remove("is-dirty");
  };
  const markDirty = (el) => cardOf(el)?.classList.add("is-dirty");

  box.querySelectorAll("[data-g]").forEach((b) => {
    b.addEventListener("click", () => {
      active = b.dataset.g;
      box.querySelectorAll("[data-g]").forEach((x) => x.classList.toggle("on", x === b));
      history.replaceState(null, "", "#/rules?grp=" + encodeURIComponent(active));
      paintGroup();
    });
  });

  box.addEventListener("input", (e) => {
    if (e.target.closest("[data-rule]")) markDirty(e.target);
  });

  bindActions(box, {
    switch: (btn) => {
      btn.classList.toggle("on");
      btn.setAttribute("aria-pressed", btn.classList.contains("on") ? "true" : "false");
      markDirty(btn);
    },
    "save-rule": async (btn) => {
      const card = cardOf(btn);
      const key = card.dataset.rule;
      const model = models.get(key);
      const body = card.querySelector("[data-body]");
      const bad = Array.from(body.querySelectorAll('input[type="number"]')).find(
        (i) => i.value !== "" && Number.isNaN(Number(i.value))
      );
      if (bad) return toastErr("存在无效的数字输入，请检查后重试");
      const value = collectRule(body, model.current);
      await busy(btn, async () => {
        await api.put("/api/admin/rules/" + encodeURIComponent(key), { value });
        model.current = value;
        model.original = JSON.parse(JSON.stringify(value));
        card.classList.remove("is-dirty");
        const t = card.querySelector("[data-updated]");
        if (t) t.textContent = "更新于 " + fmtDate(new Date().toISOString(), "time");
        toastOk("「" + model.label + "」已保存，已热更新生效，无需重启");
      });
    },
    "reset-rule": async (btn) => {
      const card = cardOf(btn);
      const key = card.dataset.rule;
      const model = models.get(key);
      const ok = await confirmDialog("重置未保存的修改", "将丢弃当前表单中的改动，恢复为服务端已生效的规则值。", "重置");
      if (!ok) return;
      model.current = JSON.parse(JSON.stringify(model.original));
      repaint(key);
      toastOk("已恢复为已生效值");
    },
    addrow: (btn) => {
      const card = cardOf(btn);
      const key = card.dataset.rule;
      const model = models.get(key);
      model.current = collectRule(card.querySelector("[data-body]"), model.current);
      const path = btn.dataset.p || "";
      const arr = path ? getPath(model.current, path) : model.current;
      if (!Array.isArray(arr)) return toastErr("该字段不是数组，无法新增行");
      const tmpl = arr[arr.length - 1] || {};
      const row = {};
      Object.keys(tmpl).forEach((k) => {
        const v = tmpl[k];
        row[k] = typeof v === "number" ? 0 : typeof v === "boolean" ? false : v === null ? null : "";
      });
      arr.push(row);
      repaint(key);
      markDirty(box.querySelector('[data-rule="' + key + '"] [data-body]'));
    },
    delrow: (btn) => {
      const card = cardOf(btn);
      const key = card.dataset.rule;
      const model = models.get(key);
      model.current = collectRule(card.querySelector("[data-body]"), model.current);
      const tokens = pathTokens(btn.dataset.p);
      const idx = tokens.pop();
      const parent = tokens.reduce((acc, t) => acc[t], model.current);
      if (!Array.isArray(parent)) return toastErr("该行无法删除");
      parent.splice(idx, 1);
      repaint(key);
      markDirty(box.querySelector('[data-rule="' + key + '"] [data-body]'));
    },
  });

  paintGroup();
}


/* ============================================================
   资金组：财务资金管理 / 对账 / 提现 / 奖励 / 台账
   ============================================================ */

const yuanStr = (c) => (Number(c || 0) / 100).toFixed(2);

function downloadCsv(filename, rows) {
  const csv = rows
    .map((r) =>
      r.map((v) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(",")
    )
    .join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

async function viewFinance(root) {
  const box = paint(root, '<div data-body>' + loadingHtml("正在加载资金数据…") + "</div>");
  const body = box.querySelector("[data-body]");
  let data;
  try {
    data = await api.get("/api/admin/finance");
  } catch (err) {
    if (err?.status === 401) return handle401();
    body.innerHTML = errorHtml(err);
    const b = body.querySelector("[data-retry]");
    if (b) b.onclick = () => viewFinance(root);
    return;
  }

  const s = data.summary || {};
  const rec = data.reconciliation || {};
  const teacherIncome = Number(rec.gmvFormula || 0) - Number(rec.splitFormula || 0);
  const diff1 = Number(rec.gmvFormula || 0) - (teacherIncome + Number(rec.splitFormula || 0));
  const splitSum = Number(rec.agentShare || 0) + Number(rec.salesCommission || 0) + Number(rec.platformRevenue || 0);
  const diff2 = Number(rec.splitFormula || 0) - splitSum;
  const ok1 = Math.abs(diff1) < 1;
  const ok2 = Math.abs(diff2) < 1;

  const kpiList = [
    ["💵 GMV（已支付）", moneyNum(s.totalGmv), "", "全部已支付订单金额"],
    ["🏦 平台服务费", moneyNum(s.serviceFee), "", "已完成 / 已结算订单计提"],
    ["🤝 代理分成", moneyNum(s.agentShare), "", "服务费分成 + 管理提成"],
    ["📣 业务员提成", moneyNum(s.salesCommission), "", "按成交阶梯计提"],
    ["📈 平台净收入", moneyNum(s.revenue), "primary", "服务费 − 分成 − 提成"],
    ["🔒 担保在账", moneyNum(s.escrow), "green", "已支付未结算 / 未退款"],
    ["⏳ 待结算", moneyNum(s.pendingSettle), "", "已完成待放款教员实收"],
    ["👛 钱包余额合计", moneyNum(s.totalWallet), "", "全平台可用余额"],
    ["🧊 冻结合计", moneyNum(s.totalFrozen), "", "提现 / 担保冻结中"],
    ["💸 提现待审", moneyNum(s.withdrawPending), "gold", "待审核提现申请金额"],
  ];

  const reconLine = (ok, title, eqHtml, diff, note) => `
    <div class="line ${ok ? "ok" : "bad"}">
      <span class="mark">${ok ? "✓" : "!"}</span>
      <div style="min-width:0">
        <div class="small bold">${esc(title)}${note ? ' <span class="tiny faint">' + esc(note) + "</span>" : ""}</div>
        <div class="eq">${eqHtml}</div>
      </div>
      <span class="diff" style="color:${ok ? "#0a8a66" : "var(--danger)"}">差额 ${money(diff)}</span>
    </div>`;

  const withdrawalRows = (data.withdrawals || []).map((w) => [
    "<b>" + esc(w.nickname || "—") + '</b><div class="tiny faint">' + esc(ROLE[w.role] || w.role) + "</div>",
    '<span class="num bold">' + money(w.amount) + "</span>",
    '<span class="num">' + money(w.fee) + "</span>",
    '<span class="num">' + money(w.actual) + "</span>",
    '<span class="small">' + esc(CHANNEL[w.channel] || w.channel) + '</span><div class="tiny faint mono">' + esc(or(w.account)) + "</div>",
    payBadge(w.status),
    '<span class="small faint nowrap">' + fmtDate(w.created_at, "time") + "</span>",
    w.status === "pending"
      ? '<div class="row" style="gap:6px">' +
        '<button class="btn btn-xs btn-primary" data-act="withdraw" data-op="ok" data-id="' + w.id + '" data-amount="' + w.actual + '">通过</button>' +
        '<button class="btn btn-xs btn-danger" data-act="withdraw" data-op="no" data-id="' + w.id + '">驳回</button></div>'
      : '<span class="small faint">' + esc(or(w.reject_reason, "已处理")) + "</span>",
  ]);

  const rewardRows = (data.rewards || []).map((r) => [
    esc(r.nickname || "—"),
    '<span class="badge gray">' + esc(REWARD_TYPE[r.type] || r.type) + "</span>",
    '<span class="num bold">' + money(r.amount) + "</span>",
    r.ref_order_id ? "#" + r.ref_order_id : '<span class="faint">—</span>',
    '<span class="small faint">' + esc(or(r.calc_note, "—")) + "</span>",
    statusBadge(r.status === "settled" ? "settled" : r.status === "cancelled" ? "cancelled" : "pending",
      r.status === "settled" ? "已结算" : r.status === "cancelled" ? "已取消" : "待结算"),
    '<span class="small faint nowrap">' + fmtDate(r.settle_at || r.created_at, "time") + "</span>",
  ]);

  const escrowRows = (data.escrowLedger || []).map((l) => [
    l.direction === "in" ? '<span class="badge green">入账</span>' : '<span class="badge danger">出账</span>',
    '<span class="num">' + money(l.amount) + "</span>",
    '<span class="num">' + money(l.balance) + "</span>",
    '<span class="small">' + esc(or(l.remark, "—")) + "</span>",
    l.order_id ? "#" + l.order_id : '<span class="faint">—</span>',
    '<span class="small faint nowrap">' + fmtDate(l.created_at, "time") + "</span>",
  ]);

  const paymentRows = (data.payments || []).map((p) => [
    '<span class="mono">' + esc(or(p.order_no, "#" + p.order_id)) + "</span>",
    p.type === "refund" ? '<span class="badge danger">退款</span>' : '<span class="badge green">支付</span>',
    '<span class="num">' + money(p.amount) + "</span>",
    esc(CHANNEL[p.channel] || p.channel),
    '<span class="mono">' + esc(p.trade_no) + "</span>",
    '<span class="small faint nowrap">' + fmtDate(p.created_at, "time") + "</span>",
  ]);

  const invoiceRows = (data.invoices || []).map((i) => [
    '<span class="mono">' + esc(i.invoice_no) + "</span>",
    '<span class="mono small">' + esc(or(i.order_no, "#" + i.order_id)) + "</span>",
    esc(i.nickname || "—") + '<div class="tiny faint">' + esc(or(i.phone, "")) + "</div>",
    '<span class="badge gray">' + (i.title_type === "company" ? "企业" : "个人") + "</span> " + esc(i.title) +
      (i.tax_no ? '<div class="tiny faint mono">' + esc(i.tax_no) + "</div>" : ""),
    '<span class="num bold">' + money(i.amount) + "</span>",
    i.status === "issued"
      ? '<span class="badge green">已开票</span>'
      : i.status === "rejected"
        ? '<span class="badge danger">已驳回</span>'
        : '<span class="badge gold">待受理</span>',
    '<span class="small faint nowrap">' + fmtDate(i.created_at, "time") + "</span>",
    i.status === "pending"
      ? '<div class="row" style="gap:6px;flex-wrap:nowrap">' +
        '<button class="btn btn-xs btn-primary" data-act="invoice-review" data-op="yes" data-id="' + i.id + '">开票</button>' +
        '<button class="btn btn-xs btn-danger" data-act="invoice-review" data-op="no" data-id="' + i.id + '">驳回</button></div>'
      : i.status === "issued"
        ? '<span class="small">' + (i.invoice_url
            ? '<a href="' + esc(i.invoice_url) + '" target="_blank" rel="noopener">电子发票</a>'
            : '<span class="faint">已开具（无链接）</span>') + "</span>"
        : '<span class="small faint">' + esc(or(i.reject_reason, "已驳回")) + "</span>",
  ]);

  body.innerHTML = `
    <div class="pc-grid c4 mb16">
      ${kpiList.map(([label, value, cls, foot], i) =>
        `<div class="kpi sm ${cls} rise" style="animation-delay:${Math.min(i * 0.02, 0.14)}s">
          <div class="label">${label}</div>
          <div class="value">${value}<small>元</small></div>
          <div class="foot">${foot}</div>
        </div>`).join("")}
    </div>
    <div class="pc-card">
      <h3>🧮 资金对账<span class="more">
        <button class="btn btn-xs btn-outline" data-act="export">⬇️ 导出对账报表</button>
      </span></h3>
      <div class="recon">
        ${reconLine(ok1, "实付 = 教员实收 + 平台服务费", `实付 <b>${money(rec.gmvFormula)}</b> = 教员实收 <b>${money(teacherIncome)}</b> + 服务费 <b>${money(rec.splitFormula)}</b>`, diff1, "按已支付订单汇总，教员实收由实付扣减服务费推得")}
        ${reconLine(ok2, "服务费 = 代理分成 + 业务员提成 + 平台净收入", `服务费 <b>${money(rec.splitFormula)}</b> = 代理 <b>${money(rec.agentShare)}</b> + 业务员 <b>${money(rec.salesCommission)}</b> + 平台 <b>${money(rec.platformRevenue)}</b>`, diff2, "已完成 / 已结算订单的分账校验")}
      </div>
      <div class="hint ${ok1 && ok2 ? "green" : "danger"} mt12">
        ${ok1 && ok2 ? "两条恒等式均平账，分账与担保台账自洽。" : "存在分账差额，请检查订单分账字段与代理 / 业务员比例配置。"}
      </div>
    </div>
    <div class="pc-card">
      <h3>💸 提现审核<span class="more">待处理 ${num((data.withdrawals || []).filter((w) => w.status === "pending").length)} 笔</span></h3>
      ${tableHtml(["申请人", "申请金额", "手续费", "实发", "渠道 / 账户", "状态", "申请时间", "操作"], withdrawalRows) || emptyHtml("暂无提现申请", "💸")}
    </div>
    <div class="pc-card">
      <h3>🧾 发票受理<span class="more">待受理 ${num((data.invoices || []).filter((i) => i.status === "pending").length)} 件 · 已开票 ${num(s.invoiceIssued)} 件</span></h3>
      ${tableHtml(["申请单号", "订单号", "家长", "抬头", "开票金额", "状态", "申请时间", "操作"], invoiceRows) || emptyHtml("暂无发票申请", "🧾")}
    </div>
    <div class="pc-card">
      <h3>🎁 业务员奖励<span class="more">
        <button class="btn btn-xs btn-primary" data-act="settle-rewards">批量结算待发奖励</button>
      </span></h3>
      ${tableHtml(["业务员", "奖励类型", "金额", "关联订单", "计算口径", "状态", "时间"], rewardRows) || emptyHtml("暂无奖励记录", "🎁")}
    </div>
    <div class="pc-grid c2">
      <div class="pc-card" style="margin-bottom:0">
        <h3>🔒 担保资金台账<span class="more">最近 60 条</span></h3>
        ${tableHtml(["方向", "金额", "余额", "备注", "订单", "时间"], escrowRows) || emptyHtml("暂无台账记录", "🔒")}
      </div>
      <div class="pc-card" style="margin-bottom:0">
        <h3>🧾 支付流水<span class="more">最近 60 条</span></h3>
        ${tableHtml(["订单号", "类型", "金额", "渠道", "交易号", "时间"], paymentRows) || emptyHtml("暂无支付流水", "🧾")}
      </div>
    </div>`;

  bindActions(box, {
    export: () => {
      const rows = [
        ["对账汇总"],
        ["指标", "金额（元）"],
        ["GMV（已支付）", yuanStr(s.totalGmv)],
        ["平台服务费", yuanStr(s.serviceFee)],
        ["代理分成", yuanStr(s.agentShare)],
        ["业务员提成", yuanStr(s.salesCommission)],
        ["平台净收入", yuanStr(s.revenue)],
        ["担保在账", yuanStr(s.escrow)],
        ["待结算", yuanStr(s.pendingSettle)],
        ["钱包余额合计", yuanStr(s.totalWallet)],
        ["冻结合计", yuanStr(s.totalFrozen)],
        ["提现待审", yuanStr(s.withdrawPending)],
        [],
        ["对账恒等式", "实付 = 教员实收 + 服务费；服务费 = 代理分成 + 业务员提成 + 平台净收入"],
        ["恒等式差额（实付）", yuanStr(diff1)],
        ["恒等式差额（服务费）", yuanStr(diff2)],
        [],
        ["提现记录"],
        ["申请人", "角色", "金额（元）", "手续费（元）", "实发（元）", "状态", "申请时间"],
        ...(data.withdrawals || []).map((w) => [
          w.nickname || "", ROLE[w.role] || w.role, yuanStr(w.amount), yuanStr(w.fee), yuanStr(w.actual),
          WITHDRAW_STATUS[w.status] || w.status, fmtDate(w.created_at, "time"),
        ]),
        [],
        ["担保资金台账"],
        ["时间", "方向", "金额（元）", "余额（元）", "备注", "订单ID"],
        ...(data.escrowLedger || []).map((l) => [
          fmtDate(l.created_at, "time"), l.direction === "in" ? "入账" : "出账",
          yuanStr(l.amount), yuanStr(l.balance), l.remark || "", l.order_id || "",
        ]),
        [],
        ["支付流水"],
        ["时间", "类型", "金额（元）", "渠道", "交易号", "订单号"],
        ...(data.payments || []).map((p) => [
          fmtDate(p.created_at, "time"), PAY_TYPE[p.type] || p.type, yuanStr(p.amount),
          CHANNEL[p.channel] || p.channel, p.trade_no, p.order_no || "",
        ]),
      ];
      downloadCsv("对账报表_" + fmtDate(new Date().toISOString(), "date").replace(/-/g, "") + ".csv", rows);
      toastOk("对账报表已导出（CSV）");
    },
    "invoice-review": async (btn) => {
      const approve = btn.dataset.op === "yes";
      let invoiceUrl = "";
      let rejectReason = "";
      if (approve) {
        const url = await promptDialog("开具电子发票", "填写电子发票文件地址（可留空，仅标记为已开票）", {
          value: "",
          textarea: false,
          confirmText: "确认开票",
        });
        if (url === null) return;
        invoiceUrl = url.trim();
      } else {
        const reason = await promptDialog("驳回发票申请", "填写驳回原因（将通知家长，可修改后重新申请）", {
          textarea: true,
          confirmText: "确认驳回",
        });
        if (reason === null) return;
        rejectReason = reason;
      }
      await busy(btn, async () => {
        await api.post("/api/admin/invoices/" + btn.dataset.id + "/review", {
          approve, invoiceUrl, rejectReason,
        });
        toastOk(approve ? "已开票并通知家长" : "已驳回并通知家长");
        await viewFinance(root);
        await syncPending();
      });
    },
    withdraw: async (btn) => {
      const approve = btn.dataset.op === "ok";
      if (approve) {
        const ok = await confirmDialog(
          "通过提现",
          "将打款 " + money(Number(btn.dataset.amount)) + " 至用户账户，并计入累计提现。",
          "确认打款",
          true
        );
        if (!ok) return;
      }
      let reason = "";
      if (!approve) {
        reason = await promptDialog("驳回提现", "填写驳回理由，金额将退回用户钱包余额（必填）", {
          textarea: true,
          confirmText: "确认驳回",
        });
        if (reason === null) return;
      }
      await busy(btn, async () => {
        await api.post("/api/admin/withdrawals/" + btn.dataset.id + "/review", { approve, reason });
        toastOk(approve ? "提现已打款" : "提现已驳回，金额已退回余额");
        await viewFinance(root);
        await syncPending();
      });
    },
    "settle-rewards": async (btn) => {
      const ok = await confirmDialog(
        "批量结算业务员奖励",
        "所有待结算奖励将立即入账到业务员钱包，并写入奖励结算记录与操作日志。",
        "立即结算"
      );
      if (!ok) return;
      await busy(btn, async () => {
        const d = await api.post("/api/admin/rewards/settle");
        toastOk("已结算 " + num(d.settled) + " 笔奖励");
        await viewFinance(root);
      });
    },
  });
}

/* ============================================================
   风控组：异常订单 / 差评申诉仲裁 / 投诉工单终审
   ============================================================ */

function riskEventsTable(events) {
  return tableHtml(
    ["类型", "等级", "原因", "关联用户", "订单号", "状态", "结算冻结", "时间", "操作"],
    events.map((e) => [
      '<span class="badge gray">' + esc(RISK_TYPE[e.type] || e.type) + "</span>",
      '<span class="badge ' + (e.level === "high" ? "danger" : e.level === "low" ? "gray" : "gold") + '">' +
        esc(RISK_LEVEL[e.level] || e.level) + "</span>",
      '<span class="small">' + esc(or(e.reason, "—")) + "</span>",
      esc(or(e.nickname, "—")) + (e.userRole ? '<div class="tiny faint">' + esc(ROLE[e.userRole] || e.userRole) + "</div>" : ""),
      e.order_no ? '<span class="mono">' + esc(e.order_no) + "</span>" : '<span class="faint">—</span>',
      statusBadge(e.status, RISK_STATUS[e.status] || e.status),
      e.settlement_hold ? '<span class="badge danger">已冻结</span>' : '<span class="faint small">—</span>',
      '<span class="small faint nowrap">' + fmtDate(e.created_at, "time") + "</span>",
      '<div class="row" style="gap:6px">' +
        (e.status === "closed" ? '<span class="faint small">已关闭</span>' :
          '<button class="btn btn-xs btn-outline" data-act="handle" data-op="close" data-id="' + e.id + '">关闭</button>' +
          '<button class="btn btn-xs btn-outline" data-act="handle" data-op="' + (e.settlement_hold ? "release" : "hold") +
          '" data-id="' + e.id + '">' + (e.settlement_hold ? "解除冻结" : "冻结结算") + "</button>" +
          '<button class="btn btn-xs btn-danger" data-act="handle" data-op="punish" data-id="' + e.id + '">处罚</button>') +
        "</div>",
    ])
  );
}

function riskAppealsTable(appeals) {
  return tableHtml(
    ["评分", "评价内容", "标签", "家长", "教员", "订单号", "申诉理由", "申诉状态", "操作"],
    appeals.map((r) => [
      '<span class="stars">' + Array.from({ length: 5 }, (_, i) =>
        '<i class="' + (i < r.score ? "on" : "") + '">★</i>').join("") + "</span>",
      '<div style="max-width:220px" class="small">' + esc(or(r.content, "—")) + "</div>",
      (r.tags || []).map((t) => '<span class="tag">' + esc(t) + "</span>").join(" ") || '<span class="faint">—</span>',
      esc(or(r.parentName, "—")),
      esc(or(r.teacherName, "—")),
      r.order_no ? '<span class="mono">' + esc(r.order_no) + "</span>" : '<span class="faint">—</span>',
      '<div style="max-width:220px" class="small">' + esc(or(r.appeal_reason, "—")) + "</div>",
      statusBadge(r.appeal_status === "accepted" ? "approved" : r.appeal_status === "rejected" ? "rejected" : "pending",
        APPEAL_STATUS[r.appeal_status] || r.appeal_status),
      r.appeal_status === "pending"
        ? '<div class="row" style="gap:6px">' +
          '<button class="btn btn-xs btn-primary" data-act="arbitrate" data-op="accept" data-id="' + r.id + '" data-score="' + r.score + '">撤销评价</button>' +
          '<button class="btn btn-xs btn-danger" data-act="arbitrate" data-op="reject" data-id="' + r.id + '">维持原判</button></div>'
        : '<span class="small faint">' + esc(or(r.appeal_result, "已处理")) + "</span>",
    ])
  );
}

function riskComplaintsTable(list) {
  return tableHtml(
    ["来源", "类型", "标题", "内容", "订单号", "状态", "时间", "操作"],
    list.map((c) => [
      '<span class="badge gray">' + esc(ROLE[c.from_role] || c.from_role) + "</span>" +
        '<div class="tiny faint">' + esc(or(c.fromName, "—")) + "</div>",
      esc(COMPLAINT_TYPE[c.type] || c.type),
      '<b class="small">' + esc(c.title) + "</b>",
      '<div style="max-width:240px" class="small">' + esc(or(c.content, "—")) + "</div>",
      c.order_no ? '<span class="mono">' + esc(c.order_no) + "</span>" : '<span class="faint">—</span>',
      statusBadge(c.status, COMPLAINT_STATUS[c.status] || c.status),
      '<span class="small faint nowrap">' + fmtDate(c.created_at, "time") + "</span>",
      c.status === "closed"
        ? '<span class="small faint">' + esc(or(c.handle_note, "已结案")) + "</span>"
        : '<button class="btn btn-xs btn-primary" data-act="close-complaint" data-id="' + c.id + '">终审结案</button>',
    ])
  );
}

async function viewRisk(root) {
  const box = paint(root, `
    <div class="pc-card">
      <h3>🛡️ 风控与审核<span class="more" data-count>—</span></h3>
      <div class="tabs" data-tabs>
        <button class="on" data-t="events">异常订单</button>
        <button data-t="appeals">差评申诉仲裁</button>
        <button data-t="complaints">投诉工单终审</button>
      </div>
      <div data-pane="events"></div>
      <div data-pane="appeals" hidden></div>
      <div data-pane="complaints" hidden></div>
    </div>`);

  const panes = {
    events: box.querySelector('[data-pane="events"]'),
    appeals: box.querySelector('[data-pane="appeals"]'),
    complaints: box.querySelector('[data-pane="complaints"]'),
  };
  const countEl = box.querySelector("[data-count]");

  const load = async () => {
    Object.values(panes).forEach((el) => { el.innerHTML = loadingHtml("正在加载风控数据…"); });
    try {
      const d = await api.get("/api/admin/risks");
      const events = d.events || [];
      const appeals = d.appeals || [];
      const complaints = d.complaints || [];
      panes.events.innerHTML = riskEventsTable(events) || emptyHtml("暂无异常订单", "✅");
      panes.appeals.innerHTML = riskAppealsTable(appeals) || emptyHtml("暂无差评申诉", "⭐");
      panes.complaints.innerHTML = riskComplaintsTable(complaints) || emptyHtml("暂无投诉工单", "📣");
      countEl.textContent =
        "异常 " + num(events.filter((e) => e.status !== "closed").length) +
        " · 申诉 " + num(appeals.filter((a) => a.appeal_status === "pending").length) +
        " · 客诉 " + num(complaints.filter((c) => c.status !== "closed").length);
    } catch (err) {
      if (err?.status === 401) return handle401();
      const html = errorHtml(err);
      Object.values(panes).forEach((el) => { el.innerHTML = html; });
      Object.values(panes).forEach((el) => {
        const b = el.querySelector("[data-retry]");
        if (b) b.onclick = load;
      });
    }
  };

  box.querySelectorAll("[data-t]").forEach((b) => {
    b.addEventListener("click", () => {
      box.querySelectorAll("[data-t]").forEach((x) => x.classList.toggle("on", x === b));
      Object.keys(panes).forEach((k) => { panes[k].hidden = k !== b.dataset.t; });
    });
  });

  bindActions(box, {
    handle: async (btn) => {
      const op = btn.dataset.op;
      let note = "";
      if (op === "punish") {
        note = await promptDialog(
          "违规处罚",
          "填写处罚说明（虚假打卡扣 100 成长分，刷单将直接禁用账号）",
          { textarea: true, confirmText: "下一步" }
        );
        if (note === null) return;
        const ok = await confirmDialog("确认处罚", "处罚不可撤销：按风控规则扣分 / 禁用账号，并关闭该事件。", "确认处罚", true);
        if (!ok) return;
      } else {
        const title = op === "close" ? "关闭风险事件" : op === "hold" ? "冻结结算" : "解除冻结";
        const text = op === "close"
          ? "关闭事件会同时解除结算冻结，订单恢复自动结算。"
          : op === "hold"
            ? "冻结结算会阻止该订单放款，等待进一步核查。"
            : "解除冻结后该订单将恢复自动结算。";
        const ok = await confirmDialog(title, text, "确认");
        if (!ok) return;
      }
      await busy(btn, async () => {
        await api.post("/api/admin/risks/" + btn.dataset.id + "/handle", { action: op, note });
        toastOk("已处理");
        await load();
        await syncPending();
      });
    },
    arbitrate: async (btn) => {
      const accept = btn.dataset.op === "accept";
      if (accept) {
        const ok = await confirmDialog(
          "撤销差评评价",
          "将隐藏该评价、回滚扣减的成长分，并通知教员与家长；仲裁结果会写入操作日志。",
          "确认撤销",
          true
        );
        if (!ok) return;
      }
      let reason = accept ? "平台仲裁撤销，扣分回滚" : "";
      if (!accept) {
        reason = await promptDialog("维持原判", "填写维持原判的理由，将通知申诉教员（必填）", {
          textarea: true,
          confirmText: "维持原判",
        });
        if (reason === null) return;
      }
      await busy(btn, async () => {
        await api.post("/api/admin/appeals/" + btn.dataset.id + "/arbitrate", { accept, reason });
        toastOk(accept ? "已撤销评价并回滚成长分" : "已维持原判");
        await load();
        await syncPending();
      });
    },
    "close-complaint": async (btn) => {
      const note = await promptDialog("客诉终审结案", "填写处理结论，工单将关闭并留存记录", {
        value: "平台终审结案",
        textarea: true,
        confirmText: "确认结案",
      });
      if (note === null) return;
      await busy(btn, async () => {
        await api.post("/api/admin/complaints/" + btn.dataset.id + "/close", { note });
        toastOk("工单已结案");
        await load();
        await syncPending();
      });
    },
  });

  await load();
}

/* ============================================================
   运营组：Banner / 公告推送 / 优惠券 / 协议文案
   ============================================================ */

async function viewOps(root) {
  const box = paint(root, `
    <div class="pc-card">
      <h3>📣 运营工具</h3>
      <div class="tabs" data-tabs>
        <button class="on" data-t="banners">Banner 管理</button>
        <button data-t="announcements">公告与消息推送</button>
        <button data-t="coupons">优惠券配置</button>
        <button data-t="agreements">协议文案</button>
      </div>

      <div data-pane="banners">
        <div data-list="banners"></div>
        <form class="form-block" data-form="banner" autocomplete="off">
          <div class="t">＋ 新增 Banner</div>
          <div class="form-grid">
            <div class="field"><label>标题 <span class="req">*</span></label><input class="input" name="title" placeholder="如 新学期名师专区"></div>
            <div class="field"><label>图片地址</label><input class="input" name="image" placeholder="https://… 或 /uploads/…"></div>
            <div class="field"><label>跳转链接</label><input class="input" name="link" placeholder="/parent/home"></div>
            <div class="field"><label>排序（小在前）</label><input class="input" name="sort" type="number" value="0"></div>
            <div class="field"><label>状态</label><select class="select" name="status"><option value="on">上架</option><option value="off">下架</option></select></div>
          </div>
          <div class="row mt12"><button class="btn btn-sm btn-primary" type="submit">添加 Banner</button></div>
        </form>
      </div>

      <div data-pane="announcements" hidden>
        <div data-list="announcements"></div>
        <form class="form-block" data-form="announcement" autocomplete="off">
          <div class="t">＋ 发布公告</div>
          <div class="form-grid">
            <div class="field"><label>标题 <span class="req">*</span></label><input class="input" name="title" placeholder="如 平台服务费规则调整通知"></div>
            <div class="field"><label>接收人群</label>
              <select class="select" name="audience">
                ${Object.keys(AUDIENCE).map((k) => `<option value="${k}">${AUDIENCE[k]}</option>`).join("")}
              </select>
            </div>
            <div class="field" style="grid-column:1/-1"><label>正文</label><textarea class="textarea" name="content" placeholder="公告正文，支持换行"></textarea></div>
          </div>
          <div class="row wrap mt12" style="gap:18px">
            <label class="check"><input type="checkbox" name="pinned"> 置顶公告</label>
            <label class="check"><input type="checkbox" name="push"> 同时推送站内消息</label>
            <span class="faint tiny">勾选推送后会向该人群的所有用户发送站内消息</span>
          </div>
          <div class="row mt12"><button class="btn btn-sm btn-primary" type="submit">发布公告</button></div>
        </form>
      </div>

      <div data-pane="coupons" hidden>
        <div data-list="coupons"></div>
        <form class="form-block" data-form="coupon" autocomplete="off">
          <div class="t">＋ 新建优惠券</div>
          <div class="form-grid">
            <div class="field"><label>券名 <span class="req">*</span></label><input class="input" name="name" placeholder="如 新用户立减 20"></div>
            <div class="field"><label>减免金额（元）<span class="req">*</span></label><input class="input" name="amount" type="number" min="1" step="1" value="20"></div>
            <div class="field"><label>使用门槛（元）</label><input class="input" name="threshold" type="number" min="0" step="1" value="0"></div>
            <div class="field"><label>发行总量</label><input class="input" name="total" type="number" min="0" step="1" value="200"></div>
            <div class="field"><label>生效日期</label><input class="input" name="validFrom" type="date"></div>
            <div class="field"><label>失效日期</label><input class="input" name="validTo" type="date"></div>
          </div>
          <div class="row mt12"><button class="btn btn-sm btn-primary" type="submit">创建优惠券</button></div>
        </form>
      </div>

      <div data-pane="agreements" hidden>
        <div class="pc-toolbar">
          <select class="select" data-ag-key></select>
          <span class="faint small" data-ag-time></span>
          <span style="flex:1"></span>
          <button class="btn btn-sm btn-primary" data-act="save-agreement">保存文案</button>
        </div>
        <textarea class="textarea" data-ag-content style="min-height:320px" placeholder="协议正文"></textarea>
      </div>
    </div>`);

  const paneOf = (k) => box.querySelector('[data-pane="' + k + '"]');
  const listOf = (k) => box.querySelector('[data-list="' + k + '"]');
  box.querySelectorAll("[data-t]").forEach((b) => {
    b.addEventListener("click", () => {
      box.querySelectorAll("[data-t]").forEach((x) => x.classList.toggle("on", x === b));
      ["banners", "announcements", "coupons", "agreements"].forEach((k) => {
        paneOf(k).hidden = k !== b.dataset.t;
      });
    });
  });

  let agreements = [];

  const loadBanners = () =>
    loadData(
      listOf("banners"),
      () => api.get("/api/admin/banners"),
      (list) =>
        tableHtml(
          ["排序", "标题", "图片", "跳转链接", "状态", "创建时间", "操作"],
          list.map((b) => [
            '<span class="num">' + num(b.sort) + "</span>",
            "<b>" + esc(b.title) + "</b>",
            b.image ? '<img src="' + esc(b.image) + '" alt="" style="width:64px;height:34px;object-fit:cover;border-radius:6px">' : '<span class="faint">—</span>',
            '<span class="mono">' + esc(or(b.link, "—")) + "</span>",
            statusBadge(b.status, b.status === "on" ? "上架" : "已停用"),
            '<span class="small faint nowrap">' + fmtDate(b.created_at, "date") + "</span>",
            '<div class="row" style="gap:6px;flex-wrap:nowrap">' +
              '<button class="btn btn-xs btn-outline" data-act="edit-banner" data-id="' + b.id + '">编辑</button>' +
              '<button class="btn btn-xs ' + (b.status === "on" ? "btn-outline" : "btn-ghost") + '" data-act="toggle-banner" data-id="' + b.id + '">' +
                (b.status === "on" ? "停用" : "启用") + "</button>" +
              '<button class="btn btn-xs btn-danger" data-act="del-banner" data-id="' + b.id +
                '" data-title="' + esc(b.title) + '">删除</button>' +
            "</div>",
          ])
        ),
      { loading: "正在加载 Banner…", empty: "暂无 Banner", icon: "🖼️" }
    );

  const loadAnnouncements = () =>
    loadData(
      listOf("announcements"),
      () => api.get("/api/admin/announcements"),
      (list) =>
        tableHtml(
          ["标题", "正文", "接收人群", "置顶", "状态", "发布时间", "操作"],
          list.map((a) => [
            "<b>" + esc(a.title) + "</b>",
            '<div style="max-width:280px" class="small">' + esc(or(a.content, "—")) + "</div>",
            '<span class="badge gray">' + esc(AUDIENCE[a.audience] || a.audience) + "</span>",
            a.pinned ? '<span class="badge gold">置顶</span>' : '<span class="faint">—</span>',
            statusBadge(a.status, a.status === "on" ? "生效中" : "已下线"),
            '<span class="small faint nowrap">' + fmtDate(a.created_at, "time") + "</span>",
            '<div class="row" style="gap:6px;flex-wrap:nowrap">' +
              '<button class="btn btn-xs btn-outline" data-act="edit-ann" data-id="' + a.id + '">编辑</button>' +
              '<button class="btn btn-xs ' + (a.status === "on" ? "btn-outline" : "btn-ghost") + '" data-act="toggle-ann" data-id="' + a.id + '">' +
                (a.status === "on" ? "下线" : "上线") + "</button>" +
              '<button class="btn btn-xs btn-ghost" data-act="pin-ann" data-id="' + a.id + '">' +
                (a.pinned ? "取消置顶" : "置顶") + "</button>" +
              '<button class="btn btn-xs btn-danger" data-act="del-ann" data-id="' + a.id +
                '" data-title="' + esc(a.title) + '">删除</button>' +
            "</div>",
          ])
        ),
      { loading: "正在加载公告…", empty: "暂无公告", icon: "📣" }
    );

  const loadCoupons = () =>
    loadData(
      listOf("coupons"),
      () => api.get("/api/admin/coupons"),
      (list) =>
        tableHtml(
          ["券名", "减免", "门槛", "发行 / 已领", "有效期", "状态", "创建时间", "操作"],
          list.map((c) => [
            "<b>" + esc(c.name) + "</b>",
            '<span class="num bold">' + money(c.amount) + "</span>",
            '<span class="num">' + (c.threshold ? money(c.threshold) : "无门槛") + "</span>",
            '<span class="num">' + num(c.total) + " / " + num(c.claimed) + "</span>",
            '<span class="small">' + fmtDate(c.valid_from, "date") + " ~ " + fmtDate(c.valid_to, "date") + "</span>",
            statusBadge(c.status, c.status === "on" ? "生效中" : "已停用"),
            '<span class="small faint nowrap">' + fmtDate(c.created_at, "date") + "</span>",
            '<div class="row" style="gap:6px;flex-wrap:nowrap">' +
              '<button class="btn btn-xs btn-outline" data-act="edit-coupon" data-id="' + c.id + '">编辑</button>' +
              '<button class="btn btn-xs ' + (c.status === "on" ? "btn-outline" : "btn-ghost") + '" data-act="toggle-coupon" data-id="' + c.id + '">' +
                (c.status === "on" ? "停用" : "启用") + "</button>" +
            "</div>",
          ])
        ),
      { loading: "正在加载优惠券…", empty: "暂无优惠券", icon: "🎫" }
    );

  const loadAgreements = async () => {
    const contentEl = box.querySelector("[data-ag-content]");
    const timeEl = box.querySelector("[data-ag-time]");
    timeEl.textContent = "正在加载协议…";
    try {
      agreements = (await api.get("/api/admin/agreements")) || [];
      const sel = box.querySelector("[data-ag-key]");
      sel.innerHTML = agreements.length
        ? agreements.map((a) => '<option value="' + esc(a.key) + '">' + esc(a.title) + "</option>").join("")
        : '<option value="">暂无协议</option>';
      const first = agreements[0];
      contentEl.value = first ? first.content : "";
      timeEl.textContent = first ? "更新于 " + fmtDate(first.updated_at, "time") : "暂无协议文案";
    } catch (err) {
      if (err?.status === 401) return handle401();
      timeEl.innerHTML = '<span style="color:var(--danger)">加载失败：' + esc(err?.message || "") +
        '</span> <button class="btn btn-xs btn-outline" data-act="reload-ag">重试</button>';
    }
  };

  box.querySelector("[data-ag-key]")?.addEventListener("change", (e) => {
    const a = agreements.find((x) => x.key === e.target.value);
    box.querySelector("[data-ag-content]").value = a ? a.content : "";
    box.querySelector("[data-ag-time]").textContent = a ? "更新于 " + fmtDate(a.updated_at, "time") : "";
  });

  const submit = async (form, fn) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      try {
        await busy(btn, async () => {
          await fn(form.elements);
          toastOk("已保存");
          form.reset();
        });
      } catch (err) {
        if (err?.status === 401) return handle401();
        toastErr(err?.message || "保存失败");
      }
    });
  };

  // 编辑弹窗使用模块级 formDialog（见文件头部）

  submit(box.querySelector('[data-form="banner"]'), async (f) => {
    if (!f.title.value.trim()) throw new Error("请填写 Banner 标题");
    await api.post("/api/admin/banners", {
      title: f.title.value.trim(),
      image: f.image.value.trim(),
      link: f.link.value.trim(),
      sort: Number(f.sort.value || 0),
      status: f.status.value,
    });
    await loadBanners();
  });

  submit(box.querySelector('[data-form="announcement"]'), async (f) => {
    if (!f.title.value.trim()) throw new Error("请填写公告标题");
    await api.post("/api/admin/announcements", {
      title: f.title.value.trim(),
      content: f.content.value.trim(),
      audience: f.audience.value,
      pinned: f.pinned.checked,
      push: f.push.checked,
      status: "on",
    });
    await loadAnnouncements();
  });

  submit(box.querySelector('[data-form="coupon"]'), async (f) => {
    if (!f.name.value.trim()) throw new Error("请填写券名");
    const amount = cents(f.amount.value);
    if (!(amount > 0)) throw new Error("减免金额需大于 0");
    await api.post("/api/admin/coupons", {
      name: f.name.value.trim(),
      amount,
      threshold: cents(f.threshold.value),
      total: Number(f.total.value || 0),
      validFrom: f.validFrom.value || null,
      validTo: f.validTo.value || null,
      status: "on",
    });
    await loadCoupons();
  });

  bindActions(box, {
    "reload-ag": () => loadAgreements(),

    "edit-banner": async (btn) => {
      const list = (await api.get("/api/admin/banners")) || [];
      const b = list.find((x) => String(x.id) === String(btn.dataset.id));
      if (!b) return toastErr("Banner 不存在");
      const v = await formDialog("编辑 Banner", [
        { key: "title", label: "标题", value: b.title },
        { key: "image", label: "图片地址", value: b.image, placeholder: "https://… 或 /uploads/xxx.png" },
        { key: "link", label: "跳转链接", value: b.link, placeholder: "/parent 或 /parent#/plaza" },
        { key: "sort", label: "排序（越小越靠前）", type: "number", value: b.sort },
        { key: "status", label: "状态", type: "select", value: b.status, options: [{ value: "on", label: "上架" }, { value: "off", label: "停用" }] },
      ]);
      if (!v) return;
      await busy(btn, async () => {
        await api.put("/api/admin/banners/" + b.id, v);
        toastOk("Banner 已更新");
        await loadBanners();
      });
    },
    "toggle-banner": async (btn) => {
      await busy(btn, async () => {
        const r = await api.post("/api/admin/banners/" + btn.dataset.id + "/toggle", {});
        toastOk(r.status === "on" ? "Banner 已上架" : "Banner 已停用");
        await loadBanners();
      });
    },

    "edit-ann": async (btn) => {
      const list = (await api.get("/api/admin/announcements")) || [];
      const a = list.find((x) => String(x.id) === String(btn.dataset.id));
      if (!a) return toastErr("公告不存在");
      const v = await formDialog("编辑公告", [
        { key: "title", label: "标题", value: a.title },
        { key: "content", label: "正文", type: "textarea", value: a.content },
        {
          key: "audience", label: "接收人群", type: "select", value: a.audience,
          options: Object.keys(AUDIENCE).map((k) => ({ value: k, label: AUDIENCE[k] })),
        },
        { key: "pinned", label: "置顶", type: "select", value: a.pinned ? "1" : "0", options: [{ value: "1", label: "置顶" }, { value: "0", label: "不置顶" }] },
        { key: "status", label: "状态", type: "select", value: a.status, options: [{ value: "on", label: "生效中" }, { value: "off", label: "已下线" }] },
      ]);
      if (!v) return;
      v.pinned = v.pinned === "1";
      await busy(btn, async () => {
        await api.put("/api/admin/announcements/" + a.id, v);
        toastOk("公告已更新");
        await loadAnnouncements();
      });
    },
    "toggle-ann": async (btn) => {
      await busy(btn, async () => {
        const r = await api.post("/api/admin/announcements/" + btn.dataset.id + "/toggle", {});
        toastOk(r.status === "on" ? "公告已上线" : "公告已下线");
        await loadAnnouncements();
      });
    },
    "pin-ann": async (btn) => {
      await busy(btn, async () => {
        const r = await api.post("/api/admin/announcements/" + btn.dataset.id + "/pin", {});
        toastOk(r.pinned ? "已置顶" : "已取消置顶");
        await loadAnnouncements();
      });
    },

    "edit-coupon": async (btn) => {
      const list = (await api.get("/api/admin/coupons")) || [];
      const c = list.find((x) => String(x.id) === String(btn.dataset.id));
      if (!c) return toastErr("优惠券不存在");
      const v = await formDialog("编辑优惠券", [
        { key: "name", label: "券名", value: c.name },
        { key: "amount", label: "减免金额（元）", type: "number", value: yuan(c.amount) },
        { key: "threshold", label: "使用门槛（元，0 为无门槛）", type: "number", value: yuan(c.threshold) },
        { key: "total", label: "发行总量（0 为不限量）", type: "number", value: c.total },
        { key: "validFrom", label: "生效日期", type: "date", value: (c.valid_from || "").slice(0, 10) },
        { key: "validTo", label: "失效日期", type: "date", value: (c.valid_to || "").slice(0, 10) },
        { key: "status", label: "状态", type: "select", value: c.status, options: [{ value: "on", label: "生效中" }, { value: "off", label: "已停用" }] },
      ]);
      if (!v) return;
      v.amount = cents(v.amount);
      v.threshold = cents(v.threshold);
      await busy(btn, async () => {
        await api.put("/api/admin/coupons/" + c.id, v);
        toastOk("优惠券已更新");
        await loadCoupons();
      });
    },
    "toggle-coupon": async (btn) => {
      await busy(btn, async () => {
        const r = await api.post("/api/admin/coupons/" + btn.dataset.id + "/toggle", {});
        toastOk(r.status === "on" ? "优惠券已启用" : "优惠券已停用，家长端不再展示");
        await loadCoupons();
      });
    },

    "del-banner": async (btn) => {
      const ok = await confirmDialog("删除 Banner", "删除「" + btn.dataset.title + "」后家长端将立即不再展示，且不可恢复。", "删除", true);
      if (!ok) return;
      await busy(btn, async () => {
        await api.del("/api/admin/banners/" + btn.dataset.id);
        toastOk("已删除");
        await loadBanners();
      });
    },
    "del-ann": async (btn) => {
      const ok = await confirmDialog("删除公告", "删除「" + btn.dataset.title + "」后所有端将不再展示该公告。", "删除", true);
      if (!ok) return;
      await busy(btn, async () => {
        await api.del("/api/admin/announcements/" + btn.dataset.id);
        toastOk("已删除");
        await loadAnnouncements();
      });
    },
    "save-agreement": async (btn) => {
      const key = box.querySelector("[data-ag-key]").value;
      if (!key) return toastErr("请选择协议");
      await busy(btn, async () => {
        await api.put("/api/admin/agreements/" + encodeURIComponent(key), {
          content: box.querySelector("[data-ag-content]").value,
        });
        toastOk("协议文案已保存");
        await loadAgreements();
      });
    },
  });

  await Promise.all([loadBanners(), loadAnnouncements(), loadCoupons(), loadAgreements()]);
}

/* ============================================================
   系统组：管理员 / 操作日志 / 基础参数
   ============================================================ */

function logDetailHtml(detail) {
  if (!detail) return '<span class="faint small">—</span>';
  let text = detail;
  try {
    text = JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    /* 保留原文 */
  }
  return '<details class="log-detail"><summary>查看详情</summary><pre>' + esc(text) + "</pre></details>";
}

async function viewSystem(root) {
  const box = paint(root, `
    <div class="pc-grid c2">
      <div class="pc-card" style="margin-bottom:0">
        <h3>🔧 管理员账号<span class="more" data-admin-count>—</span></h3>
        <div data-admins></div>
      </div>
      <div class="pc-card" style="margin-bottom:0">
        <h3>＋ 新增管理员</h3>
        <form data-form-admin autocomplete="off">
          <div class="form-grid">
            <div class="field"><label>姓名 <span class="req">*</span></label><input class="input" name="nickname" placeholder="管理员姓名"></div>
            <div class="field"><label>手机号 <span class="req">*</span></label><input class="input" name="phone" inputmode="numeric" maxlength="11" placeholder="11 位手机号"></div>
            <div class="field" style="grid-column:1/-1"><label>初始口令</label><input class="input" name="password" type="text" value="a123456" placeholder="至少 6 位"></div>
          </div>
          <div class="hint muted mt12">管理员拥有全部后台权限，请仅在必要时新增；新增动作会写入操作日志。</div>
          <div class="row mt12"><button class="btn btn-sm btn-primary" type="submit">创建管理员</button></div>
          <div data-admin-result class="mt12"></div>
        </form>
      </div>
    </div>
    <div class="pc-card mt16">
      <h3>📜 操作日志<span class="more" data-log-count>—</span></h3>
      <div class="pc-toolbar">
        <input class="input" data-log-kw placeholder="搜索动作 / 目标 / 操作人" style="min-width:240px">
        <select class="select" data-log-role>
          <option value="">全部角色</option>
          ${PROVIDER_ROLE_ORDER.map((r) => `<option value="${r}">${ROLE[r]}</option>`).join("")}
        </select>
        <span class="faint small">最近 300 条，详情可展开查看 JSON</span>
      </div>
      <div data-logs class="scroll-y"></div>
    </div>
    <div class="pc-card">
      <h3>⚙️ 基础参数（platforms 规则组）<span class="more"><a href="#/rules?grp=${encodeURIComponent("基础参数")}">去规则中心修改 →</a></span></h3>
      <div data-platforms></div>
    </div>`);

  const adminEl = box.querySelector("[data-admins]");

  // 删除管理员：有审计/审批痕迹 → 服务端软删并匿名化；完全空白 → 物理删。口径与正式实现一致。
  bindActions(box, {
    "del-admin": async (btn) => {
      const name = btn.dataset.name || "该管理员";
      const sure = await confirmDialog(
        "删除管理员",
        "将删除后台账号「" + name + "」。若该账号产生过操作日志 / 提现审批 / 发票受理，则改为禁用并清空手机号等个人信息（历史记录里显示为「已删除管理员」）；完全没留下痕迹的账号直接物理删除。此操作不可恢复，也不影响家长、教员等业务账号。",
        "删除",
        true
      );
      if (!sure) return;
      await busy(btn, async () => {
        const r = await api.del("/api/admin/admins/" + btn.dataset.id);
        const kept = (r.kept || []).join("、");
        toastOk(r.mode === "hard" ? "已彻底删除该管理员账号" : "已删除并匿名化（保留下辖记录：" + kept + "）");
        await loadAdmins();
      });
    },
  });

  const logEl = box.querySelector("[data-logs]");
  let logs = [];

  const paintLogs = () => {
    const kw = box.querySelector("[data-log-kw]").value.trim().toLowerCase();
    const role = box.querySelector("[data-log-role]").value;
    const shown = logs.filter((l) => {
      if (role && l.actor_role !== role) return false;
      if (!kw) return true;
      return [l.action, l.target, l.nickname, l.detail].some((v) => String(v || "").toLowerCase().includes(kw));
    });
    box.querySelector("[data-log-count]").textContent = "显示 " + num(shown.length) + " / " + num(logs.length) + " 条";
    logEl.innerHTML = shown.length
      ? tableHtml(
          ["操作人", "角色", "动作", "目标", "详情", "IP", "时间"],
          shown.map((l) => [
            "<b>" + esc(or(l.nickname, "系统")) + "</b>",
            '<span class="badge gray">' + esc(ROLE[l.actor_role] || or(l.actor_role, "系统")) + "</span>",
            '<span class="mono">' + esc(l.action) + "</span>",
            '<span class="mono">' + esc(or(l.target, "—")) + "</span>",
            logDetailHtml(l.detail),
            '<span class="mono">' + esc(or(l.ip, "—")) + "</span>",
            '<span class="small faint nowrap">' + fmtDate(l.created_at, "time") + "</span>",
          ])
        )
      : emptyHtml("没有匹配的日志", "🔍");
  };

  const loadAdmins = () =>
    loadData(
      adminEl,
      () => api.get("/api/admin/admins"),
      (list) => {
        box.querySelector("[data-admin-count]").textContent = "共 " + num(list.length) + " 位";
        return tableHtml(
          ["ID", "姓名", "手机号", "状态", "创建时间", "操作"],
          list.map((a) => [
            '<span class="faint num">#' + a.id + "</span>",
            "<b>" + esc(a.nickname) + "</b>",
            '<span class="mono">' + esc(or(a.phone)) + "</span>",
            statusBadge(a.status, a.status === "active" ? "正常" : "已禁用"),
            '<span class="small faint nowrap">' + fmtDate(a.created_at, "date") + "</span>",
            Number(a.id) === Number(session.user?.id)
              ? '<span class="tiny faint nowrap">当前账号</span>'
              : '<button class="btn btn-sm btn-outline" data-act="del-admin" data-id="' + a.id +
                '" data-name="' + esc(a.nickname) + '">删除</button>',
          ])
        );
      },
      { loading: "正在加载管理员…", empty: "暂无管理员", icon: "🔧" }
    );

  const loadLogs = async () => {
    logEl.innerHTML = loadingHtml("正在加载操作日志…");
    try {
      logs = (await api.get("/api/admin/audit-logs", { page: 1, pageSize: 300 })).list || [];
      paintLogs();
    } catch (err) {
      if (err?.status === 401) return handle401();
      logEl.innerHTML = errorHtml(err);
      const b = logEl.querySelector("[data-retry]");
      if (b) b.onclick = loadLogs;
    }
  };

  const loadPlatforms = async () => {
    const el = box.querySelector("[data-platforms]");
    el.innerHTML = loadingHtml("正在加载基础参数…");
    try {
      const rules = await api.get("/api/admin/rules");
      const platforms = (rules.rules || []).find((r) => r.key === "platforms");
      el.innerHTML = platforms
        ? '<div class="form-grid">' +
          Object.entries(platforms.value || {}).map(([k, v]) =>
            '<div><div class="tiny faint">' + esc(labelOf(k)) + '</div><div class="small bold">' + esc(or(v, "—")) + "</div></div>"
          ).join("") +
          '</div><div class="hint muted mt12">平台名称、运营城市与合规提示属于基础参数，修改后各端立即生效。</div>'
        : emptyHtml("未找到 platforms 规则组", "⚙️");
    } catch (err) {
      if (err?.status === 401) return handle401();
      el.innerHTML = errorHtml(err);
      const b = el.querySelector("[data-retry]");
      if (b) b.onclick = loadPlatforms;
    }
  };

  box.querySelector("[data-form-admin]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type="submit"]');
    const f = form.elements;
    const nickname = f.nickname.value.trim();
    const phone = f.phone.value.trim();
    const password = f.password.value;
    if (!nickname) return toastErr("请填写管理员姓名");
    if (!/^1\d{10}$/.test(phone)) return toastErr("请输入正确的 11 位手机号");
    if (String(password).length < 6) return toastErr("初始口令至少 6 位");
    const ok = await confirmDialog("创建管理员", "该账号将拥有后台全部权限：规则配置、资金审核、风控仲裁等。", "确认创建");
    if (!ok) return;
    await busy(btn, async () => {
      const d = await api.post("/api/admin/admins", { nickname, phone, password });
      box.querySelector("[data-admin-result]").innerHTML =
        '<div class="hint green">管理员「' + esc(nickname) + "」已创建（ID #" + esc(d.id) + "），请转交账号与初始口令。</div>";
      toastOk("管理员已创建");
      form.reset();
      form.elements.password.value = "a123456";
      await loadAdmins();
      await loadLogs();
    });
  });

  box.querySelector("[data-log-kw]").addEventListener("input", paintLogs);
  box.querySelector("[data-log-role]").addEventListener("change", paintLogs);

  await Promise.all([loadAdmins(), loadLogs(), loadPlatforms()]);
}

/* ============================================================
   路由与启动
   ============================================================ */

const ROUTES = {
  "/": { title: "数据总览", sub: "经营大盘 · 待办 · 趋势", view: viewDashboard },
  "/users": { title: "用户管理", sub: "全角色账号与档案", view: viewUsers },
  "/audit": { title: "教员资质审核", sub: "材料核验与准入", view: viewAudit },
  "/levels": { title: "教员等级调整", sub: "成长分与抽佣等级", view: viewLevels },
  "/agents": { title: "区域与代理", sub: "电子围栏 · 签约 · 分成", view: viewAgents },
  "/orders": { title: "订单与需求", sub: "筛选 · 改价 · 关闭 · 需求池", view: viewOrders },
  "/refunds": { title: "退款工单", sub: "退款审核与资金回流", view: viewRefunds },
  "/rules": { title: "规则配置中心", sub: "13 组规则热更新", view: viewRules },
  "/finance": { title: "财务资金", sub: "担保台账 · 提现 · 对账", view: viewFinance },
  "/risk": { title: "风控与审核", sub: "异常订单 · 差评仲裁 · 客诉终审", view: viewRisk },
  "/ops": { title: "运营工具", sub: "Banner · 公告 · 优惠券 · 协议", view: viewOps },
  "/system": { title: "系统设置", sub: "管理员 · 操作日志 · 基础参数", view: viewSystem },
};

let router = null;

function getRouter() {
  if (!router) {
    const map = {};
    Object.keys(ROUTES).forEach((path) => {
      const meta = ROUTES[path];
      map[path] = async (ctx) => {
        renderChrome(path);
        await meta.view($route(), ctx);
      };
    });
    router = createRouter(map, { container: $route() });
  }
  return router;
}

/** 登录成功后（或已登录刷新页面）启动：渲染骨架 + 当前路由 + 待办计数 */
function boot() {
  if (!document.getElementById("side").innerHTML) document.getElementById("side").innerHTML = sideHtml();
  getRouter().render();
  syncPending();
}

if (session.token) {
  boot();
} else {
  showLogin();
}

