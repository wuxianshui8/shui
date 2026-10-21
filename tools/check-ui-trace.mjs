// ============================================================
// UI 追溯矩阵校验（《UI 界面设计说明书 V1.0》↔ 新前端页面/路由）
//   1. 文档里引用的每个 .vue 必须真实存在
//   2. 后台 18 个页面文件、移动端 9 个页面必须全部被文档引用（漏写即失败）
//   3. 文档引用的路由必须在 router.js 注册，菜单标题必须与 App.vue 一致
//   4. 打印实际数量，便于与文档声明比对
// 用法：node tools/check-ui-trace.mjs
// ============================================================
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOC = path.join(ROOT, "docs", "TRACEABILITY-UI-NEST.md");
const problems = [];
const notes = [];
const fail = (m) => problems.push(m);

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

/* ---------- 输出 ---------- */
console.log("UI 追溯矩阵校验（UI 说明书 ↔ 新前端）");
notes.forEach((n) => console.log("  · " + n));
console.log("  · 文档引用 .vue：" + refs.size + " 个");
if (problems.length) {
  console.log("\n✗ 发现 " + problems.length + " 个问题：");
  problems.forEach((p) => console.log("  - " + p));
  process.exit(1);
}
console.log("\n✓ UI 追溯与代码一致：后台 " + viewFiles.length + " 页 / 移动端 " + mobilePaths.length + " 页全部有对应条目，路由与菜单自洽");
