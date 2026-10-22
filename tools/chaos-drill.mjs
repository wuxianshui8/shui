// ============================================================
// 混沌演练（D6）：把 MySQL / Redis 各自停掉，验证「不崩溃、快速失败、能恢复」
//
//   判据（任一不满足即失败）：
//     ① 依赖挂掉时 API **仍然存活**（进程不退出、容器 RestartCount 不增加）
//     ② 业务请求在有限时间内返回 5xx + 统一错误信封（不挂死、不返回 200 假成功）
//     ③ /api/health 明确反映依赖异常（非 200）
//     ④ 依赖恢复后 /api/health 回到 200，且能正常登录（真正恢复，不是假活）
//
//   用法：npm run chaos:drill            # 全流程（约 60~90s，会短暂停止容器服务）
//         SKIP_REDIS=1 npm run chaos:drill   # 只演练 MySQL
//   前置：deploy/.env 已配置且容器栈在跑（deploy/docker-compose.yml）
// ============================================================
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMPOSE = path.join(ROOT, "deploy", "docker-compose.yml");
const DOCKER = process.env.DOCKER_BIN || "docker";
const BASE = process.env.BASE_URL || "http://127.0.0.1:4300";
const SKIP_REDIS = process.env.SKIP_REDIS === "1";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 8000);

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log("  ✓ " + name + (detail ? "  —  " + detail : ""));
  } else {
    fails.push(name + (detail ? "  —  " + detail : ""));
    console.log("  ✗ " + name + (detail ? "  —  " + detail : ""));
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compose = (...args) => spawnSync(DOCKER, ["compose", "-f", COMPOSE, ...args], { encoding: "utf8" });

function restartCount() {
  const r = spawnSync(DOCKER, ["compose", "-f", COMPOSE, "ps", "-q", "app"], { encoding: "utf8" });
  const id = String(r.stdout || "").trim().split(/\r?\n/)[0];
  if (!id) return null;
  const ins = spawnSync(DOCKER, ["inspect", "--format", "{{.RestartCount}}", id], { encoding: "utf8" });
  const n = Number(String(ins.stdout || "").trim());
  return Number.isFinite(n) ? n : null;
}

/** 带超时的探针：超时视为「挂死」（比返回 5xx 严重） */
async function probe(method, urlPath, opts = {}) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT_MS);
  try {
    const res = await fetch(BASE + urlPath, {
      method,
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
      body: opts.body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text, ms: Date.now() - started, hang: false };
  } catch (e) {
    return { status: 0, body: null, text: String(e?.message || e), ms: Date.now() - started, hang: true };
  } finally {
    clearTimeout(timer);
  }
}

async function waitHealth(expectOk, tries = 30, gap = 1000) {
  for (let i = 0; i < tries; i++) {
    const r = await probe("GET", "/api/health");
    const isOk = r.status === 200 && r.body?.code === 0;
    if (expectOk ? isOk : !isOk) return r;
    await sleep(gap);
  }
  return await probe("GET", "/api/health");
}

/**
 * 各依赖中断时的期望语义（不是「一律报错」）：
 *  - MySQL 挂：依赖库的业务读必须**明确失败**（≥400），绝不能返回空 200 假装正常
 *  - Redis 挂：只影响限流/缓存，业务读**应当继续可用**（200）；若被放大成 5xx 反而是设计缺陷
 * 两者共同要求：不挂死、app 不重启。
 */
const OUTAGE_EXPECT = {
  mysql: [
    ["GET", "/api/public/banners", "fail"],
    ["GET", "/api/parent/teachers/4", "any"],
  ],
  redis: [
    ["GET", "/api/public/banners", "ok"],
    ["GET", "/api/parent/teachers/4", "any"],
  ],
};

async function drill(target) {
  console.log("\n=== 演练：" + target + " 中断 ===");
  const before = restartCount();
  ok("演练前 app 容器可查（RestartCount=" + (before ?? "?") + "）", before !== null);

  const stop = compose("stop", target);
  ok("停掉 " + target + " 容器", stop.status === 0, String(stop.stderr || "").trim().slice(0, 120));
  await sleep(1500);

  const health = await probe("GET", "/api/health");
  ok("依赖中断后 /api/health 不再是 200（明确报异常）", health.status !== 200 || health.body?.code !== 0, "HTTP " + health.status + " " + health.ms + "ms");
  ok("依赖中断后 API 未挂死（健康检查在超时内响应）", !health.hang, health.hang ? "超时 " + health.ms + "ms" : "响应 " + health.ms + "ms");

  for (const [method, p, expect] of OUTAGE_EXPECT[target]) {
    const r = await probe(method, p);
    const detail = "HTTP " + r.status + " " + r.ms + "ms";
    if (expect === "fail") {
      ok("MySQL 挂掉时 " + p + " 明确失败（不返回假成功）", !r.hang && r.status >= 400, detail);
    } else if (expect === "ok") {
      ok("Redis 挂掉时 " + p + " 仍然可用（缓存依赖不阻断主流程）", !r.hang && r.status === 200, detail);
    } else {
      ok("依赖中断下 " + p + " 不挂死", !r.hang, detail);
    }
  }

  const afterProbes = restartCount();
  ok("演练过程中 app 未重启（没有崩溃循环）", afterProbes === before, "RestartCount " + before + " → " + afterProbes);

  const start = compose("start", target);
  ok("重启 " + target + " 容器", start.status === 0, String(start.stderr || "").trim().slice(0, 120));

  const recovered = await waitHealth(true, 40, 1500);
  ok("依赖恢复后 /api/health 回到 200（真正恢复）", recovered.status === 200 && recovered.body?.code === 0, "HTTP " + recovered.status + " " + recovered.ms + "ms");

  const login = await probe("POST", "/api/auth/login-password", {
    body: JSON.stringify({ phone: process.env.DRILL_PHONE || "13900000001", password: process.env.DRILL_PASSWORD || "a123456" }),
  });
  ok("恢复后业务可用（管理员登录成功）", login.status === 200 && login.body?.code === 0, "HTTP " + login.status);
}

async function main() {
  console.log("混沌演练（D6）：验证依赖中断时的「不崩溃 / 快失败 / 能恢复」");
  console.log("  · 目标：" + BASE + (SKIP_REDIS ? "（跳过 Redis）" : ""));

  const base = await probe("GET", "/api/health");
  const ready = base.status === 200 && base.body?.code === 0;
  ok("演练前服务健康（前置条件）", ready, "HTTP " + base.status + " " + base.ms + "ms");
  if (!ready) {
    console.log("\n✗ 前置条件不满足：请先 `docker compose -f deploy/docker-compose.yml up -d --wait`，再重跑本演练。");
    process.exit(1);
  }

  await drill("mysql");
  if (!SKIP_REDIS) await drill("redis");

  console.log("");
  if (fails.length) {
    console.log("✗ 混沌演练失败 " + fails.length + " 项：");
    for (const f of fails) console.log("  - " + f);
    process.exit(1);
  }
  console.log("✓ 混沌演练通过（" + pass + " 项）：依赖中断时不崩溃、快失败、可恢复，且无崩溃重启");
}

main().catch((e) => {
  console.error("✗ 混沌演练异常：" + (e?.stack || e));
  // 尽力把服务拉回来，避免演练把环境留在半停状态
  compose("start", "mysql");
  compose("start", "redis");
  process.exit(1);
});
