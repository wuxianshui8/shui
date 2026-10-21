// ============================================================
// 容器栈功能验收：在 docker compose 起来的服务上跑完整的业务套件
//
//   为什么需要：`docker compose ps` 显示 healthy、四个入口 200 只能证明「起来了」，
//   不能证明容器里的 API/DB/Redis 组合与业务规则等价。本脚本按 CI 相同的顺序，
//   在**每个**套件前重置数据（ci-reset：stop app → DROP/CREATE 库 → 灌种子 →
//   清 Redis → start app），把 9 个套件全部跑一遍。
//
//   前置：Docker Desktop 已启动；deploy/.env 有真实 AUTH_SECRET；宿主机侧已
//         `npm install`（tools 用 apps/api-nest/node_modules）并 `tsc` 编译过（dist）。
//   用法：node tools/verify-docker.mjs            # 全流程（up + seed + 9 套件）
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
const VERBOSE = process.env.VERBOSE === "1"; // 失败时打印该套件完整输出的开关

const line = (m) => console.log("\n=== " + m + " ===");
const die = (m) => {
  console.error("\n✗ " + m);
  process.exit(1);
};

/** 剥掉成对引号（compose 读 .env 时会剥，这里保持一致） */
function unquote(v) {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/* ---------- 0. 前置检查（顺序很重要：先确认 .env 存在，再解析）---------- */
line("0. 前置检查");
const envFile = path.join(DEPLOY, ".env");
if (!fs.existsSync(envFile)) {
  die("缺少 deploy/.env：请先复制 deploy/.env.example 为 .env 并填入真实 AUTH_SECRET（或直接跑 deploy\\up.bat）");
}
const envText = fs.readFileSync(envFile, "utf8");
if (/please-change-me/.test(envText)) die("deploy/.env 的 AUTH_SECRET 还是模板占位符，请换成真实随机串");

// 解析 .env 注入子进程：concurrency 等脚本在宿主机本地签 token，
// 必须与容器内的 AUTH_SECRET 完全一致，否则 100 次报名全 401（真实踩过）
const dotenv = {};
for (const raw of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.trim());
  if (m) dotenv[m[1]] = unquote(m[2]);
}

