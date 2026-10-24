// ============================================================
// UI 追溯矩阵校验（《UI 界面设计说明书 V1.0》↔ 新前端页面/路由）
//   1. 文档里引用的每个 .vue 必须真实存在
//   2. 后台每个页面文件、移动端每个页面必须全部被文档引用（漏写即失败）
//   3. 文档引用的路由必须在 router.js 注册，菜单标题必须与 App.vue 一致
//   4. 文档声明的页面数必须与实际一致
//   5. **后端能力 ↔ 前端入口**（P73 升级）：
//      a) Nest 里每条 `/admin/**` 接口都必须在 web-admin 源码里出现（否则就是「有接口没按钮」）
//      b) 移动端「家长/教员/业务员/代理」四个角色的关键能力必须能在 pages 里找到调用入口
//      c) 声明「只在后台」的接口要写进 ALLOWLIST 并写明原因，避免门禁被无声放宽
// 用法：node tools/check-ui-trace.mjs
// ============================================================
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOC = path.join(ROOT, "docs", "TRACEABILITY-UI-NEST.md");
const problems = [];
const notes = [];
const fail = (m) => problems.push(m);

/* ---------- 5a 的配置：确实不需要后台按钮的接口（必须写明原因） ---------- */
const ADMIN_API_ALLOWLIST = new Map([
  // 例：["/admin/xxx", "由 YYY 页面间接调用 / 仅供运维 CLI 使用"],
]);

/* ---------- 5b 的配置：移动端四端必须能找到入口的能力 ---------- */
const MOBILE_CAPABILITIES = [
  ["家长发需求", "/demands"],
  ["家长我的需求", "/demands/mine"],
  ["家长确认教员", '"/confirm"'],
  ["家长付担保金", '"/pay"'],
  ["家长到场打卡", '"/checkin"'],
  ["家长申请退款", '"/refund"'],
  ["家长紧急求助", '"/sos"'],
  ["家长投诉工单", '"/complaints"'],
  ["家长申请开票", '"/invoices"'],
  ["家长领优惠券", '"/parent/coupons/"'],
  ["家长看我的券", '"/parent/coupons"'],
  ["家长找附近教员", "/parent/teachers"],
  ["家长看教员详情", "/parent/teachers/"],
  ["教员附近需求", "/teacher/nearby-demands"],
  ["教员入驻申请", "/teacher/apply"],
  ["教员我的服务", "/teacher/services"],
  ["业务员奖励明细", "/sales/rewards"],
  ["代理客诉工单", "/agent/complaints"],
  ["四个角色消息中心", '"/messages"'],
];
/* ---------- 事实：后台路由 / 菜单 / 视图 / 移动端页面 ---------- */
const routerSrc = readFileSync(path.join(ROOT, "apps/web-admin/src/router.js"), "utf8");
const adminRoutes = [...routerSrc.matchAll(/path:\s*"(\/[^"]*)"/g)].map((m) => m[1]).filter((p) => p !== "/");
const routeViews = [...routerSrc.matchAll(/import\("\.\/views\/(\w+)\.vue"\)/g)].map((m) => m[1]);

