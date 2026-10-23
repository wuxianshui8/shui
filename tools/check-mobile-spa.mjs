// ============================================================
// 移动端（uni-app H5，家长 / 教员 / 业务员 / 区域代理）验收
//   1. /m/ 产物可达，入口与分包 JS/CSS 均 200
//   2. 四个角色页面依赖的接口逐一联调
// 用法：由 tools/gate-p8.mjs 在同批次起服务后调用
// ============================================================
const BASE = process.env.BASE_URL || "http://localhost:4300";
const PW = "a123456";
let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, extra = "") {
  if (cond) { pass++; console.log("  ✓ " + name + (extra ? "  " + extra : "")); }
  else { fail++; failures.push(name); console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
async function api(method, path, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + "/api" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, body: json, text };
}

console.log("移动端验收（uni-app H5）");
console.log("目标服务：" + BASE + "\n");

console.log("== 1. uni-app H5 构建产物 ==");
const idx = await fetch(BASE + "/m/");
const html = await idx.text();
assert(idx.status === 200, "GET /m/ 返回 200（" + idx.headers.get("content-type") + "）");
assert(html.includes('id="app"'), "返回 uni-app H5 挂载点");
assert(/\/m\/assets\/index-[A-Za-z0-9_-]+\.js/.test(html), "入口 JS 使用 /m/ 基路径");

const assets = [...html.matchAll(/(?:src|href)="(\/m\/assets\/[^"]+)"/g)].map((m) => m[1]);
assert(assets.length >= 2, "解析到 " + assets.length + " 个静态资源");
for (const p of assets) {
  const r = await fetch(BASE + p);
  const ct = r.headers.get("content-type") || "";
  assert(r.status === 200 && /javascript|css/.test(ct), "静态资源可访问：" + p.replace("/m/assets/", "") + "（" + ct.split(";")[0] + "）");
}

// 四个角色分包（uni-app 按页面分包产出）
const pages = ["pages-login-index", "pages-parent-index", "pages-teacher-index", "pages-sales-index", "pages-agent-index"];

// 多端产物：uni-app 同时产出 H5 与微信小程序
{
  const { existsSync, readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const mp = fileURLToPath(new URL("../apps/web-mobile/dist/build/mp-weixin", import.meta.url));
  assert(existsSync(mp + "/app.json"), "已产出微信小程序构建目录（mp-weixin/app.json）");
  if (existsSync(mp + "/app.json")) {
    const appJson = JSON.parse(readFileSync(mp + "/app.json", "utf8"));
    assert(Array.isArray(appJson.pages) && appJson.pages.length >= 6, "小程序 app.json 注册 " + (appJson.pages || []).length + " 个页面");
    const need = ["pages/login/index", "pages/parent/index", "pages/parent/publish/index",
      "pages/parent/teachers/index", "pages/parent/teacher/index", "pages/parent/order/index", "pages/teacher/index",
      "pages/teacher/wallet/index", "pages/teacher/apply/index", "pages/sales/index", "pages/sales/rewards/index",
      "pages/agent/index", "pages/agent/complaints/index", "pages/messages/index"];
    const lack = need.filter((p) => !(appJson.pages || []).includes(p));
    assert(lack.length === 0, "小程序页面与 H5 一致（含发需求页 / 附近教员 / 教员详情 / 订单详情 / 入驻认证）" + (lack.length ? "，缺 " + lack.join(",") : ""));
    assert(existsSync(mp + "/pages/parent/teacher/index.wxml") && existsSync(mp + "/pages/parent/order/index.wxml"),
      "「立即预约」与「订单详情」在小程序侧也有产物（wxml）");
    assert(existsSync(mp + "/pages/parent/publish/index.wxml"), "小程序页面产物为 wxml/wxss（真实小程序工程）");
    assert(existsSync(mp + "/pages/teacher/apply/index.wxml"), "小程序入驻认证页也有产物（wxml）");
    const teacherWxml = readFileSync(mp + "/pages/teacher/index.wxml", "utf8");
    const teacherJs = readFileSync(mp + "/pages/teacher/index.js", "utf8");
    assert(teacherWxml.includes("附近需求") && teacherJs.includes("重新定位") && teacherJs.includes("nearby-demands"),
      "小程序教员首页含「重新定位」与附近需求入口（定位接单）");
  }
}

console.log("\n== 2. 角色路由回落（history 模式） ==");
for (const [p, label] of [["/m/", "家长端（游客首页，无需登录）"], ["/m/pages/parent/index", "家长端"], ["/m/pages/login/index", "登录页"], ["/m/pages/parent/publish/index", "发布需求页"], ["/m/pages/parent/teachers/index", "附近教员页"], ["/m/pages/parent/teacher/index", "教员详情（立即预约）"], ["/m/pages/parent/order/index", "订单详情页"], ["/m/pages/teacher/index", "教员端"], ["/m/pages/teacher/wallet/index", "教员钱包页"], ["/m/pages/teacher/apply/index", "教员入驻认证页"], ["/m/pages/sales/index", "业务员端"], ["/m/pages/agent/index", "代理端"], ["/m/pages/sales/rewards/index", "业务员奖励明细页"], ["/m/pages/agent/complaints/index", "代理客诉工单页"], ["/m/pages/messages/index", "消息中心页"]]) {
  const r = await fetch(BASE + p);
  const t = await r.text();
  assert(r.status === 200 && t.includes('id="app"'), label + "路由可直达并回落 index.html");
}

console.log("\n== 3. 四个角色页面依赖的接口 ==");
const roles = [
  { phone: "13900000301", role: "parent", label: "家长端", paths: ["/parent/home?lat=30.262&lng=120.133", "/parent/orders", "/messages"] },
  { phone: "13900000201", role: "teacher", label: "教员端", paths: ["/teacher/dashboard", "/teacher/level", "/teacher/nearby-demands", "/wallet", "/withdrawals", "/teacher/profile"] },
  { phone: "13900000101", role: "sales", label: "业务员端", paths: ["/sales/dashboard", "/sales/customers", "/sales/rewards"] },
  { phone: "13900000010", role: "agent", label: "区域代理端", paths: ["/agent/dashboard", "/agent/orders", "/agent/complaints"] },
];
for (const r of roles) {
  const login = await api("POST", "/auth/login-password", { body: { phone: r.phone, password: PW } });
  assert(login.status === 200 && login.body.data.user.role === r.role, "登录页 → " + r.label + "（角色 " + r.role + "）");
  const token = login.body.data.token;
  for (const p of r.paths) {
    const res = await api("GET", p, { token });
    assert(res.status === 200 && res.body.code === 0, r.label + "：" + p.split("?")[0] + " 契约正常");
  }
}

/* 教员端抢单按钮链路 */
const teacher = await api("POST", "/auth/login-password", { body: { phone: "13900000201", password: PW } });
const parent = await api("POST", "/auth/login-password", { body: { phone: "13900000301", password: PW } });
const demand = await api("POST", "/demands", {
  token: parent.body.data.token,
  body: { stage: "初中", subject: "数学", address: "西湖区文三路 128 号", lat: 30.262, lng: 120.133, budget: 16000, remark: "移动端抢单验证" },
});
const grab = await api("POST", "/demands/" + demand.body.data.id + "/apply", { token: teacher.body.data.token });
assert(grab.status === 200 && grab.body.data.applicationId > 0, "教员端：附近需求「抢单」按钮闭环（报名 ID " + grab.body.data?.applicationId + "）");

/* 定位接单（P48）：附近需求按「手机实时定位」算距离，不传则回落到入驻服务基点 */
const nearLoc = await api("GET", "/teacher/nearby-demands?lat=30.2620&lng=120.1330", { token: teacher.body.data.token });
assert(nearLoc.status === 200 && nearLoc.body.data.origin?.source === "current" && nearLoc.body.data.radiusKm > 0,
  "教员端：按实时定位取附近需求（半径 " + nearLoc.body.data.radiusKm + " km，" + (nearLoc.body.data.list || []).length + " 条）");
const nearBase = await api("GET", "/teacher/nearby-demands", { token: teacher.body.data.token });
assert(nearBase.status === 200 && nearBase.body.data.origin?.source === "profile",
  "教员端：定位不可用时回落到入驻服务基点（页面会提示「按入驻服务基点」）");

/* 教员钱包页：最低提现规则由 settlement 规则驱动（页面提交按钮同此接口） */
const belowMin = await api("POST", "/withdrawals", {
  token: teacher.body.data.token,
  body: { amount: 1, account: "wx_teacher_test" },
});
assert(belowMin.status === 400 && /最低提现/.test(belowMin.body?.message || ""),
  "教员钱包页：低于最低提现额的申请被拒（" + (belowMin.body?.message || belowMin.status) + "）");
const wallet = await api("GET", "/wallet", { token: teacher.body.data.token });
assert(wallet.status === 200 && wallet.body.data.wallet && Array.isArray(wallet.body.data.txns),
  "教员钱包页：钱包快照含余额 ¥" + ((wallet.body.data?.wallet?.balance || 0) / 100).toFixed(2) + " 与流水 " + (wallet.body.data?.txns?.length || 0) + " 条");

console.log("\n== 4. 游客浏览 + 微信一键登录（P55） ==");
// H5 产物里要能看到游客优先的痕迹：「微信一键登录」按钮、公开首页接口、登录后自动发布的草稿键
// 注意：页面 chunk 是路由懒加载的，不在 index.html 的资源列表里，必须直接扫 dist 目录
{
  const { readdirSync, readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const h5Assets = fileURLToPath(new URL("../apps/web-mobile/dist/build/h5/assets", import.meta.url));
  const jsFiles = readdirSync(h5Assets).filter((f) => f.endsWith(".js"));
  const bundle = jsFiles.map((f) => readFileSync(h5Assets + "/" + f, "utf8")).join("\n");
  assert(jsFiles.length >= 8, "H5 分包产物齐全（" + jsFiles.length + " 个 JS）");
  assert(bundle.includes("微信一键登录"), "H5 产物包含「微信一键登录」按钮（登录页已加）");
  assert(bundle.includes("/public/home"), "H5 产物使用公开首页接口（游客无需登录即可看发布需求页）");
  assert(bundle.includes("pendingDemand"), "H5 产物带「登录后自动继续发布」的草稿逻辑");
  assert(bundle.includes("/parent/avatar") && bundle.includes("my-avatar"), "H5 产物带家长头像上传（chooseImage → /parent/avatar）");
  // 入驻/资料修改页：资质材料按身份只显示一张证书，且排在提交按钮上面，图片用背景图自适应
  assert(bundle.includes("教师资格证") && bundle.includes("学生证") && bundle.includes("技能证书"),
    "H5 产物按身份类型区分证书（在职教师→教师资格证 / 学生→学生证 / 社会→技能证书）");
  assert(bundle.includes("资质材料"), "H5 产物有「资质材料」版块");
  assert(bundle.includes("backgroundImage"), "上传后的证件图用背景图渲染（框内 background-size: cover 自适应）");
  assert(bundle.includes("/auth/login-account") && bundle.includes("手机号 / 用户名"), "移动端登录页支持「手机号 / 用户名 + 口令」登录");
  // 家长端「立即预约 + 订单详情」：三个新页面的骨架与接口契约要真的被打包进去
  assert(bundle.includes("/orders/from-service") && bundle.includes("立即预约"), "H5 产物含家长端「立即预约」（POST /orders/from-service）");
  assert(bundle.includes("可预约服务") && bundle.includes("提交预约并去支付"), "预约表单含服务选择与提交按钮");
  assert(bundle.includes("申请取消订单") && bundle.includes("确认完成上课"), "订单详情页含「申请取消 / 确认完成」操作");
  assert(bundle.includes("待教员确认") || bundle.includes("等待教员确认"), "订单详情显示「取消申请等教员确认」状态");
  assert(!/登录成功后.*跳转登录页/.test(bundle), "没有把游客强制踢回登录页的旧逻辑");
  // 排版口径（用户反馈）：登录页里「微信一键登录」排在「登录 / 注册」下面，不是压在最上面
  {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const loginVue = readFileSync(
      fileURLToPath(new URL("../apps/web-mobile/src/pages/login/index.vue", import.meta.url)),
      "utf8",
    );
    // 只在 <template> 里比顺序（脚本里也有「微信一键登录」的注释，按全文比会误判）
    const tpl = loginVue.slice(loginVue.indexOf("<template>"), loginVue.indexOf("</template>"));
    const loginAt = tpl.indexOf("登录 / 注册");
    const wxAt = tpl.indexOf("微信一键登录");
    assert(loginAt > 0 && wxAt > loginAt, "移动端登录页排版：登录 / 注册在上、微信一键登录在其下方");
    assert(!/微信一键登录放在最上面/.test(loginVue), "登录页不再把微信按钮顶到最前");
  }
}
// 游客接口：不发 token 也要能拿到首页与教员列表
const guestHome = await api("GET", "/public/home?lat=30.262&lng=120.133");
assert(guestHome.status === 200 && guestHome.body.data && guestHome.body.data.guest === true,
  "游客首页 /public/home 无需登录（片区 " + (guestHome.body.data?.region?.name || "未开通") + "）");
assert(guestHome.body.data && guestHome.body.data.defaultAddress === null && guestHome.body.data.couponCount === 0,
  "游客首页不下发「我的」数据（地址/优惠券/订单）");
assert(guestHome.body.data && guestHome.body.data.urgentFee > 0, "游客首页下发加急费区间（发布表单要用）");
const guestTeachers = await api("GET", "/public/teachers?radiusKm=20&pageSize=5");
assert(guestTeachers.status === 200 && Array.isArray(guestTeachers.body.data.list),
  "游客可浏览教员（" + (guestTeachers.body.data?.list || []).length + " 位，点「立即预约」才登录）");
assert((guestTeachers.body.data.list || []).every((t) => t.favorited === false), "游客浏览的收藏状态恒 false");
if ((guestTeachers.body.data.list || []).length) {
  const gd = await api("GET", "/public/teachers/" + guestTeachers.body.data.list[0].id);
  assert(gd.status === 200 && Array.isArray(gd.body.data.services), "游客可看教员详情（含可预约服务）");
}
const stillGuarded = await api("GET", "/parent/orders");
assert(stillGuarded.status === 401, "「我的订单」仍需登录（登录层在动作时弹）");

// 微信一键登录：mock 通道同 code 稳定映射同一账号
const wxCode = "mobile-gate-wx-" + Date.now();
const wx1 = await api("POST", "/auth/wechat", { body: { code: wxCode } });
assert(wx1.status === 200 && wx1.body.data.token && wx1.body.data.user.role === "parent",
  "移动端微信一键登录 → 家长 token（通道 " + (wx1.body.data?.wechatChannel || "?") + "）");
const wx2 = await api("POST", "/auth/wechat", { body: { code: wxCode } });
assert(wx2.body.data.user.id === wx1.body.data.user.id, "同一微信 code 二次登录 = 同一账号（幂等）");
const wxMe = await api("GET", "/auth/me", { token: wx1.body.data.token });
assert(wxMe.status === 200 && wxMe.body.data.user.id === wx1.body.data.user.id, "微信登录的 token 可用（/auth/me）");
const wxPublish = await api("POST", "/demands", {
  token: wx1.body.data.token,
  body: { stage: "初中", subject: "数学", address: "西湖区文三路 128 号", lat: 30.262, lng: 120.133, budget: 16000, remark: "移动端游客→登录→发布" },
});
assert(wxPublish.status === 200, "微信登录后可直接发布需求（游客填表→登录→自动发布闭环）");
assert(/^微信用户\d{4}$/.test(wx1.body.data.user.nickname || ""), "微信登录昵称稳定可复现（" + wx1.body.data.user.nickname + "）");
assert(wx2.body.data.user.nickname === wx1.body.data.user.nickname, "同一 code 二次登录昵称不变");
const wxAuth = await api("GET", "/auth/wechat/authorize-url?redirect=https://example.com/m/cb&state=s1");
assert(wxAuth.status === 400 && wxAuth.body.code === "WECHAT_NOT_CONFIGURED",
  "未配置 appid 时公众号授权链接返回 400 WECHAT_NOT_CONFIGURED（前端据此回落演示通道）");

// 家长头像：先上传图片，再把 /uploads/xxx 设为头像（只接受本站地址，任意长宽比的图在框内 aspectFill/cover 自适应）
{
  const pngDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const up = await api("POST", "/upload", { token: parent.body.data.token, body: { filename: "avatar.png", dataUrl: pngDataUrl } });
  assert(up.status === 200 && /^\/uploads\/.+\.png$/.test(up.body.data.url), "家长头像：图片可上传到 /uploads（" + (up.body.data?.url || up.status) + "）");
  const setAv = await api("PUT", "/parent/avatar", { token: parent.body.data.token, body: { avatar: up.body.data.url } });
  assert(setAv.status === 200 && setAv.body.data.hasAvatar === true && setAv.body.data.user.avatar === up.body.data.url,
    "家长头像：设置成功后 /parent/avatar 回显新头像");
  const prof = await api("GET", "/parent/profile", { token: parent.body.data.token });
  assert(prof.body.data.user.avatar === up.body.data.url, "家长头像：个人资料接口回读到新头像");
  const meAv = await api("GET", "/auth/me", { token: parent.body.data.token });
  assert(meAv.body.data.user.avatar === up.body.data.url, "家长头像：/auth/me 也带新头像（重进 App 生效）");
  const badAv = await api("PUT", "/parent/avatar", { token: parent.body.data.token, body: { avatar: "https://evil.example.com/a.png" } });
  assert(badAv.status === 400, "家长头像：外链地址被拒（只接受本站 /uploads/）", badAv.body && badAv.body.message);
  const resetAv = await api("PUT", "/parent/avatar", { token: parent.body.data.token, body: { avatar: null } });
  assert(resetAv.status === 200 && resetAv.body.data.hasAvatar === false && resetAv.body.data.user.avatar === null,
    "家长头像：传 null 可恢复默认首字母头像");
}

// 教员端「用户名 + 密码」登录（account = 用户名或手机号）
{
  const tLogin = await api("POST", "/auth/login-account", { body: { account: "zhang", password: PW } });
  assert(tLogin.status === 200 && tLogin.body.data.user.role === "teacher", "教员端用户名密码登录：zhang / a123456 → 教员 token");
  const tUpper = await api("POST", "/auth/login-account", { body: { account: "ZHANG", password: PW } });
  assert(tUpper.status === 200 && tUpper.body.data.user.id === tLogin.body.data.user.id, "用户名大小写不敏感（ZHANG = zhang）");
  const tPhone = await api("POST", "/auth/login-account", { body: { account: "13900000201", password: PW } });
  assert(tPhone.status === 200 && tPhone.body.data.user.id === tLogin.body.data.user.id, "同一接口用手机号也能登录（account 兼容手机号）");
  const tBad = await api("POST", "/auth/login-account", { body: { account: "zhang", password: "wrong-pass-1" } });
  assert(tBad.status === 400 && tBad.body.code === "BAD_CREDENTIALS", "错误密码被拒（BAD_CREDENTIALS，不泄露账号是否存在）");
  const tEmpty = await api("POST", "/auth/login-account", { body: { account: "", password: PW } });
  assert(tEmpty.status === 400, "空用户名被拒");
  const tMe = await api("GET", "/auth/me", { token: tLogin.body.data.token });
  assert(tMe.status === 200 && tMe.body.data.user.id === tLogin.body.data.user.id, "用户名登录拿到的 token 可用（/auth/me）");
}

// 家长取消订单 → 教员端「退款 / 驳回」（取消改成申请制，教员处理前不动钱）
{
  // 管理员 token 只用于读担保余额（验证退款台账闭合）
  const admin = await api("POST", "/auth/login-password", { body: { phone: "13900000001", password: PW } });
  // 造一单：家长发需求 → 教员报名 → 家长确认 → 支付
  const mk = async (remark) => {
    const d = await api("POST", "/demands", {
      token: parent.body.data.token,
      body: { stage: "初中", subject: "语文", address: "西湖区文三路 128 号", lat: 30.262, lng: 120.133, budget: 12000, remark },
    });
    await api("POST", "/demands/" + d.body.data.id + "/apply", { token: teacher.body.data.token });
    const apps = await api("GET", "/demands/" + d.body.data.id, { token: parent.body.data.token });
    const c = await api("POST", "/demands/" + d.body.data.id + "/confirm", {
      token: parent.body.data.token, body: { applicationId: apps.body.data.applications[0].id },
    });
    const oid = c.body.data.id;
    await api("POST", "/orders/" + oid + "/pay", { token: parent.body.data.token, idem: "gate-cancel-pay-" + oid });
    return oid;
  };

  // ① 家长取消 → 只提交申请，钱不动，订单仍是 pending_class
  const oid = await mk("取消申请-驳回用例");
  const reqCancel = await api("POST", "/orders/" + oid + "/cancel", { token: parent.body.data.token, body: { reason: "孩子临时有事" } });
  assert(reqCancel.status === 200 && reqCancel.body.data.cancelRequested === true,
    "家长取消已付款订单 → 变成「取消申请」（cancelRequested=true）");
  assert(reqCancel.body.data.status === "pending_class", "提交申请时不改订单状态、不退款（仍是待上课）", reqCancel.body.data.status);
  const dup = await api("POST", "/orders/" + oid + "/cancel", { token: parent.body.data.token, body: { reason: "再点一次" } });
  assert(dup.status === 400 && dup.body.code === "CANCEL_REQUESTED", "重复提交取消申请被拒（CANCEL_REQUESTED）");
  const pending = await api("GET", "/teacher/orders?pendingCancel=1", { token: teacher.body.data.token });
  assert((pending.body.data.list || []).some((o) => o.id === oid), "教员端「待处理取消」列表能看到这条申请");

  // ② 教员驳回 → 订单继续履约，理由回给家长
  const rejectNoReason = await api("POST", "/teacher/orders/" + oid + "/cancel-reject", { token: teacher.body.data.token, body: { reason: "" } });
  assert(rejectNoReason.status === 400, "驳回必须填理由（空理由 400）");
  const rejected = await api("POST", "/teacher/orders/" + oid + "/cancel-reject", {
    token: teacher.body.data.token, body: { reason: "距上课不足 2 小时，已备好课件" },
  });
  assert(rejected.status === 200 && rejected.body.data.cancelRequested === false && rejected.body.data.status === "pending_class",
    "教员驳回后订单回到正常履约（cancelRequested=false）");
  assert(rejected.body.data.cancelRejectReason && rejected.body.data.cancelRejectedAt, "驳回理由与时间已记录（家长端可见）");

  // ③ 家长再申请 → 教员同意退款 → 订单退款、担保释放
  const again = await api("POST", "/orders/" + oid + "/cancel", { token: parent.body.data.token, body: { reason: "还是要取消" } });
  assert(again.status === 200 && again.body.data.cancelRequested === true, "驳回后家长可再次提交取消申请");
  const escrowBefore = (await api("GET", "/admin/finance", { token: admin.body.data.token })).body.data.summary.escrow;
  const approved = await api("POST", "/teacher/orders/" + oid + "/cancel-approve", { token: teacher.body.data.token });
  assert(approved.status === 200 && approved.body.data.status === "refunded", "教员同意退款 → 订单转已退款");
  assert(approved.body.data.refundAmount > 0, "退款金额已写入（¥" + ((approved.body.data.refundAmount || 0) / 100).toFixed(2) + "）");
  const escrowAfter = (await api("GET", "/admin/finance", { token: admin.body.data.token })).body.data.summary.escrow;
  assert(escrowBefore - escrowAfter === approved.body.data.refundAmount, "退款同步释放担保资金（台账闭合）",
    "before=" + escrowBefore + " after=" + escrowAfter);
  const approveAgain = await api("POST", "/teacher/orders/" + oid + "/cancel-approve", { token: teacher.body.data.token });
  assert(approveAgain.status === 400, "已退款订单不能再同意一次（幂等保护）");

  // ④ 越权：别的教员不能处理
  const oid2 = await mk("取消申请-越权用例");
  await api("POST", "/orders/" + oid2 + "/cancel", { token: parent.body.data.token, body: { reason: "越权测试" } });
  const otherTeacher = await api("POST", "/auth/login-account", { body: { account: "chenzihao", password: PW } });
  const cross = await api("POST", "/teacher/orders/" + oid2 + "/cancel-approve", { token: otherTeacher.body.data.token });
  assert(cross.status === 403, "非本单教员不能替别人退款（403）", cross.status);
  const cleanup = await api("POST", "/teacher/orders/" + oid2 + "/cancel-approve", { token: teacher.body.data.token });
  assert(cleanup.status === 200, "本单教员可以处理自己的取消申请");
}

console.log("\n=================================================");
console.log("移动端验收：通过 " + pass + " 项，失败 " + fail + " 项");
if (fail) {
  console.log("失败项：");
  failures.forEach((f) => console.log("  - " + f));
  process.exitCode = 1;
} else {
  console.log("uni-app H5 产物可托管，四端页面与接口全部打通 ✅");
}
console.log("=================================================");
