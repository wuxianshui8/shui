// P6 门禁：启动 MySQL/Redis + 建库 + 种子 + NestJS，跑 e2e §1–§17（可按 E2E_SECTION / E2E_SCRIPT 调整）
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";

const TOOLS = "D:/shui/tools";
const MYSQL = TOOLS + "/mysql-8.4.0-winx64";
const APP = "D:/shui/apps/api-nest";
const PORT = Number(process.env.NEST_PORT || 4300);
const SECTION = process.env.E2E_SECTION || "17";
const SCRIPT = process.env.E2E_SCRIPT || "test/e2e.test.js";
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (p) => new Promise((res) => { const s = net.connect({ host: "127.0.0.1", port: p }, () => { s.destroy(); res(true); }); s.on("error", () => res(false)); s.setTimeout(800, () => { s.destroy(); res(false); }); });
async function waitPort(p, tries = 40) { for (let i = 0; i < tries; i++) { if (await portOpen(p)) return true; await sleep(400); } return false; }
function start(bin, args, cwd) { const p = spawn(bin, args, { cwd, detached: true, stdio: "ignore", windowsHide: true }); p.unref(); children.push(p); return p; }
const mysqlCli = (args) => execFileSync(MYSQL + "/bin/mysql.exe", ["-h", "127.0.0.1", "-P", "3307", "-u", "root", "--skip-password", ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
function stopAll() { for (const p of children) { try { process.kill(-p.pid); } catch { try { p.kill("SIGKILL"); } catch {} } } }

(async () => {
  try {
    if (!existsSync(MYSQL + "/bin/mysqld.exe")) { console.log("缺少本地 MySQL，请先运行 tools/setup-services.ps1"); process.exit(1); }
    start(MYSQL + "/bin/mysqld.exe", ["--basedir=" + MYSQL, "--datadir=" + TOOLS + "/mysql-data", "--port=3307", "--bind-address=127.0.0.1", "--mysqlx=OFF"], MYSQL);
    start(TOOLS + "/redis/redis-server.exe", ["--port", "6380", "--bind", "127.0.0.1"], TOOLS + "/redis");
    const okMy = await waitPort(3307);
    const okRd = await waitPort(6380, 20);
    console.log("依赖服务 MySQL=" + okMy + " Redis=" + okRd);
    if (!okMy) throw new Error("MySQL 未启动");

    mysqlCli(["-e", "DROP DATABASE IF EXISTS jiajiao; CREATE DATABASE jiajiao DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"]);
    execFileSync(MYSQL + "/bin/mysql.exe", ["-h", "127.0.0.1", "-P", "3307", "-u", "root", "--skip-password", "jiajiao"], { input: readFileSync(APP + "/db/schema.mysql.sql"), stdio: ["pipe", "pipe", "ignore"] });

    execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], { cwd: APP, stdio: "inherit" });
    console.log(execFileSync(process.execPath, ["db/seed-min.mjs"], { cwd: APP, encoding: "utf8" }).trim());

    // 定时任务间隔放大，避免后台结算与手动结算用例互相干扰
    start(process.execPath, ["dist/main.js"], APP);
    const okApi = await waitPort(PORT, 30);
    console.log("NestJS 就绪 :" + PORT + " -> " + okApi);
    if (!okApi) throw new Error("NestJS 未启动");
  } catch (e) {
    console.error("[准备阶段失败]", e.message);
    stopAll();
    process.exit(1);
  }

  // 复用既有 e2e 套件（HTTP 契约级），默认跑到第 17 组：全链路（规则中心 / 风控仲裁 / 运营工具 / 订单导出 / 后台管理）
  const { execFileSync: run } = await import("node:child_process");
  try {
    const out = run(process.execPath, [SCRIPT], {
      cwd: "D:/shui",
      env: { ...process.env, BASE_URL: "http://localhost:" + PORT, E2E_MAX_SECTION: SECTION, JOBS_ENABLED: "0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(out);
  } catch (e) {
    console.log(e.stdout || "");
    console.error(e.stderr || "");
    console.error("[P5 门禁未通过] " + SCRIPT + " (section<=" + SECTION + ")");
    stopAll();
    process.exit(1);
  } finally {
    stopAll();
    await sleep(500);
    console.log("(已停止本地服务)");
  }
})();
