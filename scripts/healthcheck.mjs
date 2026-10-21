// ============================================================
// 数据一致性巡检（运维用，可加入定时任务每日执行）
//   校验资金台账、分账恒等式、钱包流水、孤儿数据、状态字段一致性
//   直接读库，不需要启动 HTTP 服务
// 用法：node scripts/healthcheck.mjs  （退出码 0=全部通过，1=存在异常）
// ============================================================
import { get, all } from "../server/core/db.js";

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: r.ok, detail: r.detail });
  } catch (e) {
    results.push({ name, ok: false, detail: "检查异常：" + e.message });
  }
}
const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);
const count = (sql, ...p) => get(sql, ...p).c;

/* 1. 担保台账余额 = 已支付未结算未退款订单总额 */
check("担保台账余额与在途订单一致", () => {
  const esc = get("SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END),0) AS b FROM escrow_ledger").b;
  const should = get(
    "SELECT COALESCE(SUM(amount + urgent_fee),0) AS s FROM orders WHERE paid_at IS NOT NULL AND status NOT IN ('settled','refunded','cancelled')"
  ).s;
  return { ok: esc === should, detail: "台账 " + money(esc) + " / 应为 " + money(should) };
});

/* 2. 逐单分账恒等式 */
check("订单分账恒等式（逐单）", () => {
  const bad1 = count(
    "SELECT COUNT(*) AS c FROM orders WHERE paid_at IS NOT NULL AND teacher_income + service_fee <> amount"
  );
  const bad2 = count(
    "SELECT COUNT(*) AS c FROM orders WHERE paid_at IS NOT NULL AND agent_share + sales_commission + platform_revenue <> service_fee"
  );
  return {
    ok: bad1 === 0 && bad2 === 0,
    detail: "①实付=实收+服务费 异常 " + bad1 + " 单；②服务费=代理+业务员+平台 异常 " + bad2 + " 单",
  };
});

/* 3. 钱包余额 = 最后一条流水余额 */
check("钱包余额与流水末笔一致", () => {
  const rows = all(`
    SELECT w.user_id, w.balance, (
      SELECT t.balance_after FROM wallet_txns t WHERE t.user_id = w.user_id ORDER BY t.id DESC LIMIT 1
    ) AS last_after
    FROM wallets w
  `);
  const bad = rows.filter((r) => r.last_after !== null && r.balance !== r.last_after);
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? bad.slice(0, 3).map((b) => "user#" + b.user_id + " 余额 " + money(b.balance) + " / 末笔 " + money(b.last_after)).join("；")
      : rows.length + " 个钱包全部一致",
  };
});

/* 4. 冻结池 = 待结算订单的教员收入 */
check("冻结池与待结算订单金额一致", () => {
  const frozen = get("SELECT COALESCE(SUM(frozen),0) AS s FROM wallets").s;
  const should = get("SELECT COALESCE(SUM(teacher_income),0) AS s FROM orders WHERE status = 'completed'").s;
  return { ok: frozen === should, detail: "冻结 " + money(frozen) + " / 应为 " + money(should) };
});

/* 5. 无负数余额与负数冻结 */
check("钱包余额与冻结金额非负", () => {
  const bad = count("SELECT COUNT(*) AS c FROM wallets WHERE balance < 0 OR frozen < 0");
  return { ok: bad === 0, detail: bad + " 个钱包为负数" };
});

/* 6. 孤儿数据 */
check("无孤儿关联数据", () => {
  const a = count("SELECT COUNT(*) AS c FROM applications a LEFT JOIN demands d ON d.id = a.demand_id WHERE d.id IS NULL");
  const b = count("SELECT COUNT(*) AS c FROM orders o LEFT JOIN users u ON u.id = o.parent_id WHERE u.id IS NULL");
  const c2 = count("SELECT COUNT(*) AS c FROM orders o LEFT JOIN users u ON u.id = o.teacher_id WHERE u.id IS NULL");
  const d = count("SELECT COUNT(*) AS c FROM wallet_txns t LEFT JOIN users u ON u.id = t.user_id WHERE u.id IS NULL");
  const e = count("SELECT COUNT(*) AS c FROM bindings bd LEFT JOIN users u ON u.id = bd.user_id WHERE u.id IS NULL");
  const total = a + b + c2 + d + e;
  return {
    ok: total === 0,
    detail: "报名 " + a + " / 家长 " + b + " / 教员 " + c2 + " / 流水 " + d + " / 归属 " + e,
  };
});

