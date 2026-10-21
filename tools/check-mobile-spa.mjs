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
      "pages/teacher/wallet/index", "pages/sales/index", "pages/sales/rewards/index",
      "pages/agent/index", "pages/agent/complaints/index", "pages/messages/index"];
    const lack = need.filter((p) => !(appJson.pages || []).includes(p));
    assert(lack.length === 0, "小程序页面与 H5 一致（含家长发需求页）" + (lack.length ? "，缺 " + lack.join(",") : ""));
    assert(existsSync(mp + "/pages/parent/publish/index.wxml"), "小程序页面产物为 wxml/wxss（真实小程序工程）");
  }
}

console.log("\n== 2. 角色路由回落（history 模式） ==");
for (const [p, label] of [["/m/", "登录页"], ["/m/pages/parent/index", "家长端"], ["/m/pages/teacher/index", "教员端"], ["/m/pages/teacher/wallet/index", "教员钱包页"], ["/m/pages/sales/index", "业务员端"], ["/m/pages/agent/index", "代理端"], ["/m/pages/sales/rewards/index", "业务员奖励明细页"], ["/m/pages/agent/complaints/index", "代理客诉工单页"], ["/m/pages/messages/index", "消息中心页"]]) {
  const r = await fetch(BASE + p);
  const t = await r.text();
  assert(r.status === 200 && t.includes('id="app"'), label + "路由可直达并回落 index.html");
}

console.log("\n== 3. 四个角色页面依赖的接口 ==");
const roles = [
  { phone: "13900000301", role: "parent", label: "家长端", paths: ["/parent/home?lat=30.262&lng=120.133", "/parent/orders", "/messages"] },
  { phone: "13900000201", role: "teacher", label: "教员端", paths: ["/teacher/dashboard", "/teacher/level", "/teacher/nearby-demands", "/wallet", "/withdrawals"] },
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
