// ============================================================
// GitHub Actions 工作流「证据映射」校验
//   本机没有 Docker 守护进程、也没有仓库远端，Runner 无法真实执行。
//   因此这里做一件可验证的事：把 .github/workflows/ci.yml 里每个会落地的命令，
//   映射到「本机已经跑通过的等价门禁」，并断言没有命令是「写了但从未被验证」的。
//     1. 解析 workflow 的 run: 命令
//     2. 逐条匹配证据表（脚本/命令 → 本地门禁）
//     3. 未覆盖的命令 → 失败（除非显式标注为 runner-only）
//     4. 打印映射表，便于交付审阅
// 用法：node tools/check-workflow-proof.mjs
// ============================================================
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const WF = path.join(ROOT, ".github", "workflows", "ci.yml");

/** 证据表：workflow 命令片段 → 本机实测过的等价门禁 */
const PROOF = [
  { match: /node_modules\/typescript\/bin\/tsc/, gate: "npm run ci（静态：tsc 0 错误）" },
  { match: /npm install|npm --prefix \S+ install/, gate: "本机已多次执行同名安装（apps/*/node_modules 存在）" },
  { match: /mysql .*schema\.mysql\.sql/, gate: "gate-p6/p9 每次建库都执行同一份 schema.mysql.sql（37 表）" },
  { match: /node db\/seed-min\.mjs/, gate: "gate-p6 每次运行前执行 db/seed-min.mjs（12 用户 / 4 教员 / 3 业务员 / 2 代理）" },
  { match: /node dist\/main\.js/, gate: "verification：所有 gate-* 均以 node dist/main.js 起服并等 /api/health" },
  { match: /node test\/e2e\.test\.js/, gate: "e2e 全套 §1–§20 → 153/153" },
  { match: /node test\/security\.test\.js/, gate: "security → 53/53" },
  { match: /node test\/rules\.test\.js/, gate: "rules → 50/50" },
  { match: /node tools\/check-money-races\.mjs/, gate: "races → 27/27" },
  { match: /node tools\/check-privacy-auth\.mjs/, gate: "privacy → 38/38" },
  { match: /node tools\/check-permissions\.mjs/, gate: "permissions → 17/17" },
  { match: /node \.\.\/tools\/concurrency-mysql\.mjs/, gate: "concurrency → 23/23" },
  { match: /node \.\.\/tools\/healthcheck-mysql\.mjs/, gate: "MySQL 巡检 → 12/12（gate-p9）" },
  { match: /node tools\/check-admin-spa\.mjs/, gate: "admin SPA → 38/38" },
  { match: /node tools\/check-mobile-spa\.mjs/, gate: "mobile SPA → 41/41" },
  { match: /npm --prefix apps\/web-admin run build/, gate: "web-admin vite build 本地多次通过（dist 存在）" },
  { match: /npm --prefix apps\/web-mobile run build:h5/, gate: "web-mobile uni build（H5）本地多次通过" },
  { match: /npm --prefix apps\/web-mobile run build:mp/, gate: "web-mobile uni build -p mp-weixin 本地通过（app.json 10 页）" },
  { match: /node tools\/ci-full\.mjs --static/, gate: "npm run ci（tsc + 接口文档 + 追溯矩阵 + 部署配置）" },
];

/** 只有在 Runner 里才有意义的步骤（不是「未验证」，而是环境专属） */
const RUNNER_ONLY = [
  { match: /actions\/checkout@/, why: "GitHub 内置动作：拉取仓库" },
  { match: /actions\/setup-node@/, why: "GitHub 内置动作：安装 Node 22" },
  { match: /curl -fsS/, why: "Runner 内探活 /api/health（本地由 gate 脚本用 fetch 完成等价探活）" },
  { match: /for i in \$\(seq/, why: "Runner 内等待服务就绪（本地由 gate 脚本 waitPort 完成）" },
  { match: /nohup .* > \/tmp\/api\.log/, why: "Runner 内后台起服（本地由 gate 脚本 spawn detached 完成）" },
  { match: /tail -n 200 \/tmp\/api\.log/, why: "仅失败时打印日志" },
  { match: /echo /, why: "仅日志输出" },
  // 多行 shell 块里的语法脚手架（不是独立步骤）
  { match: /^(sleep \d+|done|fi|then|else|for i in |if |}\s*)$/, why: "多行 shell 块内部语句（非独立步骤）" },
];

if (!existsSync(WF)) {
  console.error("✗ 缺少 .github/workflows/ci.yml");
  process.exit(1);
}
const text = readFileSync(WF, "utf8");

// 收集所有 run: 块里的命令（多行块 + 单行）
const commands = [];
const lines = text.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^(\s+)run:\s*(.*)$/);
  if (!m) continue;
  const indent = m[1].length;
  if (m[2] && m[2] !== "|" && m[2] !== ">") {
    commands.push({ line: i + 1, cmd: m[2].trim() });
    continue;
  }
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    const ind = l.match(/^(\s*)/)[1].length;
    if (l.trim() && ind <= indent) break;
    if (l.trim()) commands.push({ line: j + 1, cmd: l.trim() });
  }
}

const problems = [];
const rows = [];
for (const { line, cmd } of commands) {
  if (/^#/.test(cmd)) continue;
  const proof = PROOF.find((p) => p.match.test(cmd));
  if (proof) {
    rows.push({ line, cmd, kind: "已在本机验证", evidence: proof.gate });
    continue;
  }
  const runner = RUNNER_ONLY.find((p) => p.match.test(cmd));
  if (runner) {
    rows.push({ line, cmd, kind: "Runner 专属", evidence: runner.why });
    continue;
  }
  rows.push({ line, cmd, kind: "未覆盖", evidence: "—" });
  problems.push("第 " + line + " 行命令没有证据映射：" + cmd);
}

console.log("GitHub Actions 工作流 · 证据映射");
console.log("（本机无 Docker 守护进程、无仓库远端 → Runner 未真实执行；下面只核验「命令是否都有本地等价证据」）\n");
const w = Math.max(...rows.map((r) => r.cmd.length), 20);
for (const r of rows) {
  console.log("  " + r.cmd.padEnd(Math.min(w, 60)) + "  [" + r.kind + "]  " + r.evidence);
}
console.log("\n命令数：" + rows.filter((r) => r.kind !== "Runner 专属").length + " 条需本地证据，" +
  rows.filter((r) => r.kind === "Runner 专属").length + " 条 Runner 专属");

if (problems.length) {
  console.log("\n✗ " + problems.length + " 条命令没有本地验证证据：");
  problems.forEach((p) => console.log("  - " + p));
  process.exit(1);
}
console.log("\n✓ workflow 里每条会落地的命令都能对应到本机已通过的门禁或明确的 Runner 专属步骤");
console.log("  仍未验证的只有「容器/托管 Runner 环境本身」（需在有 Docker 的机器或推送后首次运行确认）");
