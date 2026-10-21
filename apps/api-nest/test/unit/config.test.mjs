// 单元测试：config.ts（环境变量解析 + 生产环境密钥护栏）
// 用独立子进程加载，因为校验发生在模块加载期
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "load-config.mjs");

/** 构造子进程环境：未显式给出的 NODE_ENV / AUTH_SECRET 一律剔除，避免宿主环境影响 */
function envWith(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ["NODE_ENV", "AUTH_SECRET", "PORT", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE", "REDIS_HOST", "REDIS_PORT", "REDIS_DB", "WEB_DIR"]) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}
const run = (extra) => spawnSync(process.execPath, [FIXTURE], { encoding: "utf8", env: envWith(extra) });

test("config：未配置时的本地开发默认值", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  assert.equal(c.port, 4300);
  assert.equal(c.mysql.host, "127.0.0.1");
  assert.equal(c.mysql.port, 3307);
  assert.equal(c.mysql.username, "root");
  assert.equal(c.mysql.database, "jiajiao");
  assert.equal(c.redis.host, "127.0.0.1");
  assert.equal(c.redis.port, 6380);
  assert.equal(c.redis.db, 0);
  assert.equal(c.webDir, "web");
  assert.equal(c.tokenTtlSeconds, 7 * 24 * 3600);
});

test("config：未配密钥时退回内置开发密钥并告警", () => {
  const r = run();
  assert.equal(r.status, 0);
  const c = JSON.parse(r.stdout);
  assert.equal(c.authSecret, "jiajiao-dev-secret-please-change-in-prod");
  assert.match(r.stderr, /未配置 AUTH_SECRET/);
});

test("config：生产环境缺 AUTH_SECRET 直接拒绝启动", () => {
  const r = run({ NODE_ENV: "production" });
  assert.notEqual(r.status, 0, "必须非 0 退出");
  assert.match(r.stderr, /生产环境必须配置 AUTH_SECRET/);
  assert.equal(r.stdout.trim(), "", "不应打印出任何配置（进程应中止）");
});

test("config：生产环境配置密钥后正常加载", () => {
  const r = run({ NODE_ENV: "production", AUTH_SECRET: "x".repeat(32) });
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  assert.equal(c.authSecret, "x".repeat(32));
  assert.ok(!/未配置 AUTH_SECRET/.test(r.stderr), "配了密钥就不该告警");
});

test("config：环境变量覆盖端口与库名", () => {
  const r = run({
    PORT: "4399",
    AUTH_SECRET: "unit-secret",
    MYSQL_HOST: "db.internal",
    MYSQL_PORT: "3399",
    MYSQL_USER: "app",
    MYSQL_PASSWORD: "pw",
    MYSQL_DATABASE: "jiajiao_test",
    REDIS_HOST: "cache.internal",
    REDIS_PORT: "6399",
    REDIS_DB: "3",
    WEB_DIR: "web-dist",
  });
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  assert.equal(c.port, 4399);
  assert.equal(c.authSecret, "unit-secret");
  assert.deepEqual(c.mysql, { host: "db.internal", port: 3399, username: "app", password: "pw", database: "jiajiao_test" });
  assert.deepEqual(c.redis, { host: "cache.internal", port: 6399, db: 3 });
  assert.equal(c.webDir, "web-dist");
});
