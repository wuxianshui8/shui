// ============================================================
// 新后端（NestJS + MySQL + Redis）性能基线
//   对读接口做固定并发压测，输出 p50 / p95 / p99 / QPS；写接口单列（含 Redis 锁与事务）
// 用法：node tools/gate-bench.mjs  或  npm run nest:bench
//   环境变量：BENCH_TOTAL（每接口请求数，默认 200）、BENCH_CONC（并发，默认 10）
// ============================================================
const BASE = process.env.BASE_URL || "http://localhost:4300";
const PW = "a123456";
const TOTAL = Number(process.env.BENCH_TOTAL || 200);
const CONC = Number(process.env.BENCH_CONC || 10);

async function api(method, path, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const t0 = process.hrtime.bigint();
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await res.text();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { status: res.status, ms };
}
const login = async (phone) =>
  (await (await fetch(BASE + "/api/auth/login-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password: PW }),
  })).json()).data.token;

/** 固定并发跑 TOTAL 次，返回延迟统计 */
async function bench(name, method, path, token, body) {
  const lat = [];
  let errors = 0;
  let running = 0;
  let started = 0;
  const t0 = Date.now();
  await new Promise((resolve) => {
    const next = () => {
      if (started >= TOTAL) {
        if (running === 0) resolve();
        return;
      }
      started++;
      running++;
      api(method, path, { token, body })
        .then((r) => {
          lat.push(r.ms);
          if (r.status >= 400) errors++;
        })
        .catch(() => {
          errors++;
        })
        .finally(() => {
          running--;
          next();
        });
    };
    for (let i = 0; i < CONC; i++) next();
  });
  const wall = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] ?? 0;
  return {
    name,
    n: lat.length,
    errors,
    qps: Math.round(lat.length / wall),
    p50: +p(0.5).toFixed(1),
    p95: +p(0.95).toFixed(1),
    p99: +p(0.99).toFixed(1),
    max: +(lat[lat.length - 1] || 0).toFixed(1),
  };
}

const admin = await login("13900000001");
const parent = await login("13900000301");
const teacher = await login("13900000201");
const agent = await login("13900000010");
const sales = await login("13900000101");

// 造一条待抢需求，用于写路径压测
const demand = await (await fetch(BASE + "/api/demands", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + parent },
  body: JSON.stringify({ stage: "初中", subject: "数学", address: "西湖区文三路 128 号", lat: 30.262, lng: 120.133, budget: 16000, remark: "压测用" }),
})).json();

const cases = [
  ["家长-教员广场（列表+筛选+排序）", "GET", "/parent/teachers?subject=数学&radiusKm=10", parent],
  ["家长-首页聚合", "GET", "/parent/home?lat=30.262&lng=120.133", parent],
  ["家长-我的订单", "GET", "/parent/orders", parent],
  ["教员-附近需求（派单排序）", "GET", "/teacher/nearby-demands", teacher],
  ["教员-接单大盘", "GET", "/teacher/dashboard", teacher],
  ["教员-钱包（钱包+流水+发票）", "GET", "/wallet", teacher],
  ["代理-片区大盘", "GET", "/agent/dashboard", agent],
  ["代理-片区订单", "GET", "/agent/orders", agent],
  ["业务员-业绩看板", "GET", "/sales/dashboard", sales],
  ["后台-订单列表（分页 50）", "GET", "/admin/orders?page=1&pageSize=50", admin],
  ["后台-财务总览（多表聚合）", "GET", "/admin/finance", admin],
  ["后台-用户列表（分页 20）", "GET", "/admin/users?page=1&pageSize=20", admin],
];

console.log("新后端性能基线  BASE=" + BASE + "  每接口 " + TOTAL + " 次 / 并发 " + CONC + "\n");
console.log("接口".padEnd(34) + "QPS".padStart(7) + "  p50".padStart(8) + "  p95".padStart(8) + "  p99".padStart(8) + "  max".padStart(8) + "  错误");
console.log("-".repeat(96));
const rows = [];
for (const [name, method, path, token] of cases) {
  const r = await bench(name, method, path, token);
  rows.push(r);
  console.log(
    name.padEnd(34) +
      String(r.qps).padStart(7) +
      String(r.p50).padStart(8) +
      String(r.p95).padStart(8) +
      String(r.p99).padStart(8) +
      String(r.max).padStart(8) +
      String(r.errors).padStart(6),
  );
}

// 写路径：抢单（Redis 锁 + 唯一索引 + 事务），单条需求被 N 个教员抢 —— 只允许 1 次成功
const writeTotal = Math.min(50, TOTAL);
{
  const t0 = Date.now();
  const lat = [];
  const results = await Promise.all(
    Array.from({ length: writeTotal }, (_, i) =>
      api("POST", "/demands/" + demand.data.id + "/apply", { token: i === 0 ? teacher : (i % 2 ? teacher : teacher) })
        .then((r) => {
          lat.push(r.ms);
          return r.status;
        }),
    ),
  );
  lat.sort((a, b) => a - b);
  const ok = results.filter((s) => s === 200).length;
  const fail = results.filter((s) => s === 400).length;
  console.log(
    "写-抢单（同一需求并发）".padEnd(34) +
      String(Math.round(lat.length / ((Date.now() - t0) / 1000))).padStart(7) +
      String(lat[Math.floor(lat.length * 0.5)]?.toFixed(1)).padStart(8) +
      String(lat[Math.floor(lat.length * 0.95)]?.toFixed(1)).padStart(8) +
      String(lat[lat.length - 1]?.toFixed(1)).padStart(8) +
      String(0).padStart(8) +
      String(0).padStart(6),
  );
  console.log("\n写路径校验：并发 " + writeTotal + " 次抢单 → 成功 " + ok + " 次、被拒 " + fail + " 次（应成功 1 次）");
  if (ok !== 1) {
    console.log("✗ 抢单并发结果不符合预期");
    process.exitCode = 1;
  }
}

const worst = rows.reduce((a, b) => (b.p95 > a.p95 ? b : a), rows[0]);
console.log("\n最慢读接口（按 p95）：" + worst.name + "  p95=" + worst.p95 + "ms");
const errors = rows.reduce((s, r) => s + r.errors, 0);
console.log("读接口错误数合计：" + errors);
if (errors) process.exitCode = 1;