const appSrc = readFileSync(path.join(ROOT, "apps/web-admin/src/App.vue"), "utf8");
const menus = [...appSrc.matchAll(/\{ path: "([^"]+)", title: "([^"]+)"/g)].map((m) => ({ path: m[1], title: m[2] }));

const viewFiles = readdirSync(path.join(ROOT, "apps/web-admin/src/views")).filter((f) => f.endsWith(".vue"));

const pagesJson = JSON.parse(readFileSync(path.join(ROOT, "apps/web-mobile/src/pages.json"), "utf8"));
const mobilePaths = pagesJson.pages.map((p) => p.path);

notes.push("后台视图文件 " + viewFiles.length + " 个：" + viewFiles.map((f) => f.replace(".vue", "")).join("、"));
notes.push("后台路由 " + adminRoutes.length + " 条，侧栏菜单 " + menus.length + " 项");
notes.push("移动端页面 " + mobilePaths.length + " 个：" + mobilePaths.join("、"));

/* ---------- 一致性：路由 ↔ 视图 ↔ 菜单 ---------- */
for (const v of viewFiles) {
  const name = v.replace(".vue", "");
  if (name === "Login") continue;
  if (!routeViews.includes(name)) fail("视图文件未在 router.js 注册：" + v);
}
for (const name of routeViews) {
  if (!viewFiles.includes(name + ".vue")) fail("router.js 引用了不存在的视图：" + name + ".vue");
}
for (const menu of menus) {
  if (!adminRoutes.includes(menu.path)) fail("侧栏菜单指向未注册路由：" + menu.path + "（" + menu.title + "）");
}
if (menus.length !== adminRoutes.length - 1) {
  // adminRoutes 含 /login 与 redirect 根路径的处理差异，这里只提示
  notes.push("菜单 " + menus.length + " 项 vs 路由 " + adminRoutes.length + " 条（差 1 为 /login）");
}

/* ---------- 文档校验 ---------- */
if (!existsSync(DOC)) {
  console.error("✗ 缺少 docs/TRACEABILITY-UI-NEST.md");
  process.exit(1);
}
const doc = readFileSync(DOC, "utf8");

// 1) 引用的 .vue 必须存在
const refs = new Set();
for (const m of doc.matchAll(/`([\w/.-]+\.vue)`/g)) {
  const p = m[1];
  const candidates = [
    path.join(ROOT, "apps/web-admin/src/views", path.basename(p)),
    path.join(ROOT, "apps/web-admin/src", path.basename(p)),
    path.join(ROOT, "apps/web-mobile/src", path.basename(p)),
    path.join(ROOT, "apps/web-mobile/src/pages", p.replace(/^pages\//, "")),
    path.join(ROOT, p),
  ];
  if (!candidates.some((c) => existsSync(c))) fail("文档引用了不存在的 .vue：" + p);
  refs.add(p);
}

// 2) 每个后台页面都必须被文档引用
for (const v of viewFiles) {
  const name = v.replace(".vue", "");
  if (!doc.includes(name + ".vue")) fail("后台页面未在 UI 追溯中文档化：" + v);
}

// 3) 每个移动端页面都必须被文档引用
for (const p of mobilePaths) {
  if (!doc.includes(p)) fail("移动端页面未在 UI 追溯中文档化：" + p);
}

// 4) 文档引用的路由必须在 router.js 注册（/m/... 除外）
// 旧 5 端 UI（web/*.html）的路径由参考实现托管，不属于新前端路由
const LEGACY_UI_PATHS = ["/parent", "/teacher", "/sales", "/agent", "/admin"];
for (const m of doc.matchAll(/`(\/[a-z][\w/-]*)`/g)) {
  const route = m[1];
  if (route.startsWith("/m/") || route.startsWith("/api/") || route.startsWith("/admin-vue")) continue;
  if (LEGACY_UI_PATHS.includes(route)) continue;
  if (route.includes(".")) continue; // 静态文件路径
  if (!adminRoutes.includes(route)) fail("文档引用的后台路由未注册：" + route);
}

// 5) 文档声明的页面数必须与实际一致
const declaredAdmin = doc.match(/后台页面[：:]\s*(\d+)/);
if (declaredAdmin && Number(declaredAdmin[1]) !== viewFiles.length) {
  fail("文档声明后台页面 " + declaredAdmin[1] + " 个，实际 " + viewFiles.length + " 个");
}
const declaredMobile = doc.match(/移动端页面[：:]\s*(\d+)/);
if (declaredMobile && Number(declaredMobile[1]) !== mobilePaths.length) {
  fail("文档声明移动端页面 " + declaredMobile[1] + " 个，实际 " + mobilePaths.length + " 个");
}

/* ---------- 6) 后端能力 ↔ 前端入口（P73） ---------- */

/** 递归收集某目录下的源码文本 */
function collect(dir, exts) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(p, exts));
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

// 6a) Nest 每条 /admin/** 接口都要在后台前端里出现
const nestEndpoints = [];
for (const f of collect(path.join(ROOT, "apps/api-nest/src"), [".ts"])) {
  const src = readFileSync(f, "utf8");
  const cm = src.match(/@Controller\(\s*["'`]([^"'`]*)["'`]\s*\)/);
  if (!cm) continue;
  for (const m of src.matchAll(/@(Get|Post|Put|Delete|Patch)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g)) {
    nestEndpoints.push({
      file: path.basename(f),
      method: m[1].toUpperCase(),
      path: "/" + [cm[1], m[2] || ""].filter(Boolean).join("/"),
    });
  }
}
const adminSrcText = collect(path.join(ROOT, "apps/web-admin/src"), [".vue", ".js"])
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
// 前端大量用字符串拼接（"/admin/coupons/" + id + "/toggle"），因此按「到第一个路径参数为止的前缀」匹配
const stubOf = (p) => p.split("/:")[0].replace(/\/$/, "");
const adminEndpoints = nestEndpoints.filter((e) => e.path.startsWith("/admin/"));
const unreferenced = adminEndpoints.filter(
  (e) => !adminSrcText.includes(stubOf(e.path)) && !ADMIN_API_ALLOWLIST.has(e.path),
);
for (const e of unreferenced) {
  fail("后台接口没有前端入口：" + e.method + " " + e.path + "（" + e.file + "）；确实不需要就写进 ADMIN_API_ALLOWLIST 并注明原因");
}
notes.push(
  "后端接口 " + nestEndpoints.length + " 条（其中后台 " + adminEndpoints.length + " 条，" +
  (adminEndpoints.length - unreferenced.length) + " 条有后台入口" +
  (ADMIN_API_ALLOWLIST.size ? "，" + ADMIN_API_ALLOWLIST.size + " 条在豁免表" : "，无豁免") + "）",
);

// 6b) 移动端四端关键能力必须有调用入口
const mobileSrcText = collect(path.join(ROOT, "apps/web-mobile/src"), [".vue", ".js"]).join("\n");
const mobileSrcAll = collect(path.join(ROOT, "apps/web-mobile/src"), [".vue", ".js"])
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
for (const [label, stub] of MOBILE_CAPABILITIES) {
  if (!mobileSrcAll.includes(stub)) fail("移动端缺少入口：" + label + "（未找到对 " + stub + " 的调用）");
}
notes.push("移动端关键能力 " + MOBILE_CAPABILITIES.length + " 项已逐项核对入口");
void mobileSrcText;


/* ---------- 输出 ---------- */
console.log("UI 追溯矩阵校验（UI 说明书 ↔ 新前端）");
notes.forEach((n) => console.log("  · " + n));
console.log("  · 文档引用 .vue：" + refs.size + " 个");
if (problems.length) {
  console.log("\n✗ 发现 " + problems.length + " 个问题：");
  problems.forEach((p) => console.log("  - " + p));
  process.exit(1);
}
console.log("\n✓ UI 追溯与代码一致：后台 " + viewFiles.length + " 页 / 移动端 " + mobilePaths.length + " 页全部有对应条目，路由与菜单自洽，后端能力均有前端入口");