const env = {
  ...dotenv,
  ...process.env, // shell 里显式导出的优先（与 compose 的优先级一致）
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

const info = sh(DOCKER, ["info", "--format", "{{.ServerVersion}}"]);
if (info.code !== 0 || !/^\d/.test(info.out.trim())) die("Docker 引擎未就绪（请先启动 Docker Desktop 并等鲸鱼图标变绿）");
console.log(`  引擎 server=${info.out.trim()}  BASE_URL=${BASE_URL}  MySQL=3307 Redis=6380`);

// 宿主机侧依赖：9 个套件都在宿主机跑，缺 dist/node_modules 会在中途才炸
if (!fs.existsSync(path.join(APP, "dist", "main.js"))) {
  die("缺少 apps/api-nest/dist：请先编译（cd apps/api-nest && node node_modules/typescript/bin/tsc -p tsconfig.json）");
}
if (!fs.existsSync(path.join(APP, "node_modules", "mysql2"))) {
  die("缺少 apps/api-nest/node_modules：请先 npm install（tools 脚本从这里解析 mysql2/ioredis）");
}
console.log("  宿主机侧 dist + node_modules 就绪");
console.log(`  说明：镜像内 NODE_ENV=production，验证码永不回显（安全设计），因此 e2e/rules 这类依赖 devCode 的套件不在容器上跑；它们由 CI 的主机栈覆盖。`);

/* ---------- 1. 起服务 + 灌种子 ---------- */
if (!SKIP_UP) {
  line("1. docker compose up -d --build --wait（超时 180s）");
  const up = sh(DOCKER, ["compose", "up", "-d", "--build", "--wait", "--wait-timeout", "180"], { cwd: DEPLOY });
  if (up.code !== 0) {
    console.error(up.out.split(/\r?\n/).slice(-15).join("\n"));
    const ps = sh(DOCKER, ["compose", "ps"], { cwd: DEPLOY });
    console.error("  当前栈状态：\n" + ps.out);
    die("compose up 失败；栈可能处于半启动状态，重跑前可先 `docker compose down -v`");
  }
  console.log("  ✓ 服务已就绪（三容器 healthy）");

  line("2. 灌演示数据（seed 一次性容器）");
  const seed = sh(DOCKER, ["compose", "run", "--rm", "--build", "seed"], { cwd: DEPLOY });
  if (seed.code !== 0) {
    console.error(seed.out.split(/\r?\n/).slice(-12).join("\n"));
    die("seed 失败");
  }
  console.log("  ✓ " + (seed.out.split(/\r?\n/).filter((l) => /种子完成|角色数据就绪/.test(l)).pop() || "seed ok"));
}
if (!(await waitHealth("起服务"))) process.exit(1);

// 关键：容器内实际生效的 AUTH_SECRET 必须与宿主机注入的一致，否则本地签的 token 全 401
const printenv = sh(DOCKER, ["compose", "exec", "-T", "app", "printenv", "AUTH_SECRET"], { cwd: DEPLOY });
const containerSecret = printenv.out.trim();
if (printenv.code !== 0 || !containerSecret) {
  die("无法读取容器内 AUTH_SECRET（app 容器未运行？）：" + printenv.out.slice(0, 120));
}
if (containerSecret !== env.AUTH_SECRET) {
  die(
    `AUTH_SECRET 不一致：容器内长度 ${containerSecret.length}，宿主机注入长度 ${(env.AUTH_SECRET || "").length}。\n` +
      "  宿主机本地签发的 token 会被容器拒绝（401）。请让 deploy/.env 与 shell 环境里的 AUTH_SECRET 保持同一值。",
  );
}
console.log(`  ✓ AUTH_SECRET 与容器一致（长度 ${containerSecret.length}）`);

/* ---------- 3. 逐套件（每个前重置数据 + 停/起 app 容器） ---------- */
const SUITES = [
  ["security（53）", "test/security.test.js"],
  ["races（27）", "tools/check-money-races.mjs"],
  ["privacy（38）", "tools/check-privacy-auth.mjs"],
  ["permissions（17）", "tools/check-permissions.mjs"],
  ["concurrency（23）", "tools/concurrency-mysql.mjs"],
  ["admin SPA（38）", "tools/check-admin-spa.mjs"],
  ["mobile SPA（41）", "tools/check-mobile-spa.mjs"],
  ["镜像运行契约（33）", "tools/check-image-runtime.mjs"],
  ["MySQL 巡检（12）", "tools/healthcheck-mysql.mjs"],
];

line("3. 套件验收（每个套件前重置数据并重启 app 容器）");
const results = [];
for (const [label, script] of SUITES) {
  const reset = node("tools/ci-reset.mjs");
  if (reset.code !== 0) {
    console.error(`  ✗ ${label} 前置重置失败，中止（避免半成品栈上连环误判）：`);
    console.error(reset.out.split(/\r?\n/).slice(-5).join("\n"));
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1500)); // 容器刚重启，给连接池/规则缓存 1.5s 稳定
  const t0 = Date.now();
  const r = node(script);
  const tail =
    r.out
      .split(/\r?\n/)
      .filter((l) => /通过\s*\d+\s*项|共 \d+ 项|失败\s*\d+|✗/.test(l))
      .slice(-1)[0] || "";
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ${r.code === 0 ? "✓" : "✗"} ${label.padEnd(20)} ${secs}s  ${tail.trim().slice(0, 90)}`);
  results.push({ label, code: r.code, tail: tail.trim() });
  if (VERBOSE || r.code !== 0) {
    console.log("    ---- " + label + " 输出（末 25 行）----");
    for (const l of r.out.split(/\r?\n/).slice(-25)) console.log("    | " + l);
  }
}

/* ---------- 4. 汇总 ---------- */
line("4. 汇总");
for (const r of results) console.log(`  ${r.code === 0 ? "✓" : "✗"} ${r.label}${r.tail ? "  " + r.tail.slice(0, 80) : ""}`);
const bad = results.filter((r) => r.code !== 0);
if (bad.length) {
  console.log(`\n✗ 容器栈验收失败 ${bad.length} / ${results.length}`);
  process.exit(1);
}
console.log(`\n✓ 容器栈验收全部通过（${results.length} 个套件）`);
console.log(`  访问：http://localhost:4300/admin-vue/ · /m/ · /parent`);
