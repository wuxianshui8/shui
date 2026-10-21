// ============================================================
// CI 数据重置：让「依赖干净种子」的用例彼此隔离
//
//   问题（Actions 首跑实测）：integration job 里 e2e → security → rules → races
//   依次跑在同一个库上，而 races / privacy / permissions / SPA 校验断言的是
//   种子里的精确金额（如「余额 ¥164.00」）。前面的用例改过钱包/订单后，
//   后面的断言必然失败——本地之所以不暴露，是因为每条 gate-*.mjs 都会重新建库。
//
//   本脚本做与 gate-p6 等价的准备：
//     1. DROP + CREATE 数据库，重放 db/schema.mysql.sql（37 表）
//     2. 跑 db/seed-min.mjs 灌种子
//     3. 清 Redis（规则缓存 / 计数器 / 锁）
//     4. RESTART_API=1 时：重启 node dist/main.js 并等 /api/health 就绪
//        （必须重启：旧连接池指向已被 DROP 的库，且规则缓存需要重新预热）
//
// 用法：
//   node tools/ci-reset.mjs                     # 只重置数据（本地配合 gate 脚本时用）
//   RESTART_API=1 node tools/ci-reset.mjs       # CI 用：重置 + 重启 API
// 环境变量：MYSQL_HOST/PORT/USER/PASSWORD/DATABASE、REDIS_HOST/PORT、PORT、BASE_URL
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`  · ${m}`);

console.log(`CI 数据重置（库 ${DB.host}:${DB.port}/${DB.database}，Redis ${REDIS.host}:${REDIS.port}${RESTART_API ? "，重启 API" : ""}）`);

/* ---------- 1. 重建数据库 ---------- */
const mysql = require_("mysql2/promise");
const admin = await mysql.createConnection({ host: DB.host, port: DB.port, user: DB.user, password: DB.password, multipleStatements: true });
try {
  await admin.query(`DROP DATABASE IF EXISTS \`${DB.database}\``);
  await admin.query(`CREATE DATABASE \`${DB.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  // 必须显式选库：schema.mysql.sql 里的 CREATE TABLE 不带库名
  await admin.query(`USE \`${DB.database}\``);
  log(`数据库已重建：${DB.database}`);

  const schema = fs.readFileSync(path.join(APP, "db", "schema.mysql.sql"), "utf8");
  await admin.query(schema);
  log("建表完成（schema.mysql.sql）");
} catch (e) {
  console.error("✗ 重建数据库失败：" + e.message);
  process.exit(1);
} finally {
  await admin.end();
}

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
try {
  await redis.connect();
  await redis.flushall();
  log("Redis 已清空（规则缓存 / 计数器 / 锁）");
} catch (e) {
  log("Redis 清理跳过：" + e.message.split("\n")[0]);
} finally {
  redis.disconnect();
}

/* ---------- 4. 重启 API（可选） ---------- */
if (RESTART_API) {
  const kill = spawnSync("pkill", ["-f", "node dist/main.js"], { encoding: "utf8" });
  log(kill.status === 0 ? "旧 API 进程已结束" : "无旧 API 进程需要结束");
  // 等端口释放（最多 10s）
  for (let i = 0; i < 20; i++) {
    const r = spawnSync(process.platform === "win32" ? "netstat" : "sh", ["-c", `(curl -s -o /dev/null -w "%{http_code}" ${BASE_URL}/api/health || true)`], { encoding: "utf8" });
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
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) {
        up = true;
        break;
      }
    } catch {}
    await sleep(500);
  }
  if (!up) {
    console.error("✗ API 重启后 30 秒内未就绪");
    process.exit(1);
  }
  log(`API 已重启并就绪：${BASE_URL}`);
}

console.log(`✓ 数据重置完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
