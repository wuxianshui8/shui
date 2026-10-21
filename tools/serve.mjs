// ============================================================
// 常驻启动：MySQL(3307) + Redis(6380) + NestJS(4300)
//   已运行则跳过；首次运行会自动建库 + 灌入演示数据 + 编译 TS
// 用法：node tools/serve.mjs            启动（守护子进程，命令结束后仍在跑）
//       node tools/serve.mjs --status   只看状态
//       node tools/serve.mjs --stop     停止本脚本启动的服务
// ============================================================
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import net from "node:net";

const TOOLS = "D:/shui/tools";
const MYSQL = TOOLS + "/mysql-8.4.0-winx64";
const APP = "D:/shui/apps/api-nest";
const PID_FILE = TOOLS + "/.serve-pids.json";
const PORT = Number(process.env.NEST_PORT || 4300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function mysqlArgs(args) {
  return ["-h", "127.0.0.1", "-P", "3307", "-u", "root", "--skip-password", ...args];
}

/** 守护方式启动：detached + ignore stdio，脱离本命令的生命周期 */
function launch(bin, args, cwd) {
  const p = spawn(bin, args, { cwd, detached: true, stdio: "ignore", windowsHide: true });
  p.unref();
  return p.pid;
}

function readPids() {
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function stopAll() {
  const pids = readPids();
  if (!pids.length) {
    console.log("没有由 serve.mjs 启动的服务记录");
  }
  for (const pid of pids) {
    try {
      process.kill(-pid);
      console.log("已停止进程组 " + pid);
    } catch {
      try {
        process.kill(pid, "SIGKILL");
        console.log("已停止进程 " + pid);
      } catch {
        console.log("进程 " + pid + " 已不存在");
      }
    }
  }
  try {
    rmSync(PID_FILE);
  } catch {}
}

async function status() {
  const rows = [
    ["MySQL  127.0.0.1:3307", await portOpen(3307)],
    ["Redis  127.0.0.1:6380", await portOpen(6380)],
    ["NestJS 127.0.0.1:" + PORT, await portOpen(PORT)],
  ];
  for (const [name, up] of rows) console.log((up ? "✅ " : "❌ ") + name + (up ? " 运行中" : " 未运行"));
  if (await portOpen(PORT)) {
    console.log("\n访问地址：");
    console.log("  PC 后台   http://localhost:" + PORT + "/admin-vue/");
    console.log("  移动四端  http://localhost:" + PORT + "/m/");
    console.log("  旧 5 端   http://localhost:" + PORT + "/parent （/teacher /sales /agent /admin）");
    console.log("  接口健康  http://localhost:" + PORT + "/api/health");
  }
}

if (process.argv.includes("--stop")) {
  await stopAll();
  process.exit(0);
}
if (process.argv.includes("--status")) {
  await status();
  process.exit(0);
}

const pids = [];

/* 1) MySQL */
if (!(await portOpen(3307))) {
  if (!existsSync(MYSQL + "/bin/mysqld.exe")) {
    console.error("缺少本地 MySQL，请先运行 tools/setup-services.ps1");
    process.exit(1);
  }
  pids.push(launch(MYSQL + "/bin/mysqld.exe",
    ["--basedir=" + MYSQL, "--datadir=" + TOOLS + "/mysql-data", "--port=3307", "--bind-address=127.0.0.1", "--mysqlx=OFF"], MYSQL));
  if (!(await waitPort(3307))) {
    console.error("MySQL 启动失败，见 tools/mysql-data/*.err");
    process.exit(1);
  }
  console.log("MySQL 已启动 :3307");
} else {
  console.log("MySQL 已在运行 :3307（跳过）");
}

/* 2) Redis */
if (!(await portOpen(6380))) {
  pids.push(launch(TOOLS + "/redis/redis-server.exe", ["--port", "6380", "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], TOOLS + "/redis"));
  await waitPort(6380, 20);
  console.log("Redis 已启动 :6380");
} else {
  console.log("Redis 已在运行 :6380（跳过）");
}

/* 3) 建库 + 演示数据（数据库不存在时才做） */
let needSeed = false;
try {
  execFileSync(MYSQL + "/bin/mysql.exe", mysqlArgs(["-e", "SELECT COUNT(*) FROM `jiajiao`.`users`"]), {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });
} catch {
  needSeed = true;
}
if (needSeed) {
  console.log("初始化数据库 jiajiao（建表 + 演示数据）…");
  execFileSync(MYSQL + "/bin/mysql.exe", mysqlArgs(["-e",
    "DROP DATABASE IF EXISTS jiajiao; CREATE DATABASE jiajiao DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"]), { stdio: "inherit" });
  execFileSync(MYSQL + "/bin/mysql.exe", mysqlArgs(["jiajiao"]), {
    input: readFileSync(APP + "/db/schema.mysql.sql"),
    stdio: ["pipe", "inherit", "inherit"],
  });
  console.log(execFileSync(process.execPath, ["db/seed-min.mjs"], { cwd: APP, encoding: "utf8" }).trim());
}

/* 4) 编译 TS（dist 不存在时） */
if (!existsSync(APP + "/dist/main.js")) {
  console.log("编译 NestJS …");
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], { cwd: APP, stdio: "inherit" });
}

/* 5) NestJS */
if (!(await portOpen(PORT))) {
  pids.push(launch(process.execPath, ["dist/main.js"], APP));
  if (!(await waitPort(PORT, 40))) {
    console.error("NestJS 启动失败，检查 apps/api-nest/dist 与数据库连接");
    process.exit(1);
  }
  console.log("NestJS 已启动 :" + PORT);
} else {
  console.log("NestJS 已在运行 :" + PORT + "（跳过）");
}

if (pids.length) writeFileSync(PID_FILE, JSON.stringify(pids));
await status();
