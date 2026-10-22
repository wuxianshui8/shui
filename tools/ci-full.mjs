// ============================================================
// 汇总门禁：依次跑完所有需要起服的门禁，任一失败即中止
//   用法：node tools/ci-full.mjs        （约 12–18 分钟，逐项起停 MySQL/Redis/NestJS）
//         node tools/ci-full.mjs --quick  只跑 e2e + security + rules
// ============================================================
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const QUICK = process.argv.includes("--quick");

/** 每项：名称 / 命令 / 通过标志（用于在输出里确认结果） */
const STEPS = [
  { name: "静态：tsc", cmd: ["node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], cwd: "apps/api-nest" },
  { name: "静态：单元测试与覆盖率", cmd: ["node", "tools/gate-unit.mjs"] },
  { name: "静态：依赖漏洞（npm audit）", cmd: ["node", "tools/check-audit.mjs"] },
  { name: "静态：接口文档", cmd: ["node", "tools/gen-api-doc.mjs", "--check"] },
  { name: "静态：追溯矩阵", cmd: ["node", "tools/check-trace-nest.mjs"] },
  { name: "静态：UI 追溯", cmd: ["node", "tools/check-ui-trace.mjs"] },
  { name: "静态：Windows 脚本", cmd: ["node", "tools/check-windows-scripts.mjs"] },
  { name: "静态：门禁自检（meta）", cmd: ["node", "tools/check-gates-selftest.mjs"] },
  { name: "静态：compose 官方 Schema", cmd: ["node", "tools/check-compose-schema.mjs", "--allow-skip"] },
  { name: "静态：文档 shell 写法", cmd: ["node", "tools/check-docs-shell.mjs"] },
  { name: "静态：部署与 CI 配置", cmd: ["node", "tools/check-deploy.mjs"] },
  { name: "静态：镜像布局", cmd: ["node", "tools/check-image.mjs"] },
  { name: "静态：工作流 lint", cmd: ["node", "tools/check-workflow-lint.mjs"] },
  { name: "静态：工作流证据", cmd: ["node", "tools/check-workflow-proof.mjs"] },
  { name: "P1 verify-nest（15）", cmd: ["node", "tools/verify-nest.mjs"] },
  { name: "e2e 全套（153）", cmd: ["node", "tools/gate-p6.mjs"], env: { E2E_SECTION: "20" } },
  { name: "security（53）", cmd: ["node", "tools/gate-p6.mjs"], env: { E2E_SCRIPT: "test/security.test.js" } },
  { name: "rules（50）", cmd: ["node", "tools/gate-p6.mjs"], env: { E2E_SCRIPT: "test/rules.test.js" } },
];

const FULL = [
  { name: "concurrency（23）", cmd: ["node", "tools/gate-p7.mjs"] },
  { name: "races（27）", cmd: ["node", "tools/gate-races.mjs"] },
  { name: "privacy（38）", cmd: ["node", "tools/gate-privacy.mjs"] },
  { name: "permissions（17）", cmd: ["node", "tools/gate-permissions.mjs"] },
  { name: "admin SPA（38）", cmd: ["node", "tools/gate-p6.mjs"], env: { E2E_SCRIPT: "tools/check-admin-spa.mjs" } },
  { name: "mobile SPA（41）", cmd: ["node", "tools/gate-p6.mjs"], env: { E2E_SCRIPT: "tools/check-mobile-spa.mjs" } },
  { name: "支付回调与幂等（22）", cmd: ["node", "tools/gate-p6.mjs"], env: { E2E_SCRIPT: "tools/check-pay-flow.mjs" } },
  { name: "镜像运行契约（33）", cmd: ["node", "tools/gate-p6.mjs"], env: { E2E_SCRIPT: "tools/check-image-runtime.mjs" } },
  { name: "迁移 + MySQL 巡检（12）", cmd: ["node", "tools/gate-p9.mjs"] },
];

const list = process.argv.includes("--static")
  ? STEPS.filter((s) => s.name.startsWith("静态"))
  : QUICK
    ? STEPS.filter((s) => !s.name.startsWith("P1"))
    : [...STEPS, ...FULL];
const results = [];
const t0 = Date.now();

for (const [i, step] of list.entries()) {
  console.log("\n=== [" + (i + 1) + "/" + list.length + "] " + step.name + " ===");
  const started = Date.now();
  const r = spawnSync(step.cmd[0], step.cmd.slice(1), {
    cwd: step.cwd ? path.join(ROOT, step.cwd) : ROOT,
    env: { ...process.env, ...(step.env || {}) },
    stdio: "inherit",
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const ok = r.status === 0;
  results.push({ name: step.name, ok, secs });
  if (!ok) {
    console.log("\n✗ 「" + step.name + "」失败（退出码 " + r.status + "），已中止后续步骤");
    break;
  }
}

console.log("\n=================================================");
console.log("汇总门禁结果：");
for (const r of results) console.log("  " + (r.ok ? "✓" : "✗") + " " + r.name + "  " + r.secs + "s");
const failed = results.filter((r) => !r.ok);
console.log("总计 " + results.length + " 步，失败 " + failed.length + " 步，用时 " + ((Date.now() - t0) / 1000).toFixed(0) + "s");
console.log("=================================================");
process.exit(failed.length ? 1 : 0);
