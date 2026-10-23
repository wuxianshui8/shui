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
    const need = ["pages/login/index", "pages/parent/index", "pages/parent/publish/index", "pages/teacher/index",
      "pages/teacher/wallet/index", "pages/teacher/apply/index", "pages/sales/index", "pages/sales/rewards/index",
      "pages/agent/index", "pages/agent/complaints/index", "pages/messages/index"];
    const lack = need.filter((p) => !(appJson.pages || []).includes(p));
    assert(lack.length === 0, "小程序页面与 H5 一致（含发需求页与入驻认证页）" + (lack.length ? "，缺 " + lack.join(",") : ""));
    assert(existsSync(mp + "/pages/parent/publish/index.wxml"), "小程序页面产物为 wxml/wxss（真实小程序工程）");
    assert(existsSync(mp + "/pages/teacher/apply/index.wxml"), "小程序入驻认证页也有产物（wxml）");
    const teacherWxml = readFileSync(mp + "/pages/teacher/index.wxml", "utf8");
    const teacherJs = readFileSync(mp + "/pages/teacher/index.js", "utf8");
    assert(teacherWxml.includes("附近需求") && teacherJs.includes("重新定位") && teacherJs.includes("nearby-demands"),
      "小程序教员首页含「重新定位」与附近需求入口（定位接单）");
  }
}

console.log("\n== 2. 角色路由回落（history 模式） ==");
for (const [p, label] of [["/m/", "家长端（游客首页，无需登录）"], ["/m/pages/parent/index", "家长端"], ["/m/pages/login/index", "登录页"], ["/m/pages/parent/publish/index", "发布需求页"], ["/m/pages/teacher/index", "教员端"], ["/m/pages/teacher/wallet/index", "教员钱包页"], ["/m/pages/teacher/apply/index", "教员入驻认证页"], ["/m/pages/sales/index", "业务员端"], ["/m/pages/agent/index", "代理端"], ["/m/pages/sales/rewards/index", "业务员奖励明细页"], ["/m/pages/agent/complaints/index", "代理客诉工单页"], ["/m/pages/messages/index", "消息中心页"]]) {
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
