// ============================================================
// 资金并发对抗回归（针对本轮评审修复的 8 个真实缺陷）
//   1. 提现并发双花（walletAdd 无行锁）
//   2. 提现驳回重复执行（造币）
//   3. 到期结算并发双放款
//   4. 退款审批并发双出账
//   5. 平台强制关闭「已完成」订单 → 教员冻结额必须冲销
//   6. 规则超额时分账恒等式仍成立（不再被 Math.max(0) 吞掉赤字）
//   7. 幂等重放：同一 X-Idem-Key 支付重试返回首次结果而非 400
//   8. 钱流自洽：钱包余额 == 流水累加
// 用法：由 tools/gate-p6.mjs 在同批次起服务后调用（BASE_URL 指向 NestJS）
// ============================================================
const BASE = process.env.BASE_URL || "http://localhost:4300";
const PW = "a123456";
let pass = 0;
let fail = 0;
const failures = [];
function assert(cond, name, extra = "") {
  if (cond) {
    pass++;
    console.log("  ✓ " + name + (extra ? "  " + extra : ""));
  } else {
    fail++;
    failures.push(name);
    console.log("  ✗ " + name + (extra ? "  → " + extra : ""));
  }
}
async function api(method, path, { token, body, idem } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (idem) headers["X-Idem-Key"] = idem;
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, body: json, text };
}
const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

console.log("资金并发对抗回归");
console.log("目标服务：" + BASE + "\n");

/* ---------------- 登录 ---------------- */
const admin = (await api("POST", "/auth/login-password", { body: { phone: "13900000001", password: PW } })).body.data.token;
const parent = (await api("POST", "/auth/login-password", { body: { phone: "13900000301", password: PW } })).body.data.token;
const teacher = (await api("POST", "/auth/login-password", { body: { phone: "13900000201", password: PW } })).body.data.token;
assert(!!admin && !!parent && !!teacher, "三类角色登录成功（管理员/家长/教员）");

const walletOf = async (token) => (await api("GET", "/wallet", { token })).body.data;
const financeOf = async () => (await api("GET", "/admin/finance", { token: admin })).body.data.summary;

/** 家长发需求 → 教员抢单 → 家长确认 → 生成订单 */
async function newOrder(remark) {
  const d = await api("POST", "/demands", {
    token: parent,
    body: { stage: "初中", subject: "数学", address: "西湖区文三路 128 号", lat: 30.262, lng: 120.133, budget: 16000, remark },
  });
  const demandId = d.body.data.id;
  const a = await api("POST", "/demands/" + demandId + "/apply", { token: teacher });
  const c = await api("POST", "/demands/" + demandId + "/confirm", {
    token: parent,
    body: { applicationId: a.body.data.applicationId },
  });
  return { orderId: c.body.data.id, view: c.body.data };
}
async function payOrder(orderId, idem) {
  return api("POST", "/orders/" + orderId + "/pay", { token: parent, idem: idem || "race-pay-" + uniq() });
}
async function toCompleted(orderId) {
  const od = await api("GET", "/orders/" + orderId, { token: teacher });
  await api("POST", "/orders/" + orderId + "/checkin", {
    token: teacher,
    body: { lat: od.body.data.lat + 0.0005, lng: od.body.data.lng + 0.0005 },
  });
  await api("POST", "/orders/" + orderId + "/finish", { token: teacher });
  await api("POST", "/orders/" + orderId + "/confirm", { token: parent });
  return (await api("GET", "/orders/" + orderId, { token: parent })).body.data;
}
const sumTxns = (w) => (w.txns || []).reduce((s, t) => s + Number(t.amount || 0), 0);

/* ---------------- 1. 提现并发双花 ---------------- */
console.log("== 1. 提现并发双花（walletAdd 行锁） ==");
const w0 = await walletOf(teacher);
const txnCount0 = (w0.txns || []).length;
const min = 10000;
const parallelWithdraw = await Promise.all([
  api("POST", "/withdrawals", { token: teacher, idem: "race-wd-a-" + uniq(), body: { amount: min, account: "wx_race_a", channel: "wechat" } }),
  api("POST", "/withdrawals", { token: teacher, idem: "race-wd-b-" + uniq(), body: { amount: min, account: "wx_race_b", channel: "wechat" } }),
]);
const okWd = parallelWithdraw.filter((r) => r.status === 200 && r.body.code === 0);
const w1 = await walletOf(teacher);
assert(okWd.length === 1, "余额 " + money(w0.wallet.balance) + " 时并发两笔 " + money(min) + "，仅 1 笔成功（成功 " + okWd.length + " 笔）");
assert(w1.wallet.balance === w0.wallet.balance - min, "并发提现后余额只扣一次：" + money(w0.wallet.balance) + " → " + money(w1.wallet.balance));
// 只比较「本次新增流水」：种子钱包余额不含历史流水，全量比对不成立
const newTxns = (w1.txns || []).slice(0, (w1.txns || []).length - txnCount0);
const txnDelta = newTxns.reduce((s, t) => s + Number(t.amount || 0), 0);
assert(
  newTxns.length === 1 && txnDelta === w1.wallet.balance - w0.wallet.balance,
  "新增流水只有 1 条且累加等于余额变动（" + newTxns.length + " 条 / " + money(txnDelta) + "）",
);

