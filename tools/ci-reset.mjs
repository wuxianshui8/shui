// ============================================================
// 数据重置：让「依赖干净种子」的用例彼此隔离
//
//   问题（Actions 首跑实测）：integration job 里 e2e → security → rules → races
//   依次跑在同一个库上，而 races / privacy / permissions / SPA 校验断言的是
//   种子里的精确金额（如「余额 ¥164.00」）。前面的用例改过钱包/订单后，
//   后面的断言必然失败——本地之所以不暴露，是因为每条 gate-*.mjs 都会重新建库。
//
//   本脚本做与 gate-p6 等价的准备：
//     0. RESET_TARGET=docker 时先 `stop app`（避免破坏窗口内被定时任务/旧连接池写入）
//     1. DROP + CREATE 数据库，重放 db/schema.mysql.sql（37 表；schema 先读后动库）
//     2. 跑 db/seed-min.mjs 灌种子
//     3. 清 Redis（失败即失败：脏缓存会让后续断言虚假失败）
//     4. RESET_TARGET 决定是否重启：
//          docker → `up -d app` + 等 /api/health（推荐，容器栈用）
//          local  → Windows 不支持（pkill/netstat 语义不同会假成功，直接拒绝）；Linux 上 pkill+spawn
//          none   → 只重置数据（调用方需自行处理进程内规则缓存，300s TTL）
//
// 用法：
//   node tools/ci-reset.mjs                          # 只重置数据
//   RESET_TARGET=docker node tools/ci-reset.mjs      # 容器栈：stop→重建→seed→flush→start
//   RESTART_API=1 node tools/ci-reset.mjs            # Linux/CI：重置 + 重启本机 node 进程
// 环境变量：MYSQL_HOST/PORT/USER/PASSWORD/DATABASE、REDIS_HOST/PORT、PORT、BASE_URL、COMPOSE_BIN
// ============================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP = path.join(ROOT, "apps", "api-nest");
const require_ = createRequire(path.join(APP, "package.json"));

const DB = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3307),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "jiajiao",
};
const REDIS = { host: process.env.REDIS_HOST || "127.0.0.1", port: Number(process.env.REDIS_PORT || 6380) };
const API_PORT = Number(process.env.PORT || 4300);
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${API_PORT}`;
const RESTART_API = process.env.RESTART_API === "1";
const RESET_TARGET = process.env.RESET_TARGET || (RESTART_API ? "local" : "none");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`  · ${m}`);
const composeCmd = process.env.COMPOSE_BIN || "docker";
const dockerCompose = (...rest) =>
  spawnSync(composeCmd, ["compose", "-f", path.join(ROOT, "deploy", "docker-compose.yml"), ...rest], {
    cwd: ROOT,
    encoding: "utf8",
  });

async function waitHealth(label) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return true;
    } catch {}
    await sleep(500);
  }
  console.error(`✗ ${label}后 30 秒内 /api/health 未就绪`);
  return false;
}

// Windows 上 local 分支不可用：pkill 不存在、netstat 参数语义不同，
// 旧 API 杀不掉时新进程绑不上端口，而 waitHealth 会被「旧进程」应答 200 → 假成功。
if (RESET_TARGET === "local" && process.platform === "win32") {
  console.error("✗ Windows 不支持 RESET_TARGET=local（pkill/netstat 语义不同，会假成功）");
  console.error("  请改用 RESET_TARGET=docker（容器栈）或 none（仅重置数据）");
  process.exit(1);
}

// schema 先读进内存再动数据库：否则 DROP 成功、文件读失败 → 留下空库
const schemaPath = path.join(APP, "db", "schema.mysql.sql");
if (!fs.existsSync(schemaPath)) {
  console.error(`✗ 找不到 ${schemaPath}，已中止（未改动数据库）`);
  process.exit(1);
}
const schemaSql = fs.readFileSync(schemaPath, "utf8");
if (!fs.existsSync(path.join(APP, "db", "seed-min.mjs"))) {
  console.error("✗ 找不到 apps/api-nest/db/seed-min.mjs，已中止（未改动数据库）");
  process.exit(1);
}

console.log(`数据重置（库 ${DB.host}:${DB.port}/${DB.database}，Redis ${REDIS.host}:${REDIS.port}，目标=${RESET_TARGET}）`);

/* ---------- 0. 容器栈：先停 app ---------- */
if (RESET_TARGET === "docker") {
  const stop = dockerCompose("stop", "app");
  log(stop.status === 0 ? "已停止 app 容器（避免破坏窗口内被写入）" : "app 容器原本未运行（继续）");
}

/* ---------- 1. 重建数据库 ---------- */
const mysql = require_("mysql2/promise");
let dbOk = true;
const admin = await mysql.createConnection({
  host: DB.host,
  port: DB.port,
  user: DB.user,
  password: DB.password,
  multipleStatements: true,
});
try {
  await admin.query(`DROP DATABASE IF EXISTS \`${DB.database}\``);
  await admin.query(`CREATE DATABASE \`${DB.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await admin.query(`USE \`${DB.database}\``); // schema 里的 CREATE TABLE 不带库名
  log(`数据库已重建：${DB.database}`);
  await admin.query(schemaSql);
  log("建表完成（schema.mysql.sql）");
} catch (e) {
  dbOk = false;
  console.error("✗ 重建数据库失败：" + e.message);
} finally {
  await admin.end();
}
if (!dbOk) process.exit(1);

