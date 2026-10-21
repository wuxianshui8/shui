// ============================================================
// 性能验收脚本（需求 7.1）
//   普通接口响应 ≤ 300ms，抢单接口 ≤ 500ms，页面首屏 ≤ 2s
//   用法：先启动服务，再 node scripts/bench.mjs [每接口采样次数]
// ============================================================
const BASE = process.env.BASE_URL || "http://localhost:4173";
const PW = "a123456";
const N = Math.max(5, Number(process.argv[2] || 20));
const API_TARGET = 300;
const GRAB_TARGET = 500;
const PAGE_TARGET = 2000;

async function login(phone) {
  const r = await fetch(BASE + "/api/auth/login-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password: PW }),
  });
  if (!r.ok) throw new Error("登录失败 " + phone);
  return (await r.json()).data.token;
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function timeOnce(spec, token) {
  const t0 = performance.now();
  const res = await fetch(BASE + spec.path, {
    method: spec.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(spec.headers || {}),
    },
    body: spec.body ? JSON.stringify(spec.body) : undefined,
  });
  await res.text();
  return performance.now() - t0;
}

async function measure(label, spec, token, target) {
  const samples = [];
  for (let i = 0; i < N; i++) samples.push(await timeOnce(spec, token));
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    label,
    avg: Number(avg.toFixed(1)),
    p50: Number(pct(samples, 50).toFixed(1)),
    p95: Number(pct(samples, 95).toFixed(1)),
    max: Number(Math.max(...samples).toFixed(1)),
    target,
    ok: pct(samples, 95) <= target,
  };
}

(async () => {
  console.log("家教平台 · 性能验收");
  console.log("服务：" + BASE + "，每个接口采样 " + N + " 次\n");

  const admin = await login("13900000001");
  const parent = await login("13900000301");
  const teacher = await login("13900000201");
  const agent = await login("13900000010");
  const sales = await login("13900000101");

  const demands = await fetch(BASE + "/api/teacher/nearby-demands", {
    headers: { Authorization: "Bearer " + teacher },
  }).then((r) => r.json());
  const demandId = demands.data?.list?.[0]?.id;

  const results = [];
  results.push(await measure("字典与规则（公开）", { path: "/api/meta/dictionary" }, null, API_TARGET));
  results.push(await measure("家长端首页聚合", { path: "/api/parent/home" }, parent, API_TARGET));
  results.push(await measure("教员广场（10km 筛选）", { path: "/api/parent/teachers?radiusKm=10" }, parent, API_TARGET));
  results.push(await measure("家长订单列表", { path: "/api/parent/orders" }, parent, API_TARGET));
  results.push(await measure("教员工作台", { path: "/api/teacher/dashboard" }, teacher, API_TARGET));
  results.push(await measure("附近订单（派单计算）", { path: "/api/teacher/nearby-demands" }, teacher, GRAB_TARGET));
  results.push(await measure("代理片区大盘", { path: "/api/agent/dashboard" }, agent, API_TARGET));
  results.push(await measure("业务员看板", { path: "/api/sales/dashboard" }, sales, API_TARGET));
  results.push(await measure("后台数据总览", { path: "/api/admin/overview" }, admin, API_TARGET));
  results.push(await measure("后台订单列表(300 条)", { path: "/api/admin/orders" }, admin, API_TARGET));
  if (demandId) {
    results.push(
      await measure(
        "抢单接口（唯一索引校验）",
        { method: "POST", path: "/api/demands/" + demandId + "/apply", body: {} },
        teacher,
        GRAB_TARGET
      )
    );
  }

  // 并发压力：20 并发 × 5 轮打派单接口
  const burst = [];
  for (let round = 0; round < 5; round++) {
    const batch = await Promise.all(
      Array.from({ length: 20 }, () => timeOnce({ path: "/api/teacher/nearby-demands" }, teacher))
    );
    burst.push(...batch);
  }
  results.push({
    label: "20 并发 × 5 轮 派单接口",
    avg: Number((burst.reduce((a, b) => a + b, 0) / burst.length).toFixed(1)),
    p50: Number(pct(burst, 50).toFixed(1)),
    p95: Number(pct(burst, 95).toFixed(1)),
    max: Number(Math.max(...burst).toFixed(1)),
    target: GRAB_TARGET,
    ok: pct(burst, 95) <= GRAB_TARGET,
  });

  // 页面首屏（服务端返回 HTML 的耗时，不含静态资源与浏览器渲染）
  for (const [label, path] of [["家长端页面", "/parent"], ["教员端页面", "/teacher"], ["代理端页面", "/agent"], ["管理后台页面", "/admin"]]) {
    const samples = [];
    for (let i = 0; i < Math.min(N, 10); i++) {
      const t0 = performance.now();
      await fetch(BASE + path).then((r) => r.text());
      samples.push(performance.now() - t0);
    }
    results.push({
      label: label + "（HTML 首字节）",
      avg: Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(1)),
      p50: Number(pct(samples, 50).toFixed(1)),
      p95: Number(pct(samples, 95).toFixed(1)),
      max: Number(Math.max(...samples).toFixed(1)),
      target: PAGE_TARGET,
      ok: pct(samples, 95) <= PAGE_TARGET,
    });
  }

  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  console.log(pad("接口 / 页面", 30) + num("avg", 9) + num("p50", 9) + num("p95", 9) + num("max", 9) + num("阈值", 8) + "   结果");
  console.log("-".repeat(88));
  for (const r of results) {
    console.log(
      pad(r.label, 30) + num(r.avg, 9) + num(r.p50, 9) + num(r.p95, 9) + num(r.max, 9) + num(r.target + "ms", 8) +
      "   " + (r.ok ? "PASS" : "FAIL")
    );
  }
  const failed = results.filter((r) => !r.ok);
  console.log("\n合计 " + results.length + " 项，未达标 " + failed.length + " 项");
  console.log(
    failed.length
      ? "未达标：" + failed.map((f) => f.label + "（p95 " + f.p95 + "ms）").join("，")
      : "全部满足需求 7.1 的响应时间指标 ✅"
  );
  if (failed.length) process.exitCode = 1;
})().catch((e) => {
  console.error("压测异常：", e.message);
  process.exitCode = 1;
});