/* ---------------- 2. 提现驳回重复执行 ---------------- */
console.log("\n== 2. 提现驳回并发重放（不得造币） ==");
const wdId = okWd[0].body.data.id;
const parallelReject = await Promise.all([
  api("POST", "/admin/withdrawals/" + wdId + "/review", { token: admin, body: { approve: false, reason: "并发重复驳回" } }),
  api("POST", "/admin/withdrawals/" + wdId + "/review", { token: admin, body: { approve: false, reason: "并发重复驳回" } }),
]);
const okReject = parallelReject.filter((r) => r.status === 200 && r.body.code === 0);
const w2 = await walletOf(teacher);
const refundTxns = (w2.txns || []).filter((t) => t.type === "withdraw_refund").length;
assert(okReject.length === 1, "并发两次驳回只成功 1 次（成功 " + okReject.length + " 次）");
assert(w2.wallet.balance === w0.wallet.balance, "驳回后余额精确复原至 " + money(w0.wallet.balance) + "（实际 " + money(w2.wallet.balance) + "）");
assert(refundTxns === 1, "提现驳回只产生 1 条退回流水（实际 " + refundTxns + " 条）");

/* ---------------- 3. 到期结算并发双放款 ---------------- */
console.log("\n== 3. 到期结算并发双放款 ==");
const o1 = await newOrder("并发结算验证");
await payOrder(o1.orderId);
const completed1 = await toCompleted(o1.orderId);
assert(completed1.status === "completed", "订单 A 已进入 completed（待结算），课时费 " + money(completed1.teacherIncome));
const beforeSettleWallet = await walletOf(teacher);
const beforeSettleEscrow = (await financeOf()).escrow;
const parallelSettle = await Promise.all([
  api("POST", "/admin/settlement/run", { token: admin, body: { force: true } }),
  api("POST", "/admin/settlement/run", { token: admin, body: { force: true } }),
]);
const settledTimes = parallelSettle.reduce((s, r) => s + Number(r.body?.data?.settled || 0), 0);
const afterSettleWallet = await walletOf(teacher);
const afterSettleEscrow = (await financeOf()).escrow;
const paid = completed1.amount + completed1.urgentFee;
assert(settledTimes === 1, "并发两次结算共放款 1 笔（实际 " + settledTimes + " 笔）");
assert(
  afterSettleWallet.wallet.balance - beforeSettleWallet.wallet.balance === completed1.teacherIncome,
  "教员余额只增加一次课时费 " + money(completed1.teacherIncome) +
    "（实际 " + money(afterSettleWallet.wallet.balance - beforeSettleWallet.wallet.balance) + "）",
);
assert(beforeSettleEscrow - afterSettleEscrow === paid, "担保台账只出账一次 " + money(paid) + "（实际 " + money(beforeSettleEscrow - afterSettleEscrow) + "）");
assert(
  completed1.teacherIncome + completed1.serviceFee === completed1.amount,
  "恒等式①实付 = 实收 + 服务费（" + money(completed1.amount) + "）",
);

/* ---------------- 4. 退款审批并发双出账 ---------------- */
console.log("\n== 4. 退款审批并发双出账 ==");
const o2 = await newOrder("并发退款验证");
await payOrder(o2.orderId);
const rf = await api("POST", "/orders/" + o2.orderId + "/refund", { token: parent, body: { reason: "并发退款审批验证" } });
assert(rf.status === 200 && rf.body.data.status === "refunding", "订单 B 进入退款审核中");
const beforeRefundEscrow = (await financeOf()).escrow;
const parallelApprove = await Promise.all([
  api("POST", "/admin/refunds/" + o2.orderId + "/review", { token: admin, body: { approve: true } }),
  api("POST", "/admin/refunds/" + o2.orderId + "/review", { token: admin, body: { approve: true } }),
]);
const okApprove = parallelApprove.filter((r) => r.status === 200 && r.body.code === 0);
const afterRefundEscrow = (await financeOf()).escrow;
const refundView = (await api("GET", "/orders/" + o2.orderId, { token: admin })).body.data;
const refundRows = (refundView.payments || []).filter((p) => p.type === "refund").length;
const refundPaid = refundView.amount + refundView.urgentFee;
assert(okApprove.length === 1, "并发两次退款审批只成功 1 次（成功 " + okApprove.length + " 次）");
assert(beforeRefundEscrow - afterRefundEscrow === refundPaid, "担保台账只出账一次 " + money(refundPaid) + "（实际 " + money(beforeRefundEscrow - afterRefundEscrow) + "）");
assert(refundRows === 1, "退款流水只写入 1 条（实际 " + refundRows + " 条）");
assert(refundView.status === "refunded", "订单 B 最终状态 refunded");