/* ---------- 2. 灌种子 ---------- */
const seed = spawnSync(process.execPath, ["db/seed-min.mjs"], { cwd: APP, encoding: "utf8", env: process.env });
if (seed.status !== 0) {
  console.error(seed.stdout || "");
  console.error(seed.stderr || "");
  process.exit(1);
}
log((seed.stdout || "").trim().split(/\r?\n/).slice(-1)[0] || "种子已灌入");

/* ---------- 3. 清 Redis ---------- */
const Redis = require_("ioredis");
const redis = new Redis({ host: REDIS.host, port: REDIS.port, lazyConnect: true, retryStrategy: () => null });
let redisFailed = false;
try {
  await redis.connect();
  await redis.flushall();
  log("Redis 已清空（规则缓存 / 计数器 / 锁）");
} catch (e) {
  redisFailed = true;
  console.error("✗ Redis 清理失败：" + e.message.split("\n")[0]);
} finally {
  redis.disconnect();
}
if (redisFailed) process.exit(1);

/* ---------- 4. 重启 / 启动 API ---------- */
if (RESET_TARGET === "docker") {
  const up = dockerCompose("up", "-d", "--wait", "app");
  if (up.status !== 0) {
    console.error("✗ docker compose up -d app 失败：" + (up.stderr || "").split("\n")[0]);
    process.exit(1);
  }
  log("已启动 app 容器");
  if (!(await waitHealth("容器启动"))) process.exit(1);
  log(`容器内 API 已就绪：${BASE_URL}`);
} else if (RESET_TARGET === "local") {
  const kill = spawnSync("pkill", ["-f", "node dist/main.js"], { encoding: "utf8" });
  log(kill.status === 0 ? "旧 API 进程已结束" : "无旧 API 进程需要结束");
  // 等端口真正释放（最多 10s）
  for (let i = 0; i < 20; i++) {
    const r = spawnSync("sh", ["-c", `curl -s -o /dev/null -w "%{http_code}" ${BASE_URL}/api/health || true`], { encoding: "utf8" });
    if (!/200/.test(r.stdout || "")) break;
    await sleep(500);
  }
  const logFd = fs.openSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "api-ci-reset.log"), "a");
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: APP,
    env: process.env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  if (!(await waitHealth("API 重启"))) process.exit(1);
  log(`API 已重启并就绪：${BASE_URL}`);
} else {
  log("跳过重启（RESET_TARGET=none）：如改过规则配置，进程内缓存仍有 300s TTL，必要时手动重启 API");
}

console.log(`✓ 数据重置完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
