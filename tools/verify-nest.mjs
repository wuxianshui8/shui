// ============================================================
// NestJS 后端（MySQL 8.4 + Redis）联调验证
// 用法：node tools/verify-nest.mjs
// 脚本自行拉起/停止本地 MySQL 与 Redis（stdio 忽略，不继承句柄）
// ============================================================
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";

const TOOLS = "D:/shui/tools";
const MYSQL = TOOLS + "/mysql-8.4.0-winx64";
const APP = "D:/shui/apps/api-nest";
const BASE = "http://localhost:4300";
const MYSQL_PORT = 3307;
const REDIS_PORT = 6380;
const children = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
async function waitPort(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await portOpen(port)) return true;
    await sleep(400);
  }
  return false;
}
function startDetached(bin, args, cwd) {
  const p = spawn(bin, args, { cwd, detached: true, stdio: "ignore", windowsHide: true });
  p.unref();
  children.push(p);
  return p;
}
function mysqlCli(args) {
  return execFileSync(MYSQL + "/bin/mysql.exe", ["-h", "127.0.0.1", "-P", String(MYSQL_PORT), "-u", "root", "--skip-password", ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });
}
function stopAll() {
  for (const p of children) {
    try { process.kill(-p.pid); } catch { try { p.kill("SIGKILL"); } catch {} }
  }
}

let pass = 0, fail = 0;
const check = (cond, name, extra = "") => {
  if (cond) { pass++; console.log("  [PASS] " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  [FAIL] " + name + (extra ? "  " + extra : "")); }
};

(async () => {
  try {
    if (!existsSync(MYSQL + "/bin/mysqld.exe")) {
      console.log("未找到 tools/mysql-8.4.0-winx64，请先执行 tools/setup-services.ps1");
      process.exit(1);
    }
    console.log("启动依赖：MySQL 8.4 + Redis 5 …");
    startDetached(MYSQL + "/bin/mysqld.exe", [
      "--basedir=" + MYSQL, "--datadir=" + TOOLS + "/mysql-data",
      "--port=" + MYSQL_PORT, "--bind-address=127.0.0.1", "--mysqlx=OFF",
    ], MYSQL);
    startDetached(TOOLS + "/redis/redis-server.exe", ["--port", String(REDIS_PORT), "--bind", "127.0.0.1"], TOOLS + "/redis");
    const myOk = await waitPort(MYSQL_PORT);
    const rdOk = await waitPort(REDIS_PORT, 20);
    check(myOk && rdOk, "MySQL 与 Redis 已就绪", "mysql=" + myOk + " redis=" + rdOk);
    if (!myOk) throw new Error("MySQL 未能启动");

    console.log("重建数据库并建表 …");
    mysqlCli(["-e", "DROP DATABASE IF EXISTS jiajiao; CREATE DATABASE jiajiao DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"]);
    const ddl = execFileSync(MYSQL + "/bin/mysql.exe", ["-h", "127.0.0.1", "-P", String(MYSQL_PORT), "-u", "root", "--skip-password", "jiajiao"], {
      input: (await import("node:fs")).readFileSync(APP + "/db/schema.mysql.sql"),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const tbl = mysqlCli(["-N", "-e", "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='jiajiao';"]).trim();
    check(Number(tbl) === 37, "MySQL 建表完整", tbl + " 张表");

    console.log("编译与种子 …");
    execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], { cwd: APP, stdio: "inherit" });
    const seedOut = execFileSync(process.execPath, ["db/seed-min.mjs"], { cwd: APP, encoding: "utf8" });
    console.log("  " + seedOut.trim());

    console.log("启动 NestJS …");
    startDetached(process.execPath, ["dist/main.js"], APP);
    const apiOk = await waitPort(4300, 30);
    check(apiOk, "NestJS 服务已监听 :4300");
    if (!apiOk) throw new Error("NestJS 未能启动");

    console.log("\n=== 1. 健康检查（MySQL + Redis 双链路）===");
    const h = await fetch(BASE + "/api/health").then((r) => r.json());
    check(h.data.db.ok && h.data.cache.ok && h.data.framework === "NestJS",
      "NestJS + MySQL + Redis 全通", "mysql=" + h.data.db.latencyMs + "ms（匿名探活不含业务指标）");

    console.log("\n=== 2. 字典与规则（MySQL 权威源 + Redis 缓存）===");
    const dict = await fetch(BASE + "/api/meta/dictionary").then((r) => r.json());
    check(dict.data.stages.length === 5, "字典接口", "学段 " + dict.data.stages.length + " 科目 " + dict.data.subjects.length);
    const rules1 = await fetch(BASE + "/api/meta/rules-public").then((r) => r.json());
    check(rules1.data.length >= 11, "公开规则读自 MySQL", rules1.data.length + " 组");
    const keys = execFileSync(TOOLS + "/redis/redis-cli.exe", ["-h", "127.0.0.1", "-p", String(REDIS_PORT), "keys", "jiajiao:rules:*"], { encoding: "utf8" }).trim();
    check(keys.length > 0, "规则写入 Redis 缓存", "keys=" + keys.split("\n").filter(Boolean).length);

    console.log("\n=== 3. 鉴权（MySQL 校验口令 + HMAC 令牌）===");
    const badRes = await fetch(BASE + "/api/auth/login-password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900000001", password: "wrong" }),
    });
    check(badRes.status === 400, "错误口令被拒", "HTTP " + badRes.status);
    const login = await fetch(BASE + "/api/auth/login-password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900000001", password: "a123456" }),
    }).then((r) => r.json());
    check(!!login.data?.token, "管理员登录成功", "role=" + login.data?.user?.role);
    const me = await fetch(BASE + "/api/auth/me", { headers: { Authorization: "Bearer " + login.data.token } }).then((r) => r.json());
    check(Number(me.data?.user?.id) === 1, "令牌校验通过", "nickname=" + me.data?.user?.nickname + " id=" + me.data?.user?.id);
    const noTok = await fetch(BASE + "/api/auth/me");
    check(noTok.status === 401, "无令牌 401", "HTTP " + noTok.status);
    const tampered = login.data.token.slice(0, -3) + "aaa";
    const badTok = await fetch(BASE + "/api/auth/me", { headers: { Authorization: "Bearer " + tampered } });
    check(badTok.status === 401, "篡改令牌 401", "HTTP " + badTok.status);

    console.log("\n=== 4. 安全响应头 ===");
    const resp = await fetch(BASE + "/api/meta/dictionary");
    check(resp.headers.get("x-frame-options") === "SAMEORIGIN", "X-Frame-Options");
    check((resp.headers.get("content-security-policy") || "").includes("default-src"), "CSP");

    console.log("\n=== 5. 数据表 ===");
    const tbl2 = mysqlCli(["-N", "-e", "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='jiajiao';"]).trim();
    check(Number(tbl2) === 37, "MySQL 建表完整", tbl2 + " 张表");
  } catch (e) {
    fail++;
    console.error("[ERROR]", e.message);
  } finally {
    stopAll();
    console.log("\n=================================================");
    console.log("NestJS 迁移切片验证：通过 " + pass + " 项，失败 " + fail + " 项");
    console.log("(已停止本地 MySQL / Redis / NestJS)");
  }
  if (fail > 0) process.exitCode = 1;
})();