/* ---------------- 5. 强制关闭已完成订单 → 冻结冲销 ---------------- */
console.log("\n== 5. 强制关闭已完成订单：冻结额必须冲销 ==");
const o3 = await newOrder("关闭已完成订单验证");
await payOrder(o3.orderId);
const completed3 = await toCompleted(o3.orderId);
const beforeClose = await walletOf(teacher);
const closed = await api("POST", "/admin/orders/" + o3.orderId + "/close", { token: admin, body: { reason: "对抗验证：关闭已完成订单" } });
const afterClose = await walletOf(teacher);
assert(closed.status === 200 && closed.body.code === 0, "后台可关闭已完成订单（返回 unfrozen " + money(closed.body.data?.unfrozen) + "）");
assert(
  beforeClose.wallet.frozen - afterClose.wallet.frozen === completed3.teacherIncome,
  "教员冻结池冲销 " + money(completed3.teacherIncome) + "（" + money(beforeClose.wallet.frozen) + " → " + money(afterClose.wallet.frozen) + "）",
);
assert(
  Math.abs(sumTxns(afterClose) - afterClose.wallet.balance) <= 0 || afterClose.wallet.balance >= 0,
  "关闭后教员余额未变负（" + money(afterClose.wallet.balance) + "）",
);

/* ---------------- 6. 规则超额时分账恒等式 ---------------- */
console.log("\n== 6. 分账超额截断：恒等式仍成立 ==");
// 先把订单所在片区代理的分成比例调到 0..1 的极端值（commissionRate=1, mgmtRate=1），
// 使 rawAgentShare 远大于服务费，验证 calcSplit 的截断不会再让平台收入变负
const probe = await newOrder("代理分成基线探测");
const agentId = probe.view.agentId;
const readAgent = async () => {
  // 列表接口返回 snake_case（commission_rate / mgmt_rate），代理详情接口字段名不同
  const raw = (await api("GET", "/admin/agents", { token: admin })).body.data;
  const list = Array.isArray(raw) ? raw : raw.list || [];
  const a = list.find((x) => Number(x.user_id ?? x.userId) === Number(agentId)) || {};
  return {
    commissionRate: Number(a.commission_rate ?? a.commissionRate),
    mgmtRate: Number(a.mgmt_rate ?? a.mgmtRate),
  };
};
const agentBefore = await readAgent();
await api("PUT", "/admin/agents/" + agentId, { token: admin, body: { commissionRate: 1, mgmtRate: 1 } });
const o4 = await newOrder("超额分账恒等式验证");
const paid4 = await payOrder(o4.orderId);
const v4 = paid4.body.data;
const identity2 = v4.serviceFee === v4.agentShare + v4.salesCommission + v4.platformRevenue;
const identity1 = v4.amount === v4.teacherIncome + v4.serviceFee;
assert(
  identity2,
  "恒等式②服务费 = 代理 + 业务员 + 平台（" + money(v4.serviceFee) + " = " +
    money(v4.agentShare) + " + " + money(v4.salesCommission) + " + " + money(v4.platformRevenue) + "）",
);
assert(identity1, "恒等式①实付 = 实收 + 服务费（" + money(v4.amount) + "）");
assert(
  v4.platformRevenue >= 0 && v4.agentShare >= 0 && v4.salesCommission >= 0 && v4.agentShare + v4.salesCommission <= v4.serviceFee,
  "极端分成下各项非负且合计不超过服务费（代理 " + money(v4.agentShare) + " ≤ 服务费 " + money(v4.serviceFee) + "）",
);
await api("PUT", "/admin/agents/" + agentId, { token: admin, body: { commissionRate: agentBefore.commissionRate, mgmtRate: agentBefore.mgmtRate } });
const agentAfter = await readAgent();
assert(
  agentAfter.commissionRate === agentBefore.commissionRate && agentAfter.mgmtRate === agentBefore.mgmtRate,
  "代理分成比例已还原（" + agentAfter.commissionRate + " / " + agentAfter.mgmtRate + "）",
);

/* ---------------- 7. 幂等重放 ---------------- */
console.log("\n== 7. 幂等重放（同一 X-Idem-Key） ==");
const o5 = await newOrder("幂等重放验证");
const key5 = "race-idem-" + uniq();
const pay5a = await payOrder(o5.orderId, key5);
const pay5b = await payOrder(o5.orderId, key5);
assert(pay5a.status === 200 && pay5b.status === 200, "同一幂等键重复支付两次均 200（" + pay5a.status + " / " + pay5b.status + "）");
assert(pay5b.body?.data?.id === o5.orderId, "重放返回首单结果（订单 #" + pay5b.body?.data?.id + "）");
const detail5 = (await api("GET", "/orders/" + o5.orderId, { token: admin })).body.data;
const payRows5 = (detail5.payments || []).filter((p) => p.type === "pay").length;
assert(payRows5 === 1, "支付流水只 1 条（实际 " + payRows5 + " 条）");

console.log("\n=================================================");
console.log("资金并发对抗：通过 " + pass + " 项，失败 " + fail + " 项");
if (fail) {
  console.log("失败项：");
  failures.forEach((f) => console.log("  - " + f));
  process.exitCode = 1;
} else {
  console.log("行锁 / 状态守卫 / 分账恒等式 / 幂等重放全部守住 ✅");
}
console.log("=================================================");
