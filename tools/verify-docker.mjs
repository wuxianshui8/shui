// ============================================================
// 容器栈功能验收：在 docker compose 起来的服务上跑完整的业务套件
//
//   为什么需要：`docker compose ps` 显示 healthy、四个入口 200 只能证明「起来了」，
//   不能证明容器里的 API/DB/Redis 组合与业务规则等价。本脚本按 CI 相同的顺序，
//   在每个「依赖干净种子」的套件前重置数据（DROP/CREATE 库 + 灌种子 + 清 Redis
//   + 重启 app 容器），把 11 个套件全部跑一遍。
//
//   前置：Docker Desktop 已启动；deploy/.env 里有真实 AUTH_SECRET；
//         基础镜像可获取（Docker Hub 不通时先配 registry-mirrors 或预先 retag）。
//   用法：node tools/verify-docker.mjs            # 全流程（up + seed + 11 套件）
//         SKIP_UP=1 node tools/verify-docker.mjs  # 服务已在跑，只跑套件
// ============================================================
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEPLOY = path.join(ROOT, "deploy");
const APP = path.join(ROOT, "apps", "api-nest");
const BASE_URL = process.env.BASE_URL || "http://localhost:4300";
const DOCKER = process.env.DOCKER_BIN || "docker";
const SKIP_UP = process.env.SKIP_UP === "1";

// 容器里的 app 用 deploy/.env 的 AUTH_SECRET；而 concurrency 等脚本在宿主机本地签名 token，
// 必须用同一个密钥，否则一律 401（首跑真实踩到：100 次并发报名全部失败）
const dotenv = {};
for (const line of fs.readFileSync(path.join(DEPLOY, ".env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) dotenv[m[1]] = m[2];
}
const env = {
  ...process.env,
  ...dotenv,
  BASE_URL,
  MYSQL_HOST: "127.0.0.1",
  MYSQL_PORT: process.env.MYSQL_PORT || "3307",
  MYSQL_USER: "root",
  MYSQL_PASSWORD: "",
  MYSQL_DATABASE: "jiajiao",
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: process.env.REDIS_PORT || "6380",
  PORT: "4300",
  RESET_TARGET: "docker",
  COMPOSE_BIN: DOCKER,
};

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", env, ...opts });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const node = (script, opts = {}) => sh(process.execPath, [path.join(ROOT, script)], opts);
const line = (m) => console.log("\n=== " + m + " ===");

async function waitHealth(label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE_URL}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`✗ ${label}：/api/health 未就绪`);
  return false;
}

/* ---------- 0. 前置检查 ---------- */
line("0. 前置检查");
if (!fs.existsSync(path.join(DEPLOY, ".env"))) {
  console.error("✗ 缺少 deploy/.env：请先复制 .env.example 并填入真实 AUTH_SECRET（或直接跑 deploy\\up.bat）");
  process.exit(1);
}
const envText = fs.readFileSync(path.join(DEPLOY, ".env"), "utf8");
if (/please-change-me/.test(envText)) {
  console.error("✗ deploy/.env 的 AUTH_SECRET 还是模板占位符，请换成真实随机串");
  process.exit(1);
}
const info = sh(DOCKER, ["info", "--format", "{{.ServerVersion}}"]);
if (info.code !== 0 || !/^\d/.test(info.out.trim())) {
  console.error("✗ Docker 引擎未就绪（请先启动 Docker Desktop 并等鲸鱼图标变绿）");
  process.exit(1);
}
console.log(`  引擎 server=${info.out.trim()}  BASE_URL=${BASE_URL}  MySQL=3307 Redis=6380`);
console.log("  说明：镜像内 NODE_ENV=production，验证码永不回显（安全设计），因此 e2e/rules 这类依赖 devCode 的套件不在容器上跑；它们由 CI 的主机栈覆盖。");

/* ---------- 1. 起服务 + 灌种子 ---------- */
if (!SKIP_UP) {
  line("1. docker compose up -d --build --wait");
  const up = sh(DOCKER, ["compose", "up", "-d", "--build", "--wait"], { cwd: DEPLOY });
  if (up.code !== 0) {
    console.error(up.out.split(/\r?\n/).slice(-15).join("\n"));
    process.exit(1);
  }
  console.log("  ✓ 服务已就绪（三容器 healthy）");

  line("2. 灌演示数据（seed 一次性容器）");
  const seed = sh(DOCKER, ["compose", "run", "--rm", "--build", "seed"], { cwd: DEPLOY });
  if (seed.code !== 0) {
    console.error(seed.out.split(/\r?\n/).slice(-12).join("\n"));
    process.exit(1);
  }
  console.log("  ✓ " + (seed.out.split(/\r?\n/).filter((l) => /种子完成|角色数据就绪/.test(l)).pop() || "seed ok"));
}
if (!(await waitHealth("起服务"))) process.exit(1);

/* ---------- 3. 逐套件（每个前重置数据 + 重启容器） ---------- */
const SUITES = [
  // e2e / rules 依赖 send-code 回显 devCode；镜像内 NODE_ENV=production 恒不回显，故不在容器上跑（CI 主机栈覆盖）
  ["security（53）", "test/security.test.js", {}],
  ["races（27）", "tools/check-money-races.mjs", {}],
  ["privacy（38）", "tools/check-privacy-auth.mjs", {}],
  ["permissions（17）", "tools/check-permissions.mjs", {}],
  ["concurrency（23）", "tools/concurrency-mysql.mjs", {}],
  ["admin SPA（38）", "tools/check-admin-spa.mjs", {}],
  ["mobile SPA（41）", "tools/check-mobile-spa.mjs", {}],
  ["镜像运行契约（33）", "tools/check-image-runtime.mjs", {}],
  ["MySQL 巡检（12）", "tools/healthcheck-mysql.mjs", { cwd: APP }],
];

line("3. 套件验收（每个套件前重置数据并重启 app 容器）");
const results = [];
let first = true;
for (const [label, script, opts] of SUITES) {
  if (!first) {
    const reset = node("tools/ci-reset.mjs");
    if (reset.code !== 0) {
      console.error(`  ✗ ${label} 前置重置失败：` + reset.out.split(/\r?\n/).slice(-3).join(" / "));
      results.push({ label, code: reset.code });
      continue;
    }
  }
  first = false;
  const t0 = Date.now();
  const r = node(script, { cwd: opts.cwd ? path.join(ROOT, "apps", "api-nest") : ROOT });
  const tail = r.out
    .split(/\r?\n/)
    .filter((l) => /通过\s*\d+\s*项|共 \d+ 项|失败\s*\d+|✗/.test(l))
    .slice(-1)[0] || "";
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ${r.code === 0 ? "✓" : "✗"} ${label.padEnd(20)} ${secs}s  ${tail.trim().slice(0, 90)}`);
  results.push({ label, code: r.code, tail: tail.trim() });
}

/* ---------- 4. 汇总 ---------- */
line("4. 汇总");
const bad = results.filter((r) => r.code !== 0);
for (const r of results) console.log(`  ${r.code === 0 ? "✓" : "✗"} ${r.label}${r.tail ? "  " + r.tail.slice(0, 80) : ""}`);
if (bad.length) {
  console.log(`\n✗ 容器栈验收失败 ${bad.length} / ${results.length}`);
  process.exit(1);
}
console.log(`\n✓ 容器栈验收全部通过（${results.length} 个套件）`);
console.log(`  访问：http://localhost:4300/admin-vue/ · /m/ · /parent`);
