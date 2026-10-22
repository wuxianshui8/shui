// ============================================================
// 单元测试与覆盖率门禁（node:test + --experimental-test-coverage，零第三方依赖）
//
//   覆盖目标：apps/api-nest/src 下不依赖数据库/HTTP 的纯函数模块
//     common/{codes,errors,geo,paging,password,reply,token}.ts、config.ts、
//     rules/rule-engine.service.ts（规则配置用 stub 注入）
//   测试文件：apps/api-nest/test/unit/*.test.mjs（跑编译产物 dist，不引入 ts 运行时）
//
//   门禁不只是「跑通」，而是三条硬约束：
//     1. 失败用例数必须为 0
//     2. 用例数不得少于 UNIT_MIN_TESTS（默认 60）—— 防止测试被删/文件改名后「0 用例也算绿」
//     3. 每个覆盖目标的行覆盖率 ≥ COVERAGE_MIN_LINES（默认 90），分支 ≥ COVERAGE_MIN_BRANCH（默认 60）
//        且目标文件必须真的出现在覆盖率报告里（否则判失败，防「文件没被加载」蒙过关）
//
// 用法：node tools/gate-unit.mjs
//   COVERAGE_MIN_LINES=99  node tools/gate-unit.mjs   # 负向验证：阈值调高必须变红
//   UNIT_MIN_TESTS=999     node tools/gate-unit.mjs   # 负向验证：用例数门槛
// ============================================================
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const API_DIR = path.join(ROOT, "apps", "api-nest");
const TEST_GLOB = process.env.UNIT_TEST_GLOB || "test/unit/*.test.mjs";

/** 被覆盖并受阈值约束的模块（相对 apps/api-nest） */
const TARGETS = [
  "dist/common/codes.js",
  "dist/common/errors.js",
  "dist/common/geo.js",
  "dist/common/paging.js",
  "dist/common/password.js",
  "dist/common/reply.js",
  "dist/common/token.js",
  "dist/config.js",
  "dist/integrations/sms/sms.port.js",
  "dist/integrations/sms/sms.mock.js",
  "dist/integrations/sms/sms.tencent.js",
  "dist/integrations/sms/sms.service.js",
  "dist/integrations/pay/pay.port.js",
  "dist/integrations/pay/pay.mock.js",
  "dist/integrations/pay/pay.wechat.js",
  "dist/integrations/pay/pay.service.js",
  "dist/rules/rule-engine.service.js",
];

const MIN_LINES = Number(process.env.COVERAGE_MIN_LINES || 90);
const MIN_BRANCH = Number(process.env.COVERAGE_MIN_BRANCH || 60);
const MIN_TESTS = Number(process.env.UNIT_MIN_TESTS || 60);

const problems = [];
const fail = (msg) => problems.push(msg);

// —— 前置：必须先编译（dist 缺失时覆盖率报告会是空的，等于没测）
const fs = await import("node:fs");
const missing = TARGETS.filter((t) => !fs.existsSync(path.join(API_DIR, t)));
if (missing.length) {
  console.log("✗ 编译产物缺失，先执行 tsc：");
  for (const m of missing) console.log("  - apps/api-nest/" + m);
  console.log("\n  cd apps/api-nest && node ../node_modules/typescript/bin/tsc -p tsconfig.json");
  process.exit(1);
}

const args = [
  "--test",
  "--experimental-test-coverage",
  "--no-warnings", // 只屏蔽 glob 实验特性提示，不影响用例失败信息
  ...TARGETS.map((t) => "--test-coverage-include=**/" + t.replaceAll("\\", "/")),
  TEST_GLOB,
];
console.log("单元测试与覆盖率门禁");
console.log("  · 测试文件：" + TEST_GLOB);
console.log("  · 覆盖目标：" + TARGETS.length + " 个模块");
console.log("  · 阈值：行 ≥ " + MIN_LINES + "% / 分支 ≥ " + MIN_BRANCH + "% / 用例 ≥ " + MIN_TESTS);

const started = Date.now();
const r = spawnSync(process.execPath, args, { cwd: API_DIR, encoding: "utf8" });
const out = (r.stdout || "") + (r.stderr || "");
const secs = ((Date.now() - started) / 1000).toFixed(1);

if (r.error) {
  console.log("\n✗ 无法启动测试进程：" + r.error.message);
  process.exit(1);
}

// —— TAP 汇总
const num = (re) => {
  const m = re.exec(out);
  return m ? Number(m[1]) : null;
};
const tests = num(/^# tests (\d+)$/m);
const pass = num(/^# pass (\d+)$/m);
const failCount = num(/^# fail (\d+)$/m);

if (tests === null || pass === null || failCount === null) {
  console.log("\n✗ 未解析到 TAP 汇总（用例没跑起来？）");
  console.log(out.split(/\r?\n/).slice(-25).join("\n"));
  process.exit(1);
}

const failedNames = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
if (failCount > 0) fail("失败用例 " + failCount + " 个" + (failedNames.length ? "：" + failedNames.join("；") : ""));
if (pass < MIN_TESTS) fail("用例数 " + pass + " < 门槛 " + MIN_TESTS + "（测试被误删或未匹配到文件？）");

// —— 覆盖率表
const rows = new Map();
let total = null;
for (const line of out.split(/\r?\n/)) {
  const m = /^#\s+([\w.@\-/]+\.js)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/.exec(line);
  if (m) rows.set(path.basename(m[1]), { line: Number(m[2]), branch: Number(m[3]), funcs: Number(m[4]) });
  const a = /^#\s+all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/.exec(line);
  if (a) total = { line: Number(a[1]), branch: Number(a[2]), funcs: Number(a[3]) };
}

if (rows.size === 0) fail("覆盖率报告为空（一个目标文件都没被加载）");

for (const t of TARGETS) {
  const base = path.basename(t);
  const cov = rows.get(base);
  if (!cov) {
    fail(t + " 未出现在覆盖率报告中");
    continue;
  }
  if (cov.line < MIN_LINES) fail(base + " 行覆盖率 " + cov.line.toFixed(2) + "% < " + MIN_LINES + "%");
  if (cov.branch < MIN_BRANCH) fail(base + " 分支覆盖率 " + cov.branch.toFixed(2) + "% < " + MIN_BRANCH + "%");
}

console.log(
  "\n用例：" + pass + "/" + tests + " 通过" + (failCount ? "，" + failCount + " 失败" : "") + "（" + secs + "s）"
);
console.log("\n覆盖率：模块 / 行 / 分支 / 函数");
for (const t of TARGETS) {
  const base = path.basename(t);
  const c = rows.get(base);
  console.log(
    "  " + (c ? "•" : "✗") + " " + base.padEnd(26) + (c ? c.line.toFixed(2).padStart(6) + "  " + c.branch.toFixed(2).padStart(6) + "  " + c.funcs.toFixed(2).padStart(6) : "   未加载")
  );
}
if (total) {
  console.log(
    "  " + "合计".padEnd(24) + total.line.toFixed(2).padStart(6) + "  " + total.branch.toFixed(2).padStart(6) + "  " + total.funcs.toFixed(2).padStart(6)
  );
}

if (problems.length) {
  console.log("\n✗ 单元测试与覆盖率门禁未通过：");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}

console.log(
  "\n✓ " + pass + " 个用例全部通过；" + TARGETS.length + " 个模块行覆盖率均 ≥ " + MIN_LINES + "%" + (total ? "（合计 " + total.line.toFixed(2) + "%）" : "")
);
