// ============================================================
// 数据库恢复（把 db-backup.mjs 的产物还原到库里）
//
//   ⚠️ 破坏性操作：会 DROP 掉目标库再导入。必须显式加 --yes 才执行。
//
//   流程：读 .sql.gz → 校验（含 CREATE TABLE / 表数 37）→ DROP+CREATE 库 →
//         导入 → 复核（表数 37、users 有数据）→ 打印下一步建议
//
//   模式：MYSQL_MODE=docker（默认走容器）| host（本机便携 MySQL 3307）
// 用法：
//   node tools/db-restore.mjs backups/jiajiao-20261021xxxxxx.sql.gz --yes
// ============================================================
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEPLOY = path.join(ROOT, "deploy");
const APP = path.join(ROOT, "apps", "api-nest");
const DB = process.env.MYSQL_DATABASE || "jiajiao";
const DOCKER = process.env.DOCKER_BIN || "docker";
const require_ = createRequire(path.join(APP, "package.json"));

const die = (m) => {
  console.error("✗ " + m);
  process.exit(1);
};

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
const confirmed = process.argv.includes("--yes");
if (!file) die("用法：node tools/db-restore.mjs <backup.sql.gz> --yes");
if (!confirmed) die("这是破坏性操作（会 DROP 目标库）。确认无误请追加 --yes");
const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
if (!fs.existsSync(abs)) die(`文件不存在：${abs}`);

/* ---------- 1. 读取 + 校验 ---------- */
const raw = fs.readFileSync(abs);
const sqlBuf = /\.gz$/.test(abs) ? zlib.gunzipSync(raw) : raw;
const sql = sqlBuf.toString("utf8");
const tables = (sql.match(/CREATE TABLE `/g) || []).length;
if (tables < 30) die(`备份内仅 ${tables} 张表（应 37），文件可能不完整，已中止`);
console.log(`备份文件：${path.relative(ROOT, abs)}（${(raw.length / 1024).toFixed(0)} KB 压缩 → ${(sqlBuf.length / 1024).toFixed(0)} KB）`);
console.log(`  · 表数 ${tables} · INSERT ${(sql.match(/INSERT INTO /g) || []).length} 条`);

/* ---------- 2. 模式探测 ---------- */
const mode =
  process.env.MYSQL_MODE ||
  (spawnSync(DOCKER, ["compose", "-f", path.join(DEPLOY, "docker-compose.yml"), "ps", "--status", "running", "mysql"], { encoding: "utf8" })
    .stdout || ""
  ).match(/jiajiao-mysql/) !== null
    ? "docker"
    : "host";
console.log(`恢复目标：${mode === "docker" ? "容器 jiajiao-mysql-1" : "本机 127.0.0.1:" + (process.env.MYSQL_PORT || 3307)} / 库 ${DB}`);

/* ---------- 3. DROP + CREATE ---------- */
const mysql = require_("mysql2/promise");
const conn = await mysql.createConnection({
  host: "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || "3307"),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
});
try {
  await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await conn.query(`CREATE DATABASE \`${DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  console.log("  · 已重建空库");
} catch (e) {
  die("重建库失败：" + e.message);
} finally {
  await conn.end();
}

/* ---------- 4. 导入 ---------- */
let imp;
if (mode === "docker") {
  imp = spawnSync(
    DOCKER,
    ["compose", "-f", path.join(DEPLOY, "docker-compose.yml"), "exec", "-T", "mysql", "mysql", "-uroot", DB],
    { input: sqlBuf, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
  );
} else {
  const client = path.join(ROOT, "tools", "mysql-8.4.0-winx64", "bin", "mysql.exe");
  if (!fs.existsSync(client)) die(`找不到 ${client}，请改用 MYSQL_MODE=docker`);
  imp = spawnSync(
    client,
    ["-h", "127.0.0.1", "-P", process.env.MYSQL_PORT || "3307", "-u", process.env.MYSQL_USER || "root", DB],
    { input: sqlBuf, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
  );
}
if (imp.status !== 0) {
  console.error((imp.stderr || "").toString().slice(0, 800));
  die("导入失败");
}
console.log("  · 导入完成");

/* ---------- 5. 复核 ---------- */
const verify = await mysql.createConnection({
  host: "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || "3307"),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: DB,
});
try {
  const [[t]] = await verify.query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?",
    [DB],
  );
  const [[u]] = await verify.query("SELECT COUNT(*) AS n FROM users");
  const [[o]] = await verify.query("SELECT COUNT(*) AS n FROM orders");
  console.log(`  · 复核：表 ${t.n} / 用户 ${u.n} / 订单 ${o.n}`);
  if (Number(t.n) !== 37) die(`恢复后表数 ${t.n} ≠ 37`);
  if (Number(u.n) === 0) die("恢复后 users 表为空");
} finally {
  await verify.end();
}

console.log("✓ 恢复完成");
console.log("  下一步建议：");
console.log("    npm run nest:health:mysql            # 12 项一致性巡检（MYSQL_PORT=3307）");
console.log("    node tools/ci-reset.mjs              # 或直接重置成干净种子（会再次清库）");
