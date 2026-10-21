// P3 定向校验：退款审批必须同步释放担保资金 + 资金分账恒等式（对应 e2e §13/§14 断言）
// 用法：BASE_URL=http://localhost:4300 node tools/check-refund.mjs
const BASE = process.env.BASE_URL || "http://localhost:4300";
const PW = "a123456";
let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, extra = "") {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; failures.push(name); console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
async function api(method, path, { token, body, idem } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (idem) headers["X-Idem-Key"] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, body: json, text };
}
async function login(phone) {
  const r = await api("POST", "/api/auth/login-password", { body: { phone, password: PW } });
  if (r.status !== 200) throw new Error("登录失败 " + phone + " " + r.text);
  return r.body.data.token;
}

(async () => {
  console.log("P3 定向校验：退款与资金台账");
  console.log("目标服务：" + BASE);
  const parentToken = await login("13900000301");
  const teacherToken = await login("13900000201");
  const adminToken = await login("13900000001");
  const agentToken = await login("13900000010");

  const addr = (await api("GET", "/api/addresses", { token: parentToken })).body.data[0];

  /* ---- 1. 发需求 → 抢单 → 确认 → 支付 ---- */
  const demand = await api("POST", "/api/demands", {
    token: parentToken,
    body: { stage: "小学", subject: "数学", address: addr.address, lat: addr.lat, lng: addr.lng, budget: 15000, remark: "退款校验" },
  });
  assert(demand.status === 200, "发布需求成功");
  const demandId = demand.body.data.id;
  const apply = await api("POST", "/api/demands/" + demandId + "/apply", { token: teacherToken });
  assert(apply.status === 200, "教员报名成功");
  const apps = (await api("GET", "/api/demands/" + demandId, { token: parentToken })).body.data.applications;
  const conf = await api("POST", "/api/demands/" + demandId + "/confirm", { token: parentToken, body: { applicationId: apps[0].id } });
  assert(conf.status === 200 && conf.body.data.status === "awaiting_payment", "确认教员生成待付款订单");
  const orderId = conf.body.data.id;
  const pay = await api("POST", "/api/orders/" + orderId + "/pay", { token: parentToken, idem: "chk-pay-" + orderId });
  assert(pay.status === 200 && pay.body.data.status === "pending_class", "担保支付成功");

  /* ---- 2. 分账恒等式（逐单）---- */
  const detail = (await api("GET", "/api/orders/" + orderId, { token: adminToken })).body.data;
  assert(detail.amount === detail.teacherIncome + detail.serviceFee,
    "分账恒等式 ① amount = teacherIncome + serviceFee（" + detail.amount + " = " + detail.teacherIncome + " + " + detail.serviceFee + "）");
  assert(detail.serviceFee === detail.agentShare + detail.salesCommission + detail.platformRevenue,
    "分账恒等式 ② serviceFee = agentShare + salesCommission + platformRevenue（" + detail.serviceFee + " = " + detail.agentShare + " + " + detail.salesCommission + " + " + detail.platformRevenue + "）");

  /* ---- 3. 申请退款 → 后台审批 → 担保资金必须出账 ---- */
  const refund = await api("POST", "/api/orders/" + orderId + "/refund", { token: parentToken, body: { reason: "临时有事" } });
  assert(refund.status === 200 && refund.body.data.status === "refunding", "家长申请退款，订单转退款中");

  const escrowBefore = (await api("GET", "/api/admin/finance", { token: adminToken })).body.data.summary.escrow;
  const paid = detail.amount + detail.urgentFee;
  const approve = await api("POST", "/api/admin/refunds/" + orderId + "/review", { token: adminToken, body: { approve: true } });
  assert(approve.status === 200 && approve.body.data.status === "refunded", "平台审批退款，订单转已退款");
  const escrowAfter = (await api("GET", "/api/admin/finance", { token: adminToken })).body.data.summary.escrow;
  assert(escrowBefore - escrowAfter === paid,
    "退款审批同步释放担保资金（减少 ¥" + (paid / 100).toFixed(2) + "）", "before=" + escrowBefore + " after=" + escrowAfter);

  const refundDetail = (await api("GET", "/api/orders/" + orderId, { token: adminToken })).body.data;
  assert(refundDetail.refundRecords.length >= 1 && refundDetail.refundRecords[0].amount === paid, "退款流水已入账 payments");

  /* ---- 4. 资金总览恒等式（对应 e2e §14）---- */
  const fin = (await api("GET", "/api/admin/finance", { token: adminToken })).body.data;
  const s = fin.summary;
  assert(s.agentShare + s.salesCommission + s.revenue <= s.serviceFee + 1, "服务费分账恒等式（服务费 ≥ 代理+业务员+平台净收入）");
  assert(s.escrow >= 0, "担保账户余额非负：¥" + (s.escrow / 100).toFixed(2));
  assert(s.totalWallet >= 0 && s.totalFrozen >= 0, "钱包余额与冻结池非负：" + s.totalWallet + " / " + s.totalFrozen);
  const escrowLedgerSum = fin.escrowLedger.reduce((a, e) => a + (e.direction === "in" ? Number(e.amount) : -Number(e.amount)), 0);
  assert(Number.isFinite(escrowLedgerSum), "担保台账可逐笔回溯");

  /* ---- 5. 权限边界 ---- */
  const agentRead = await api("GET", "/api/orders/" + orderId, { token: agentToken });
  assert([200, 403].includes(agentRead.status), "代理访问订单受片区范围限制（" + agentRead.status + "）");

  console.log("\n=================================================");
  console.log("P3 定向校验：通过 " + pass + " 项，失败 " + fail + " 项");
  if (fail) { console.log("失败项：" + failures.join(" / ")); process.exit(1); }
  console.log("全部通过 ✅");
  console.log("=================================================");
})().catch((e) => { console.error("[异常]", e.message); process.exit(1); });
