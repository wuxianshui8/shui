// ============================================================
// P9 门禁：SQLite → MySQL 数据迁移与双跑比对
//   1. 起 MySQL/Redis，建库 jiajiao_migrate 并装载 MySQL DDL
//   2. 重置并种子化 SQLite 参考库
//   3. 执行迁移（逐表行数比对 + 关键汇总校验）
//   4. 在迁移后的库上跑 MySQL 版一致性巡检（12 项）
// ============================================================
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";

const TOOLS = "D:/shui/tools";
const MYSQL = TOOLS + "/mysql-8.4.0-winx64";
const APP = "D:/shui/apps/api-nest";
const DB = "jiajiao_migrate";
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (p) => new Promise((res) => { const s = net.connect({ host: "127.0.0.1", port: p }, () => { s.destroy(); res(true); }); s.on("error", () => res(false)); s.setTimeout(800, () => { s.destroy(); res(false); }); });
async function waitPort(p, tries = 40) { for (let i = 0; i < tries; i++) { if (await portOpen(p)) return true; await sleep(400); } return false; }
function start(bin, args, cwd) { const p = spawn(bin, args, { cwd, detached: true, stdio: "ignore", windowsHide: true }); p.unref(); children.push(p); return p; }
const mysqlCli = (args) => execFileSync(MYSQL + "/bin/mysql.exe", ["-h", "127.0.0.1", "-P", "3307", "-u", "root", "--skip-password", ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
function stopAll() { for (const p of children) { try { process.kill(-p.pid); } catch { try { p.kill("SIGKILL"); } catch {} } } }

const runScript = (file, env = {}) => {
  const out = execFileSync(process.execPath, [file], {
    cwd: "D:/shui",
    env: { ...process.env, MYSQL_DATABASE: DB, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(out);
};

(async () => {
  let failed = false;
  try {
    if (!existsSync(MYSQL + "/bin/mysqld.exe")) throw new Error("缺少本地 MySQL，请先运行 tools/setup-services.ps1");
    start(MYSQL + "/bin/mysqld.exe", ["--basedir=" + MYSQL, "--datadir=" + TOOLS + "/mysql-data", "--port=3307", "--bind-address=127.0.0.1", "--mysqlx=OFF"], MYSQL);
    start(TOOLS + "/redis/redis-server.exe", ["--port", "6380", "--bind", "127.0.0.1"], TOOLS + "/redis");
    const okMy = await waitPort(3307);
    console.log("依赖服务 MySQL=" + okMy);
    if (!okMy) throw new Error("MySQL 未启动");

    mysqlCli(["-e", "DROP DATABASE IF EXISTS " + DB + "; CREATE DATABASE " + DB + " DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"]);
    execFileSync(MYSQL + "/bin/mysql.exe", ["-h", "127.0.0.1", "-P", "3307", "-u", "root", "--skip-password", DB], {
      input: readFileSync(APP + "/db/schema.mysql.sql"),
      stdio: ["pipe", "pipe", "ignore"],
    });
    console.log("MySQL 结构已装载：" + DB);

    console.log(execFileSync(process.execPath, ["server/seed.js", "--reset"], { cwd: "D:/shui", encoding: "utf8" }).trim().split("\n").slice(-1)[0]);
  } catch (e) {
    console.error("[准备阶段失败]", e.message);
    stopAll();
    process.exit(1);
  }

  console.log("\n===== 1. 迁移 SQLite → MySQL =====");
  try {
    runScript("tools/migrate-sqlite.mjs", { MIGRATE_TRUNCATE: "1" });
  } catch (e) {
    console.log(e.stdout || "");
    console.error(e.stderr || "");
    failed = true;
  }

  console.log("===== 2. 迁移后一致性巡检（MySQL 12 项）=====");
  try {
    runScript("tools/healthcheck-mysql.mjs");
  } catch (e) {
    console.log(e.stdout || "");
    console.error(e.stderr || "");
    failed = true;
  }

  stopAll();
  await sleep(500);
  console.log("\n" + (failed ? "P9 门禁未通过" : "P9 门禁通过 ✅（迁移行数与关键汇总一致、迁移后数据自洽）"));
  console.log("(已停止本地服务)");
  process.exit(failed ? 1 : 0);
})();
