// ============================================================
// 前台启动器：MySQL(3307) + Redis(6380) + NestJS(4300) 常驻，Ctrl+C 或关闭窗口即全部停止
// 用法：双击项目根目录 start.bat（推荐），或在本目录执行 tools\node\node.exe tools\run.mjs
// ============================================================
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOOLS = path.join(ROOT, "tools");
const MYSQL = path.join(TOOLS, "mysql-8.4.0-winx64");
const APP = path.join(ROOT, "apps", "api-nest");
const PORT = Number(process.env.NEST_PORT || 4300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port: p }, () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => res(false));
    s.setTimeout(800, () => {
      s.destroy();
      res(false);
    });
  });

async function waitPort(p, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await portOpen(p)) return true;
    await sleep(400);
  }
  return false;
}

function start(name, bin, args, cwd) {
  const p = spawn(bin, args, { cwd, stdio: "ignore", windowsHide: true });
  children.push({ name, pid: p.pid });
  p.on("exit", (code) => {
    if (code !== 0 && code !== null) console.log("[警告] " + name + " 退出，code=" + code);
  });
  return p;
}

function stopAll() {
  for (const c of children.reverse()) {
    try {
      execFileSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
      console.log("已停止 " + c.name + "（pid " + c.pid + "）");
    } catch {}
  }
}

process.on("SIGINT", () => {
  console.log("\n正在停止所有服务…");
  stopAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopAll();
  process.exit(0);
});

const mysqlCli = (args) =>
  execFileSync(path.join(MYSQL, "bin", "mysql.exe"),
    ["-h", "127.0.0.1", "-P", "3307", "-u", "root", "--skip-password", ...args],
    { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });

(async () => {
  /* 1) MySQL */
  if (!(await portOpen(3307))) {
    if (!existsSync(path.join(MYSQL, "bin", "mysqld.exe"))) {
      console.error("缺少 tools/mysql-8.4.0-winx64，请先运行 tools/setup-services.ps1");
      process.exit(1);
    }
    start("MySQL", path.join(MYSQL, "bin", "mysqld.exe"),
      ["--basedir=" + MYSQL, "--datadir=" + path.join(TOOLS, "mysql-data"),
        "--port=3307", "--bind-address=127.0.0.1", "--mysqlx=OFF"], MYSQL);
    if (!(await waitPort(3307))) {
      console.error("MySQL 启动失败");
      stopAll();
      process.exit(1);
    }
    console.log("✅ MySQL   :3307");
  } else {
    console.log("✅ MySQL   :3307（已在运行）");
  }

  /* 2) Redis */
  if (!(await portOpen(6380))) {
    start("Redis", path.join(TOOLS, "redis", "redis-server.exe"),
      ["--port", "6380", "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"],
      path.join(TOOLS, "redis"));
    await waitPort(6380, 20);
    console.log("✅ Redis   :6380");
  } else {
    console.log("✅ Redis   :6380（已在运行）");
  }

  /* 3) 首次运行：建库 + 灌演示数据 */
  let needSeed = false;
  try {
    mysqlCli(["-e", "SELECT COUNT(*) FROM `jiajiao`.`users`"]);
  } catch {
    needSeed = true;
  }
  if (needSeed) {
    console.log("… 初始化数据库 jiajiao（建表 + 演示数据，约 10 秒）");
    execFileSync(path.join(MYSQL, "bin", "mysql.exe"),
      ["-h", "127.0.0.1", "-P", "3307", "-u", "root", "--skip-password", "-e",
        "DROP DATABASE IF EXISTS jiajiao; CREATE DATABASE jiajiao DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"],
      { stdio: "ignore" });
    execFileSync(path.join(MYSQL, "bin", "mysql.exe"),
      ["-h", "127.0.0.1", "-P", "3307", "-u", "root", "--skip-password", "jiajiao"],
      { input: readFileSync(path.join(APP, "db", "schema.mysql.sql")), stdio: ["pipe", "ignore", "ignore"] });
    console.log(execFileSync(process.execPath, ["db/seed-min.mjs"], { cwd: APP, encoding: "utf8" }).trim());
  }

  /* 4) 首次运行：编译 TypeScript */
  if (!existsSync(path.join(APP, "dist", "main.js"))) {
    console.log("… 编译 NestJS（约 10 秒）");
    execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
      { cwd: APP, stdio: "inherit" });
  }

  /* 5) NestJS */
  if (!(await portOpen(PORT))) {
    start("NestJS", process.execPath, ["dist/main.js"], APP);
    if (!(await waitPort(PORT, 40))) {
      console.error("NestJS 启动失败：检查 3307/6380 是否就绪、apps/api-nest/dist 是否存在");
      stopAll();
      process.exit(1);
    }
  }
  console.log("✅ NestJS  :" + PORT);

  /* 6) 自检 + 地址 */
  const probe = async (p) => {
    try {
      const r = await fetch("http://localhost:" + PORT + p);
      return r.status;
    } catch {
      return "ERR";
    }
  };
  console.log("\n页面自检：");
  for (const p of ["/api/health", "/admin-vue/", "/m/", "/parent", "/admin"]) {
    console.log("  " + (await probe(p)) + "  " + p);
  }

  console.log("\n==================================================");
  console.log(" 打开以下地址（保持本窗口不要关闭）：");
  console.log("  PC 管理后台   http://localhost:" + PORT + "/admin-vue/");
  console.log("  移动四端      http://localhost:" + PORT + "/m/");
  console.log("  旧 5 端 UI    http://localhost:" + PORT + "/parent （/teacher /sales /agent /admin）");
  console.log("  接口健康      http://localhost:" + PORT + "/api/health");
  console.log("");
  console.log(" 演示账号（口令均为 a123456）：");
  console.log("  管理员    13900000001      西湖代理  13900000010");
  console.log("  业务员    13900000101      教员      13900000201");
  console.log("  家长      13900000301");
  console.log("");
  console.log(" 停止服务：在本窗口按 Ctrl+C，或直接关闭窗口");
  console.log("==================================================");

  setInterval(() => {}, 1 << 30); // 保活
})();
