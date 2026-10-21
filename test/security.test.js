// ============================================================
// 安全验收测试（需求 7.2 安全要求 / 9.3 安全验收）
//   1. 鉴权基线：无令牌、伪造令牌、越权角色
//   2. 横向越权（IDOR）：跨用户 / 跨教员 / 跨片区 / 跨业务员
//   3. SQL 注入：参数、查询串、路径参数
//   4. 敏感数据脱敏：手机号 / 身份证 / 地址
//   5. 存储型 XSS 载荷完整性（页面转义由 scripts/browser-check.mjs 验证）
// 用法：先 npm start，再 node test/security.test.js
// ============================================================
const BASE = process.env.BASE_URL || "http://localhost:4173";
const PW = "a123456";

let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, extra = "") {
  if (cond) { pass++; console.log("  ✓ " + name + (extra ? "  " + extra : "")); }
  else { fail++; failures.push(name); console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function eq(actual, expect, name) { assert(actual === expect, name, "期望 " + expect + " / 实际 " + actual); }
function section(t) { console.log("\n===== " + t + " ====="); }

async function api(method, path, { token, body, headers } = {}) {
  const h = { "Content-Type": "application/json", ...(headers || {}) };
  if (token) h.Authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, body: json, text };
}
const get = (p, token) => api("GET", p, { token });
const post = (p, body, token) => api("POST", p, { token, body });

async function login(phone) {
  const r = await post("/api/auth/login-password", { phone, password: PW });
  if (r.status !== 200) throw new Error("登录失败 " + phone + " " + r.text);
  return r.body.data.token;
}

(async () => {
  console.log("家教平台 · 安全验收测试");
  console.log("目标服务：" + BASE);

  const admin = await login("13900000001");
  const parentA = await login("13900000301"); // 周，西湖
  const parentB = await login("13900000302"); // 钱，西湖
  const parentC = await login("13900000304"); // 吴，滨江
  const teacherA = await login("13900000201"); // 张老师，西湖，数学/物理
  const teacherB = await login("13900000202"); // 李思远，西湖，英语
  const salesA = await login("13900000101");   // 陈晨，西湖
  const agentA = await login("13900000010");   // 西湖代理

  /* ---------- 1. 鉴权基线 ---------- */
  section("1. 鉴权基线：令牌校验与角色边界");
  const protectedApis = [
    ["GET", "/api/parent/home"],
    ["GET", "/api/teacher/dashboard"],
    ["GET", "/api/agent/dashboard"],
    ["GET", "/api/sales/dashboard"],
    ["GET", "/api/admin/overview"],
    ["GET", "/api/wallet"],
  ];
  let noTokenOk = 0;
  for (const [m, p] of protectedApis) {
    const r = await api(m, p);
    if (r.status === 401) noTokenOk++;
  }
  eq(noTokenOk, protectedApis.length, "全部受保护接口在无令牌时返回 401（" + noTokenOk + "/" + protectedApis.length + "）");

  const tampered = parentA.slice(0, -3) + "aaa";
  const rTamper = await get("/api/parent/home", tampered);
  eq(rTamper.status, 401, "伪造/篡改令牌被拒绝（401）");

  const rGarbage = await get("/api/parent/home", "not-a-token");
  eq(rGarbage.status, 401, "非法格式令牌被拒绝（401）");

  const roleMatrix = [
    ["家长访问教员接口", parentA, "/api/teacher/dashboard"],
    ["家长访问代理接口", parentA, "/api/agent/dashboard"],
    ["家长访问后台接口", parentA, "/api/admin/overview"],
    ["教员访问家长接口", teacherA, "/api/parent/home"],
    ["教员访问后台接口", teacherA, "/api/admin/overview"],
    ["业务员访问代理接口", salesA, "/api/agent/dashboard"],
    ["代理访问后台接口", agentA, "/api/admin/overview"],
  ];
  let roleOk = 0;
  for (const [name, token, path] of roleMatrix) {
    const r = await get(path, token);
    if (r.status === 403) roleOk++;
    else console.log("       " + name + " → " + r.status);
  }
  eq(roleOk, roleMatrix.length, "角色越权访问全部返回 403（" + roleOk + "/" + roleMatrix.length + "）");

  /* ---------- 2. 横向越权（IDOR） ---------- */
  section("2. 横向越权：跨用户 / 跨教员 / 跨片区 / 跨业务员");

  const adminOrders = (await get("/api/admin/orders", admin)).body.data.list;
  const orderOfB = adminOrders.find((o) => o.parent && o.parent.phone === "13900000302");
  const orderOfC = adminOrders.find((o) => o.parent && o.parent.phone === "13900000304");
  assert(!!orderOfB && !!orderOfC, "取得他人订单用于越权测试（" + (orderOfB ? orderOfB.orderNo : "-") + "）");

  const idor = async (label, method, path, token, body) => {
    const r = await api(method, path, { token, body });
    const okStatus = r.status === 403 || r.status === 404;
    assert(okStatus, label, "HTTP " + r.status);
    return r;
  };

  await idor("家长 A 查看家长 B 的订单详情", "GET", "/api/orders/" + orderOfB.id, parentA);
  await idor("家长 A 支付家长 B 的订单", "POST", "/api/orders/" + orderOfB.id + "/pay", parentA, {});
  await idor("家长 A 取消家长 B 的订单", "POST", "/api/orders/" + orderOfB.id + "/cancel", parentA, { reason: "越权测试" });
  await idor("家长 A 评价家长 B 的订单", "POST", "/api/orders/" + orderOfB.id + "/review", parentA, { score: 1, tags: [] });
  await idor("教员 A 查看他人订单", "GET", "/api/orders/" + orderOfC.id, teacherA);
  await idor("教员 A 对他人订单打卡", "POST", "/api/orders/" + orderOfC.id + "/checkin", teacherA, { lat: 30.2, lng: 120.2 });
  await idor("西湖代理查看滨江片区订单", "GET", "/api/orders/" + orderOfC.id, agentA);
  await idor("业务员查看未归属客户的订单", "GET", "/api/orders/" + orderOfB.id, salesA);

  const bAddrs = (await get("/api/addresses", parentB)).body.data;
  const bAddrId = bAddrs[0].id;
  await idor("家长 A 修改家长 B 的地址", "PUT", "/api/addresses/" + bAddrId, parentA, { contact: "越权" });
  await idor("家长 A 删除家长 B 的地址", "DELETE", "/api/addresses/" + bAddrId, parentA);

  const bDemands = (await get("/api/demands/mine", parentB)).body.data;
  const bDemand = bDemands[0];
  await idor("家长 A 查看家长 B 的需求", "GET", "/api/demands/" + bDemand.id, parentA);
  await idor("家长 A 修改家长 B 的需求", "PUT", "/api/demands/" + bDemand.id, parentA, { remark: "越权" });
  await idor("家长 A 撤销家长 B 的需求", "POST", "/api/demands/" + bDemand.id + "/action", parentA, { action: "revoke" });

  const bServices = (await get("/api/teacher/services", teacherB)).body.data;
  await idor("教员 A 修改教员 B 的服务", "PUT", "/api/teacher/services/" + bServices[0].id, teacherA, { price: 999 });
  await idor("教员 A 下架教员 B 的服务", "POST", "/api/teacher/services/" + bServices[0].id + "/toggle", teacherA, {});
  await idor("教员 A 删除教员 B 的服务", "DELETE", "/api/teacher/services/" + bServices[0].id, teacherA);

  const bReviews = (await get("/api/teacher/reviews", teacherB)).body.data.list;
  if (bReviews.length) {
    await idor("教员 A 对教员 B 的评价申诉", "POST", "/api/teacher/reviews/" + bReviews[0].id + "/appeal", teacherA, { reason: "越权测试" });
  }

  // 教员不能随意查看他人需求的报名信息
  const farDemand = await post("/api/demands", {
    stage: "高中", subject: "美术", address: "余杭区良渚文化村 3 幢", lat: 30.4190, lng: 120.0020, budget: 20000,
    remark: "越权测试需求（远距离 + 非本人科目）",
  }, parentA);
  const farDemandId = farDemand.body.data.id;
  const rFar = await get("/api/demands/" + farDemandId, teacherA);
  eq(rFar.status, 403, "教员无法查看「超出服务半径且非本人科目」的需求（403）");

  // 正向对照：教员可以查看自己已报名的需求
  const ownDemands = (await get("/api/teacher/nearby-demands", teacherA)).body.data.list;
  const applied = ownDemands.find((d) => d.appliedStatus);
  if (applied) {
    const rOwn = await get("/api/demands/" + applied.id, teacherA);
    eq(rOwn.status, 200, "教员可正常查看自己已报名的需求（正向对照）");
  }

  // 代理只能看本片区业务员
  const xhSales = (await get("/api/agent/sales", admin === null ? admin : agentA)).body.data.list;
  const agentBJ = await login("13900000011");
  await idor("滨江代理查看西湖业务员明细", "GET", "/api/agent/sales/" + xhSales[0].userId, agentBJ);

  // 非管理员调用后台写接口
  const adminWrites = [
    ["家长调用提现审核", parentA, "POST", "/api/admin/withdrawals/1/review", { approve: true }],
    ["教员调用规则修改", teacherA, "PUT", "/api/admin/rules/settlement", { value: { freeze_days: 0 } }],
    ["代理调用教员审核", agentA, "POST", "/api/admin/teachers/2/audit", { approve: true }],
    ["业务员调用订单改价", salesA, "POST", "/api/admin/orders/1/price", { amount: 1 }],
    ["家长调用业务员结算", parentA, "POST", "/api/admin/rewards/settle", {}],
    ["教员调用发票受理", teacherA, "POST", "/api/admin/invoices/1/review", { approve: true }],
  ];
  let writeBlocked = 0;
  for (const [name, token, m, p, body] of adminWrites) {
    const r = await api(m, p, { token, body });
    if (r.status === 403) writeBlocked++;
    else console.log("       " + name + " → " + r.status);
  }
  eq(writeBlocked, adminWrites.length, "非管理员调用后台写接口全部 403（" + writeBlocked + "/" + adminWrites.length + "）");

  // 家长不能发起提现（仅教员/业务员/代理）
  const parentWd = await post("/api/withdrawals", { amount: 20000, channel: "wechat", account: "13900000301" }, parentA);
  eq(parentWd.status, 403, "家长调用提现接口被拒绝（403）");

  /* ---------- 3. SQL 注入 ---------- */
  section("3. SQL 注入：参数 / 查询串 / 路径参数");
  const injectionPayloads = [
    "' OR '1'='1",
    "'; DROP TABLE users;--",
    "1 OR 1=1",
    "' UNION SELECT 1,2,3--",
    "%' OR phone LIKE '%",
  ];
  let injBad = 0;
  for (const payload of injectionPayloads) {
    const enc = encodeURIComponent(payload);
    const checks = [
      await get("/api/admin/orders?keyword=" + enc, admin),
      await get("/api/admin/users?keyword=" + enc, admin),
      await get("/api/orders/" + enc, admin),
      await get("/api/public/agreements/" + enc),
      await api("POST", "/api/auth/login-password", { body: { phone: payload, password: payload } }),
      await api("POST", "/api/auth/login", { body: { phone: payload, code: "123456" } }),
    ];
    for (const r of checks) {
      if (r.status >= 500) injBad++;
      if (r.body && /SQLITE|syntax error|no such table/i.test(r.text)) injBad++;
    }
  }
  eq(injBad, 0, "5 组注入载荷 × 6 个入口，无 500 且未泄露 SQL 错误（" + injBad + " 次异常）");

  const stillAlive = await get("/api/admin/overview", admin);
  assert(stillAlive.status === 200 && stillAlive.body.data.metrics.totalUsers > 0, "注入尝试后核心表与接口仍然正常（用户数 " + stillAlive.body.data.metrics.totalUsers + "）");

  const searchInj = await get("/api/admin/users?role=" + encodeURIComponent("parent' OR '1'='1"), admin);
  assert(
    searchInj.status === 200 && (!searchInj.body.data.list || searchInj.body.data.list.length === 0),
    "带注入载荷的角色筛选被参数化处理（返回 " + (searchInj.body.data?.list?.length ?? 0) + " 条）"
  );

  /* ---------- 4. 敏感数据脱敏 ---------- */
  section("4. 敏感数据脱敏");
  const agentOrders = (await get("/api/agent/orders", agentA)).body.data.list;
  assert(
    agentOrders.length > 0 && agentOrders.every((o) => !o.address || o.address.includes("***") || o.address.length <= 10),
    "代理端订单地址脱敏（" + agentOrders.length + " 单）"
  );
  assert(
    agentOrders.every((o) => !o.parent?.phone || o.parent.phone.includes("****")),
    "代理端家长手机号脱敏"
  );

  const salesCustomers = (await get("/api/sales/customers", salesA)).body.data.list;
  assert(
    salesCustomers.every((c) => c.phone.includes("****")),
    "业务员端客户手机号脱敏（" + salesCustomers.length + " 位）"
  );

  const agentSalesList = (await get("/api/agent/sales", agentA)).body.data.list;
  assert(agentSalesList.every((s) => s.phone.includes("****")), "代理端业务员手机号脱敏");

  const pendingTeachers = (await get("/api/admin/teachers/pending", admin)).body.data;
  assert(
    pendingTeachers.every((t) => !t.idCard || t.idCard.includes("*")),
    "后台教员身份证脱敏展示（" + pendingTeachers.length + " 份材料）"
  );

  const adminUserList = (await get("/api/admin/users", admin)).body.data.list;
  assert(
    adminUserList.some((u) => u.phone && /^1\d{10}$/.test(u.phone)),
    "管理员可见完整手机号（权限差异对照）"
  );

  const parentProfile = (await get("/api/parent/profile", parentA)).body.data;
  assert(
    /^1\d{2}\*{4}\d{4}$/.test(parentProfile.user.phone),
    "家长端个人中心手机号脱敏（" + parentProfile.user.phone + "）"
  );

  /* ---------- 5. 存储型 XSS 载荷完整性 ---------- */
  section("5. 存储型 XSS：载荷入库与转义（页面渲染由 browser-check 验证）");
  const xssPayload = '<img src=x onerror="window.__xss=1"><script>window.__xss2=1</script>';
  const xssDemand = await post("/api/demands", {
    stage: "小学", subject: "数学", address: "西湖区文三路 128 号",
    lat: 30.2620, lng: 120.1330, budget: 10000, remark: xssPayload,
  }, parentA);
  assert(xssDemand.status === 200, "含 XSS 载荷的需求可以正常写入（数据不丢失）");
  assert(
    xssDemand.body.data.remark === xssPayload,
    "载荷原样存储，未被服务端二次转义破坏（转义由前端输出层负责）"
  );
  const xssReadBack = (await get("/api/demands/" + xssDemand.body.data.id, parentA)).body.data;
  eq(xssReadBack.remark, xssPayload, "读回内容与写入一致");

  const xssComplaint = await post("/api/complaints", {
    title: xssPayload, content: "<svg onload=window.__xss3=1>",
  }, parentA);
  assert(xssComplaint.status === 200, "含 XSS 载荷的客诉工单可写入");
  const riskBoard = (await get("/api/admin/risks", admin)).body.data;
  assert(
    riskBoard.complaints.some((c) => c.title === xssPayload),
    "后台可在工单列表中看到原始载荷（渲染时必须转义）"
  );

  /* ---------- 6. 传输层加固与暴力破解防护 ---------- */
  section("6. 安全响应头、登录失败锁定与健康检查");
  const pageRes = await fetch(BASE + "/parent");
  const hd = pageRes.headers;
  eq(hd.get("x-frame-options"), "SAMEORIGIN", "页面返回 X-Frame-Options: SAMEORIGIN（防点击劫持）");
  eq(hd.get("x-content-type-options"), "nosniff", "返回 X-Content-Type-Options: nosniff");
  assert(!!hd.get("referrer-policy"), "返回 Referrer-Policy：" + hd.get("referrer-policy"));
  assert(!!hd.get("permissions-policy"), "返回 Permissions-Policy（限制定位/摄像头/麦克风）");
  const csp = hd.get("content-security-policy") || "";
  assert(
    csp.includes("default-src 'self'") && csp.includes("object-src 'none'") && csp.includes("frame-ancestors 'self'"),
    "CSP 已下发且包含 default-src / object-src / frame-ancestors"
  );
  const apiRes = await fetch(BASE + "/api/meta/dictionary");
  eq(apiRes.headers.get("x-frame-options"), "SAMEORIGIN", "API 响应同样带安全头");

  const health = await get("/api/health");
  assert(
    health.status === 200 && health.body.data.status === "ok" && health.body.data.db.ok,
    "健康检查接口可用（v" + health.body.data?.version + "，用户 " + health.body.data?.db?.users +
      "，订单 " + health.body.data?.db?.orders + "，担保 " + (health.body.data?.db?.escrow / 100).toFixed(2) + " 元）"
  );

  const riskCfg = (await get("/api/admin/rules", admin)).body.data.rules.find((r) => r.key === "risk").value;
  const failLimit = riskCfg.login_fail_limit ?? 5;
  const lockPhone = "13900007888"; // 专用测试号，不影响其他用例
  let lastStatus = 0;
  for (let i = 0; i < failLimit; i++) {
    const r = await post("/api/auth/login-password", { phone: lockPhone, password: "wrong-" + i });
    lastStatus = r.status;
  }
  eq(lastStatus, 400, "连续 " + failLimit + " 次口令错误返回 400");
  const locked = await post("/api/auth/login-password", { phone: lockPhone, password: "wrong-final" });
  eq(locked.status, 429, "超过阈值后返回 429 锁定");
  assert(locked.body?.code === "LOGIN_LOCKED", "错误码为 LOGIN_LOCKED：" + (locked.body?.message || ""));

  const otherAcct = await post("/api/auth/login-password", { phone: "13900000001", password: PW });
  eq(otherAcct.status, 200, "锁定按「IP + 账号」维度生效，其他账号不受影响（正向对照）");

  await api("PUT", "/api/admin/rules/risk", { token: admin, body: { value: { ...riskCfg, login_fail_limit: 999 } } });
  const afterRelax = await post("/api/auth/login-password", { phone: lockPhone, password: "wrong" });
  eq(afterRelax.status, 400, "阈值由规则配置中心驱动，调大后可再次尝试");
  await api("PUT", "/api/admin/rules/risk", { token: admin, body: { value: riskCfg } });
  const restoredLock = await post("/api/auth/login-password", { phone: lockPhone, password: "wrong" });
  eq(restoredLock.status, 429, "阈值还原后锁定立即恢复生效");
  console.log("\n提示：XSS 载荷已写入演示库，跑完请执行 npm run seed 还原数据。");

  /* ---------- 汇总 ---------- */
  console.log("\n=================================================");
  console.log("安全验收：通过 " + pass + " 项，失败 " + fail + " 项");
  if (fail) {
    console.log("失败项：");
    failures.forEach((f) => console.log("  - " + f));
    process.exitCode = 1;
  } else {
    console.log("越权、注入、脱敏均符合需求 7.2 / 9.3 安全验收要求 ✅");
  }
  console.log("=================================================");
})().catch((e) => {
  console.error("测试异常终止：", e);
  process.exitCode = 1;
});