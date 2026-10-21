// ============================================================
// 数据迁移：SQLite（参考实现库） → MySQL 8（NestJS 权威库）
//   1. 读取 SQLite 全部业务表
//   2. 与 MySQL 目标表取列交集（自动跳过生成列，如 invoices.active_order_id）
//   3. 分批写入，逐表比对行数并做关键汇总校验
// 用法：MYSQL_DATABASE=jiajiao_migrate node tools/migrate-sqlite.mjs
//       MIGRATE_TRUNCATE=1 时先清空目标表（仅迁移演练用）
// ============================================================
import { createRequire } from "node:module";
import { all as sqliteAll, get as sqliteGet } from "../server/core/db.js";

const requireFromApi = createRequire(new URL("../apps/api-nest/package.json", import.meta.url));
const mysql = requireFromApi("mysql2/promise");

const DB = process.env.MYSQL_DATABASE || "jiajiao_migrate";
const TRUNCATE = process.env.MIGRATE_TRUNCATE === "1";
const BATCH = 200;

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3307),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: DB,
  supportBigNumbers: true,
  bigNumberStrings: false,
  multipleStatements: false,
});

const sqliteTables = sqliteAll(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
).map((r) => r.name);

const mysqlCols = async (table) => {
  const rows = (await conn.query(
    "SELECT COLUMN_NAME AS c, EXTRA AS e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    [DB, table],
  ))[0];
  return rows.filter((r) => !String(r.e || "").toUpperCase().includes("GENERATED")).map((r) => r.c);
};

console.log("数据迁移：SQLite → MySQL（目标库 " + DB + "）\n");
let migrated = 0;
const report = [];
const skipped = [];

for (const table of sqliteTables) {
  const targetCols = await mysqlCols(table);
  if (!targetCols.length) {
    skipped.push(table + "（MySQL 无此表）");
    continue;
  }
  const sourceCols = sqliteAll("PRAGMA table_info(`" + table + "`)").map((r) => r.name);
  const cols = targetCols.filter((c) => sourceCols.includes(c));
  if (!cols.length) {
    skipped.push(table + "（无共同列）");
    continue;
  }
  const srcCount = Number(sqliteGet("SELECT COUNT(*) AS c FROM `" + table + "`").c);
  if (TRUNCATE) await conn.query("DELETE FROM `" + table + "`");
  const rows = sqliteAll("SELECT " + cols.map((c) => "`" + c + "`").join(",") + " FROM `" + table + "`");
  let ok = 0;
  if (rows.length) {
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const placeholders = chunk.map(() => "(" + cols.map(() => "?").join(",") + ")").join(",");
      const values = [];
      for (const r of chunk) for (const c of cols) values.push(r[c] === undefined ? null : r[c]);
      const sql =
        "INSERT INTO `" + table + "` (" + cols.map((c) => "`" + c + "`").join(",") + ") VALUES " + placeholders +
        " ON DUPLICATE KEY UPDATE `" + cols[0] + "` = VALUES(`" + cols[0] + "`)";
      try {
        await conn.query(sql, values);
        ok += chunk.length;
      } catch (e) {
        report.push({ table, ok: false, detail: "写入失败：" + e.message, src: srcCount, dst: 0 });
        break;
      }
    }
  }
  const dstCount = Number((await conn.query("SELECT COUNT(*) AS c FROM `" + table + "`"))[0][0].c);
  migrated += ok;
  report.push({ table, ok: dstCount >= srcCount, detail: "行数 " + dstCount + " / 源 " + srcCount, src: srcCount, dst: dstCount });
}

console.log("表名".padEnd(24) + "结果    明细");
for (const r of report) {
  console.log(
    r.table.padEnd(24) + (r.ok ? "  ✓   " : "  ✗   ") + r.detail,
  );
}
if (skipped.length) console.log("\n跳过：" + skipped.join("；"));

console.log("\n合计写入 " + migrated + " 行，共 " + report.length + " 张表");

/* ---------------- 关键汇总校验（迁移后必须一致） ---------------- */
const q = async (sql) => Number((await conn.query(sql))[0][0]?.v ?? 0);
const checks = [];
const cmp = async (name, sqliteSql, mysqlSql) => {
  const a = Number(sqliteGet(sqliteSql).v);
  const b = await q(mysqlSql);
  checks.push({ name, ok: a === b, detail: "SQLite " + a + " / MySQL " + b });
};
await cmp("用户数一致", "SELECT COUNT(*) AS v FROM users", "SELECT COUNT(*) AS v FROM `users`");
await cmp("订单数一致", "SELECT COUNT(*) AS v FROM orders", "SELECT COUNT(*) AS v FROM `orders`");
await cmp("钱包余额总额一致", "SELECT COALESCE(SUM(balance),0) AS v FROM wallets", "SELECT COALESCE(SUM(`balance`),0) AS v FROM `wallets`");
await cmp(
  "担保台账余额一致",
  "SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END),0) AS v FROM escrow_ledger",
  "SELECT COALESCE(SUM(CASE WHEN `direction` = 'in' THEN `amount` ELSE -`amount` END),0) AS v FROM `escrow_ledger`",
);
await cmp(
  "平台净收入一致",
  "SELECT COALESCE(SUM(platform_revenue),0) AS v FROM orders",
  "SELECT COALESCE(SUM(`platform_revenue`),0) AS v FROM `orders`",
);
await cmp("规则组数一致", "SELECT COUNT(*) AS v FROM rule_configs", "SELECT COUNT(*) AS v FROM `rule_configs`");

console.log("");
let bad = 0;
for (const c of checks) {
  console.log((c.ok ? "  ✓ " : "  ✗ ") + c.name + "  —  " + c.detail);
  if (!c.ok) bad++;
}
const tableBad = report.filter((r) => !r.ok).length;
console.log("\n汇总校验 " + checks.length + " 项，异常 " + bad + "；表级异常 " + tableBad + " 张");
await conn.end();
process.exitCode = bad || tableBad ? 1 : 0;
