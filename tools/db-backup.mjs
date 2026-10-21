// ============================================================
// 数据库备份（容器栈 / 本机便携 MySQL 两种模式自适应）
//
//   为什么需要：容器化部署此前只有「起服务 + 灌种子」，没有任何备份/恢复手段；
//   生产化第一步就是能把库整体导出并验证可读。
//
//   模式：
//     MYSQL_MODE=docker → docker compose exec -T mysql mysqldump ...（推荐，容器栈）
//     MYSQL_MODE=host   → 用 tools/mysql-8.4.0-winx64/bin/mysqldump.exe 连 127.0.0.1:3307
//     MYSQL_MODE 未设时：容器在跑就用 docker，否则 host
//
// 用法：
//   node tools/db-backup.mjs                       # → backups/jiajiao-<时间戳>.sql.gz
//   OUT_DIR=D:\bak node tools/db-backup.mjs        # 指定输出目录
//   产出文件可直接用 tools/db-restore.mjs 还原
// ============================================================
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEPLOY = path.join(ROOT, "deploy");
const DB = process.env.MYSQL_DATABASE || "jiajiao";
const DOCKER = process.env.DOCKER_BIN || "docker";
const OUT_DIR = process.env.OUT_DIR || path.join(ROOT, "backups");

const die = (m) => {
  console.error("✗ " + m);
  process.exit(1);
};

function detectMode() {
  if (process.env.MYSQL_MODE) return process.env.MYSQL_MODE;
  const ps = spawnSync(DOCKER, ["compose", "-f", path.join(DEPLOY, "docker-compose.yml"), "ps", "--status", "running", "mysql"], {
    encoding: "utf8",
  });
  return ps.status === 0 && /jiajiao-mysql|mysql/i.test(ps.stdout || "") ? "docker" : "host";
}

const mode = detectMode();
if (!["docker", "host"].includes(mode)) die(`MYSQL_MODE 只能是 docker 或 host（当前 ${mode}）`);

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `jiajiao-${stamp}.sql.gz`);

const DUMP_ARGS = ["--single-transaction", "--routines", "--triggers", "--no-tablespaces", "--set-gtid-purged=OFF", DB];

let dump;
if (mode === "docker") {
  console.log(`备份模式：docker（容器 jiajiao-mysql-1）→ ${path.relative(ROOT, outFile)}`);
  dump = spawnSync(DOCKER, ["compose", "-f", path.join(DEPLOY, "docker-compose.yml"), "exec", "-T", "mysql", "mysqldump", "-uroot", ...DUMP_ARGS], {
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
  });
} else {
  const mysqldump = path.join(ROOT, "tools", "mysql-8.4.0-winx64", "bin", "mysqldump.exe");
  if (!fs.existsSync(mysqldump)) die(`找不到 ${mysqldump}（本机便携 MySQL 未安装？）请改用 MYSQL_MODE=docker`);
  const port = process.env.MYSQL_PORT || "3307";
  console.log(`备份模式：host（127.0.0.1:${port}）→ ${path.relative(ROOT, outFile)}`);
  dump = spawnSync(
    mysqldump,
    ["-h", "127.0.0.1", "-P", port, "-u", process.env.MYSQL_USER || "root", ...(process.env.MYSQL_PASSWORD ? [`-p${process.env.MYSQL_PASSWORD}`] : []), ...DUMP_ARGS],
    { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
  );
}

if (dump.status !== 0) {
  console.error((dump.stderr || "").toString().slice(0, 800));
  die("mysqldump 失败");
}
const sql = dump.stdout;
if (!sql || sql.length < 1024) die("dump 输出过小，疑似失败");

// 立即压缩 + 自检：必须含建表语句，且表数量符合预期
const gz = zlib.gzipSync(sql, { level: 9 });
fs.writeFileSync(outFile, gz);
const check = zlib.gunzipSync(fs.readFileSync(outFile)).toString("utf8");
const tables = (check.match(/CREATE TABLE `/g) || []).length;
const hasOrders = /CREATE TABLE `orders`/.test(check);
const inserts = (check.match(/INSERT INTO /g) || []).length;

console.log(`  · 原始 ${(sql.length / 1024).toFixed(0)} KB → 压缩 ${(gz.length / 1024).toFixed(0)} KB`);
console.log(`  · 表数 ${tables}（应为 37）· INSERT 语句 ${inserts} 条 · 含 orders 表：${hasOrders ? "是" : "否"}`);
if (tables !== 37) die(`备份内表数 ${tables} ≠ 37，备份不可信`);
if (!hasOrders) die("备份内缺少 orders 表，备份不可信");

console.log(`✓ 备份完成：${outFile}`);
console.log(`  还原：node tools/db-restore.mjs "${outFile}" --yes`);
