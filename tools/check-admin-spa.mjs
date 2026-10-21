// ============================================================
// PC 管理后台（Vue3 + Vite + Element Plus）验收
//   1. 静态产物可达：/admin-vue/ 与全部 assets 均 200 且类型正确
//   2. SPA 所有页面依赖的后台接口逐一联调（登录 → 12 个模块）
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


// 构建产物包含全部页面分包（本地读取 dist 校验，覆盖菜单里的 15 个页面）
{
  const { readdirSync } = await import("node:fs");
  const distAssets = readdirSync(new URL("../apps/web-admin/dist/assets", import.meta.url));
  const views = ["Login", "Overview", "Orders", "Refunds", "Finance", "Withdrawals", "Invoices",
    "Users", "Teachers", "Agents", "Regions", "Rules", "Ops", "Risks", "Logs"];
  const missing = views.filter((v) => !distAssets.some((f) => f.startsWith(v + "-")));
  assert(missing.length === 0, "构建产物含 " + views.length + " 个页面分包" + (missing.length ? "，缺失 " + missing.join(",") : ""));
}
console.log("PC 管理后台验收（Vue3 + Vite + Element Plus）");
console.log("目标服务：" + BASE + "\n");

/* ---------- 1. 静态产物 ---------- */
console.log("== 1. 前端构建产物托管 ==");
const indexRes = await fetch(BASE + "/admin-vue/");
const indexHtml = await indexRes.text();
assert(indexRes.status === 200, "GET /admin-vue/ 返回 200（" + indexRes.headers.get("content-type") + "）");
assert(indexHtml.includes('id="app"'), "返回 SPA 挂载点 index.html");
assert(/assets\/index-[A-Za-z0-9_-]+\.js/.test(indexHtml), "引用了 Vite 构建产物（带 hash 的 JS）");
assert(/assets\/index-[A-Za-z0-9_-]+\.css/.test(indexHtml), "引用了 Element Plus 样式产物");

const assetPaths = [...indexHtml.matchAll(/(?:src|href)="(\/admin-vue\/assets\/[^"]+)"/g)].map((m) => m[1]);
assert(assetPaths.length >= 2, "解析到 " + assetPaths.length + " 个静态资源");
for (const p of assetPaths) {
  const r = await fetch(BASE + p);
  const ct = r.headers.get("content-type") || "";
  assert(r.status === 200 && /javascript|css/.test(ct), "静态资源可访问：" + p.replace("/admin-vue/assets/", "") + "（" + ct.split(";")[0] + "）");
}

/* ---------- 2. 页面依赖接口联调 ---------- */
console.log("\n== 2. 13 个页面依赖的后台接口 ==");
const login = await api("POST", "/auth/login-password", { body: { phone: "13900000001", password: PW } });
assert(login.status === 200 && login.body.data.user.role === "admin", "登录页：管理员登录成功");
const token = login.body.data.token;

const endpoints = [
  ["/admin/overview", "总览页"],
  ["/admin/orders?page=1&pageSize=10", "订单管理页"],
  ["/admin/refunds", "退款工单页"],
  ["/admin/finance", "财务资金页"],
  ["/admin/users?page=1&pageSize=10", "用户管理页"],
  ["/admin/teachers/pending", "教员审核页"],
  ["/admin/agents", "代理管理页"],
  ["/admin/regions", "区域管理页"],
  ["/admin/rules", "规则配置中心页"],
  ["/admin/banners", "运营工具·Banner"],
  ["/admin/announcements", "运营工具·公告"],
  ["/admin/coupons", "运营工具·优惠券"],
  ["/admin/risks", "风控与仲裁页"],
  ["/admin/audit-logs?page=1&pageSize=20", "操作日志页"],
];
for (const [path, name] of endpoints) {
  const r = await api("GET", path, { token });
  assert(r.status === 200 && r.body.code === 0, name + "：" + path + " 契约正常");
}

/* 区域管理页写操作闭环（新建片区 → 列表可见） */
const regionCreate = await api("POST", "/admin/regions", {
  token,
  body: { name: "临平片区验收", centerLat: 30.42, centerLng: 120.3, radiusKm: 6 },
});
assert(regionCreate.status === 200 && regionCreate.body.code === 0 && regionCreate.body.data.name === "临平片区验收",
  "区域管理页：新建片区成功（编码 " + (regionCreate.body.data?.code || "-") + "）");
