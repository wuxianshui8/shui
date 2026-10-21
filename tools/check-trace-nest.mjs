// ============================================================
// 追溯矩阵校验：docs/TRACEABILITY-NEST.md ↔ 接口清单 ↔ 门禁脚本
//   规则：
//     1. 带 HTTP 方法的接口引用（如 `POST /api/orders/:id/pay`、`GET|POST /api/teacher/services`）必须真实存在；
//     2. 纯路径引用（不带方法）允许出现，用于描述「参考实现有、新后端未做」的偏离；
//     3. `e2e §n` 的序号必须在 e2e 实际分段范围内；
//     4. 提到的门禁脚本文件必须存在。
// 用法：node tools/check-trace-nest.mjs   （退出码 1 = 存在引用错误）
// ============================================================
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TRACE = process.env.TRACE_FILE
  ? path.resolve(process.env.TRACE_FILE)
  : path.join(ROOT, "docs", "TRACEABILITY-NEST.md");
const API_DOC = path.join(ROOT, "docs", "API-NEST.md");
const E2E = path.join(ROOT, "test", "e2e.test.js");

for (const f of [TRACE, API_DOC, E2E]) {
  if (!existsSync(f)) {
    console.error("✗ 缺少文件：" + path.relative(ROOT, f));
    process.exit(1);
  }
}

/* ---------- 1. 接口清单（来自自动生成文档，已被 api:doc:check 保证与源码一致） ---------- */
const inventory = new Set();
for (const line of readFileSync(API_DOC, "utf8").split("\n")) {
  const m = line.match(/^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`/);
  if (m) inventory.add(m[1] + " " + m[2]);
}

/* ---------- 2. e2e 分段标题 ---------- */
const sectionTitles = [];
for (const line of readFileSync(E2E, "utf8").split(/\r?\n/)) {
  const m = line.match(/section\(\s*["'`](.+?)["'`]/);
  if (m) sectionTitles.push(m[1]);
}

/* ---------- 3. 门禁简称 → 文件 ---------- */
const GATES = {
  rules: "test/rules.test.js",
  sec: "test/security.test.js",
  conc: "tools/concurrency-mysql.mjs",
  races: "tools/check-money-races.mjs",
  priv: "tools/check-privacy-auth.mjs",
  hc: "tools/healthcheck-mysql.mjs",
  admin: "tools/check-admin-spa.mjs",
  mobile: "tools/check-mobile-spa.mjs",
  "verify-nest": "tools/verify-nest.mjs",
  "nest:bench": "tools/gate-bench.mjs",
  "nest:gate:p9": "tools/gate-p9.mjs",
};

/* ---------- 4. 校验 ---------- */
const doc = readFileSync(TRACE, "utf8");
const problems = [];
const citedEndpoints = new Set();
let methodRefs = 0;

// 4.1 带方法的接口引用
for (const span of doc.matchAll(/`([^`\n]+)`/g)) {
  const text = span[1];
  if (!text.includes("/api/")) continue;
  const m = text.match(/^((?:(?:GET|POST|PUT|PATCH|DELETE)\|?)+)\s+(\/api\/\S+)$/);
  if (!m) continue; // 纯路径引用：允许（偏离说明用）
  const methods = m[1].split("|").filter(Boolean);
  const apiPath = m[2].replace(/[，、。；]+$/, "");
  for (const method of methods) {
    methodRefs++;
    const key = method + " " + apiPath;
    citedEndpoints.add(key);
    if (!inventory.has(key)) problems.push("接口不存在：" + key);
  }
}

// 4.2 e2e 分段序号
for (const span of doc.matchAll(/e2e\s*§(\d+)/g)) {
  const n = Number(span[1]);
  if (!(n >= 1 && n <= sectionTitles.length)) {
    problems.push("e2e 分段越界：§" + n + "（实际共 " + sectionTitles.length + " 段）");
  }
}

// 4.3 门禁脚本存在性
for (const [short, file] of Object.entries(GATES)) {
  const re = new RegExp("(^|[^\\w:])" + short.replace(/[:]/g, "\\:") + "([^\\w]|$)", "m");
  if (re.test(doc) && !existsSync(path.join(ROOT, file))) {
    problems.push("门禁脚本缺失：" + short + " → " + file);
  }
}

/* ---------- 5. 输出 ---------- */
const rows = doc.split("\n").filter((l) => l.startsWith("|") && l.split("|").length >= 4).length;
console.log("追溯矩阵校验");
console.log("  表格行数        ：" + rows);
console.log("  带方法接口引用  ：" + methodRefs + " 处（去重 " + citedEndpoints.size + " 个接口）");
console.log("  接口清单总路由  ：" + inventory.size);
console.log("  覆盖路由数      ：" + [...citedEndpoints].filter((k) => inventory.has(k)).length + " / " + inventory.size);
console.log("  e2e 分段可引用  ：§1–§" + sectionTitles.length);

if (problems.length) {
  console.log("\n✗ 发现 " + problems.length + " 个问题：");
  [...new Set(problems)].slice(0, 30).forEach((p) => console.log("  - " + p));
  process.exit(1);
}
console.log("\n✓ 追溯矩阵引用的接口、门禁脚本、e2e 分段全部有效");