/* 7. 已匹配需求必须有确认报名与订单 */
check("已匹配需求具备确认报名与订单", () => {
  const rows = all("SELECT id, confirm_app_id FROM demands WHERE status = 'matched'");
  const bad = rows.filter((d) => !d.confirm_app_id || !get("SELECT id FROM orders WHERE demand_id = ?", d.id));
  return { ok: bad.length === 0, detail: rows.length + " 条已匹配需求，异常 " + bad.length + " 条" };
});

/* 8. 无重复报名 */
check("报名记录无重复（需求 + 教员）", () => {
  const bad = all(
    "SELECT demand_id, teacher_id, COUNT(*) AS c FROM applications GROUP BY demand_id, teacher_id HAVING c > 1"
  );
  return { ok: bad.length === 0, detail: bad.length + " 组重复" };
});

/* 9. 同一订单最多 1 张有效发票申请 */
check("同一订单仅 1 张有效发票申请", () => {
  const bad = all(
    "SELECT order_id, COUNT(*) AS c FROM invoices WHERE status <> 'rejected' GROUP BY order_id HAVING c > 1"
  );
  return { ok: bad.length === 0, detail: bad.length + " 条订单存在多张有效申请" };
});

/* 10. 订单状态与时间字段一致 */
check("订单状态与时间字段一致", () => {
  const noPaid = count("SELECT COUNT(*) AS c FROM orders WHERE paid_at IS NOT NULL AND status = 'awaiting_payment'");
  const noConfirm = count("SELECT COUNT(*) AS c FROM orders WHERE status IN ('completed','settled') AND confirm_at IS NULL");
  const noSettleAt = count("SELECT COUNT(*) AS c FROM orders WHERE status = 'completed' AND settle_at IS NULL");
  const noCheckin = count("SELECT COUNT(*) AS c FROM orders WHERE status IN ('in_class','awaiting_parent_confirm','completed','settled') AND checkin_at IS NULL");
  const total = noPaid + noConfirm + noSettleAt + noCheckin;
  return {
    ok: total === 0,
    detail: "已付款仍待付款 " + noPaid + " / 完成无确认时间 " + noConfirm + " / 完成无结算时间 " + noSettleAt + " / 已上课无打卡 " + noCheckin,
  };
});

/* 11. 已终结订单在担保台账有出账记录 */
check("已结算/已退款订单在担保台账有出账", () => {
  const rows = all("SELECT id, order_no FROM orders WHERE status IN ('settled','refunded','cancelled') AND paid_at IS NOT NULL");
  const bad = rows.filter(
    (o) => !get("SELECT id FROM escrow_ledger WHERE order_id = ? AND direction = 'out'", o.id)
  );
  return { ok: bad.length === 0, detail: rows.length + " 笔终结订单，缺出账 " + bad.length + " 笔" };
});

/* 12. 待审核教员 / 待受理提现等不出现非法状态值 */
check("关键状态字段取值合法", () => {
  const badOrder = count(
    "SELECT COUNT(*) AS c FROM orders WHERE status NOT IN ('awaiting_payment','pending_class','in_class','awaiting_parent_confirm','completed','settled','cancelled','refunding','refunded')"
  );
  const badInvoice = count("SELECT COUNT(*) AS c FROM invoices WHERE status NOT IN ('pending','issued','rejected')");
  const badWithdraw = count("SELECT COUNT(*) AS c FROM withdrawals WHERE status NOT IN ('pending','paid','rejected','approved')");
  const total = badOrder + badInvoice + badWithdraw;
  return { ok: total === 0, detail: "订单 " + badOrder + " / 发票 " + badInvoice + " / 提现 " + badWithdraw };
});

/* ---------- 输出 ---------- */
const pad = (s, n) => String(s).padEnd(n);
console.log("家教平台 · 数据一致性巡检");
console.log("时间：" + new Date().toLocaleString("zh-CN", { hour12: false }) + "\n");
console.log(pad("检查项", 30) + pad("结果", 8) + "说明");
console.log("-".repeat(96));
for (const r of results) {
  console.log(pad(r.name, 30) + pad(r.ok ? "PASS" : "FAIL", 8) + r.detail);
}
const bad = results.filter((r) => !r.ok);
console.log("\n共 " + results.length + " 项，异常 " + bad.length + " 项");
if (bad.length) {
  console.log("异常项：" + bad.map((b) => b.name).join("，"));
  process.exitCode = 1;
} else {
  console.log("资金台账、分账、钱包、状态与关联数据全部自洽 ✅");
}