const regionList = await api("GET", "/admin/regions", { token });
assert(regionList.status === 200 && regionList.body.data.some((r) => r.name === "临平片区验收"),
  "区域管理页：新建片区出现在片区列表（共 " + (regionList.body.data?.length || 0) + " 个片区）");

/* 关键写操作（与页面按钮一致） */
const banner = (await api("GET", "/admin/banners", { token })).body.data[0];
const bnToggle = await api("POST", "/admin/banners/" + banner.id + "/toggle", { token });
const bnBack = await api("POST", "/admin/banners/" + banner.id + "/toggle", { token });
assert(bnToggle.body.data.status === "off" && bnBack.body.data.status === "on", "运营页：Banner 停用/启用按钮闭环");

const rule = (await api("GET", "/admin/rules", { token })).body.data.rules.find((r) => r.key === "checkin");
const before = rule.value;
const save = await api("PUT", "/admin/rules/checkin", { token, body: { value: { ...before, max_distance_m: 800 } } });
const reload = (await api("GET", "/admin/rules", { token })).body.data.rules.find((r) => r.key === "checkin");
assert(save.status === 200 && reload.value.max_distance_m === 800, "规则页：保存并即时生效（500m → 800m）");
await api("PUT", "/admin/rules/checkin", { token, body: { value: before } });

const csv = await fetch(BASE + "/api/admin/orders/export", { headers: { Authorization: "Bearer " + token } });
const csvText = await csv.text();
assert(csv.status === 200 && /text\/csv/.test(csv.headers.get("content-type")) && csvText.includes("订单号"), "订单页：CSV 导出按钮可用（" + csvText.split("\n")[0].slice(0, 24) + "…）");

/* 越权保护：普通用户不能进后台接口 */
const parentLogin = await api("POST", "/auth/login-password", { body: { phone: "13900000301", password: PW } });
const deny = await api("GET", "/admin/overview", { token: parentLogin.body.data.token });
assert(deny.status === 403, "后台接口对非管理员返回 403（" + deny.status + "）");

/* ---------- 需求池与管理员账号（需求 4.5.3 / 4.5.9） ---------- */
const demands = await api("GET", "/admin/demands?page=1&pageSize=10", { token });
assert(demands.status === 200 && Array.isArray(demands.body.data.list),
  "需求池页：/admin/demands 返回分页列表（" + (demands.body.data?.total ?? 0) + " 条）");
const demandRow = (demands.body.data?.list || [])[0];
assert(!!demandRow && "statusText" in demandRow && "applications" in demandRow && String(demandRow.parentPhone || "").includes("*"),
  "需求池页：含状态文案/报名数，且家长手机号脱敏（" + demandRow?.parentPhone + "）");

const adminList = await api("GET", "/admin/admins", { token });
assert(adminList.status === 200 && (adminList.body.data || []).some((a) => a.status === "active"),
  "管理员账号页：/admin/admins 返回管理员列表（" + (adminList.body.data || []).length + " 个）");
const newAdmin = await api("POST", "/admin/admins", { token, body: { nickname: "验收管理员", phone: "13900007701" } });
const admPwd = newAdmin.body.data?.initialPassword;
assert(newAdmin.status === 200 && typeof admPwd === "string" && admPwd !== PW && admPwd.length >= 10,
  "管理员账号页：新建管理员返回一次性强口令（" + admPwd + "）");
const newAdminId = newAdmin.body.data?.id;
const disableNew = await api("POST", "/admin/admins/" + newAdminId + "/toggle", { token });
assert(disableNew.status === 200 && disableNew.body.data.status === "disabled", "管理员账号页：可禁用其他管理员");
const selfDisable = await api("POST", "/admin/admins/" + (login.body.data.user.id) + "/toggle", { token });
assert(selfDisable.status === 403 && /当前登录/.test(selfDisable.body?.message || ""),
  "管理员账号页：禁止禁用自己（" + selfDisable.body?.message + "）");

console.log("\n=================================================");
console.log("PC 管理后台验收：通过 " + pass + " 项，失败 " + fail + " 项");
if (fail) {
  console.log("失败项：");
  failures.forEach((f) => console.log("  - " + f));
  process.exitCode = 1;
} else {
  console.log("Vue3 + Vite + Element Plus 后台产物可托管，12 个模块接口全部打通 ✅");
}
console.log("=================================================");
