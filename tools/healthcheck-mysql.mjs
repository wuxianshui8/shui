// ============================================================
// 数据一致性巡检（MySQL 权威库版本，对齐 scripts/healthcheck.mjs 的 12 项）
//   直接读库，不需要启动 HTTP 服务
// 用法：node tools/healthcheck-mysql.mjs（退出码 0=全部通过，1=存在异常）
// ============================================================
import { createRequire } from "node:module";

const requireFromApi = createRequire(new URL("../apps/api-nest/package.json", import.meta.url));
const mysql = requireFromApi("mysql2/promise");

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3307),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "jiajiao",
  supportBigNumbers: true,
  bigNumberStrings: false,
});
const get = async (sql, p = []) => (await conn.query(sql, p))[0][0];
const all = async (sql, p = []) => (await conn.query(sql, p))[0];
const count = async (sql, p = []) => Number((await get(sql, p)).c);

const results = [];
async function check(name, fn) {
  try {
    const r = await fn();
    results.push({ name, ok: r.ok, detail: r.detail });
  } catch (e) {
    results.push({ name, ok: false, detail: "检查异常：" + e.message });
  }
}
const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);

/* 1. 担保台账余额 = 已支付未结算未退款订单总额 */
await check("担保台账余额与在途订单一致", async () => {
  const esc = Number((await get("SELECT COALESCE(SUM(CASE WHEN `direction` = 'in' THEN `amount` ELSE -`amount` END),0) AS b FROM `escrow_ledger`")).b);
  const should = Number((await get(
    "SELECT COALESCE(SUM(`amount` + `urgent_fee`),0) AS s FROM `orders` WHERE `paid_at` IS NOT NULL AND `status` NOT IN ('settled','refunded','cancelled')",
  )).s);
  return { ok: esc === should, detail: "台账 " + money(esc) + " / 应为 " + money(should) };
});

/* 2. 逐单分账恒等式 */
await check("订单分账恒等式（逐单）", async () => {
  const bad1 = await count("SELECT COUNT(*) AS c FROM `orders` WHERE `paid_at` IS NOT NULL AND `teacher_income` + `service_fee` <> `amount`");
  const bad2 = await count("SELECT COUNT(*) AS c FROM `orders` WHERE `paid_at` IS NOT NULL AND `agent_share` + `sales_commission` + `platform_revenue` <> `service_fee`");
  return { ok: bad1 === 0 && bad2 === 0, detail: "①实付=实收+服务费 异常 " + bad1 + " 单；②服务费=代理+业务员+平台 异常 " + bad2 + " 单" };
});

/* 3. 钱包余额 = 最后一条流水余额 */
await check("钱包余额与流水末笔一致", async () => {
  const rows = await all(`
    SELECT w.\`user_id\`, w.\`balance\`, (
      SELECT t.\`balance_after\` FROM \`wallet_txns\` t WHERE t.\`user_id\` = w.\`user_id\` ORDER BY t.\`id\` DESC LIMIT 1
    ) AS last_after
    FROM \`wallets\` w
  `);
  const bad = rows.filter((r) => r.last_after !== null && Number(r.balance) !== Number(r.last_after));
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? bad.slice(0, 3).map((b) => "user#" + b.user_id + " 余额 " + money(b.balance) + " / 末笔 " + money(b.last_after)).join("；")
      : rows.length + " 个钱包全部一致",
  };
});

/* 4. 冻结池 = 待结算订单的教员收入 */
await check("冻结池与待结算订单金额一致", async () => {
  const frozen = Number((await get("SELECT COALESCE(SUM(`frozen`),0) AS s FROM `wallets`")).s);
  const should = Number((await get("SELECT COALESCE(SUM(`teacher_income`),0) AS s FROM `orders` WHERE `status` = 'completed'")).s);
  return { ok: frozen === should, detail: "冻结 " + money(frozen) + " / 应为 " + money(should) };
});

/* 5. 无负数余额与负数冻结 */
await check("钱包余额与冻结金额非负", async () => {
  const bad = await count("SELECT COUNT(*) AS c FROM `wallets` WHERE `balance` < 0 OR `frozen` < 0");
  return { ok: bad === 0, detail: bad + " 个钱包为负数" };
});

/* 6. 孤儿数据 */
await check("无孤儿关联数据", async () => {
  const a = await count("SELECT COUNT(*) AS c FROM `applications` a LEFT JOIN `demands` d ON d.id = a.demand_id WHERE d.id IS NULL");
  const b = await count("SELECT COUNT(*) AS c FROM `orders` o LEFT JOIN `users` u ON u.id = o.parent_id WHERE u.id IS NULL");
  const c2 = await count("SELECT COUNT(*) AS c FROM `orders` o LEFT JOIN `users` u ON u.id = o.teacher_id WHERE u.id IS NULL");
  const d = await count("SELECT COUNT(*) AS c FROM `wallet_txns` t LEFT JOIN `users` u ON u.id = t.user_id WHERE u.id IS NULL");
  const e = await count("SELECT COUNT(*) AS c FROM `bindings` bd LEFT JOIN `users` u ON u.id = bd.user_id WHERE u.id IS NULL");
  const total = a + b + c2 + d + e;
  return { ok: total === 0, detail: "报名 " + a + " / 家长 " + b + " / 教员 " + c2 + " / 流水 " + d + " / 归属 " + e };
});

/* 7. 已匹配需求必须有确认报名与订单 */
await check("已匹配需求具备确认报名与订单", async () => {
  const rows = await all("SELECT `id`,`confirm_app_id` FROM `demands` WHERE `status` = 'matched'");
  let bad = 0;
  for (const d of rows) {
    const hasApp = d.confirm_app_id != null;
    const hasOrder = (await all("SELECT `id` FROM `orders` WHERE `demand_id` = ?", [d.id])).length > 0;
    if (!hasApp || !hasOrder) bad++;
  }
  return { ok: bad === 0, detail: rows.length + " 条已匹配需求，异常 " + bad + " 条" };
});

/* 8. 无重复报名 */
await check("报名记录无重复（需求 + 教员）", async () => {
  const bad = await all("SELECT `demand_id`,`teacher_id`,COUNT(*) AS c FROM `applications` GROUP BY `demand_id`,`teacher_id` HAVING c > 1");
  return { ok: bad.length === 0, detail: bad.length + " 组重复" };
});

/* 9. 同一订单最多 1 张有效发票申请 */
await check("同一订单仅 1 张有效发票申请", async () => {
  const bad = await all("SELECT `order_id`,COUNT(*) AS c FROM `invoices` WHERE `status` <> 'rejected' GROUP BY `order_id` HAVING c > 1");
  return { ok: bad.length === 0, detail: bad.length + " 条订单存在多张有效申请" };
});

/* 10. 订单状态与时间字段一致 */
await check("订单状态与时间字段一致", async () => {
  const noPaid = await count("SELECT COUNT(*) AS c FROM `orders` WHERE `paid_at` IS NOT NULL AND `status` = 'awaiting_payment'");
  const noConfirm = await count("SELECT COUNT(*) AS c FROM `orders` WHERE `status` IN ('completed','settled') AND `confirm_at` IS NULL");
  const noSettleAt = await count("SELECT COUNT(*) AS c FROM `orders` WHERE `status` = 'completed' AND `settle_at` IS NULL");
  const noCheckin = await count("SELECT COUNT(*) AS c FROM `orders` WHERE `status` IN ('in_class','awaiting_parent_confirm','completed','settled') AND `checkin_at` IS NULL");
  const total = noPaid + noConfirm + noSettleAt + noCheckin;
  return {
    ok: total === 0,
    detail: "已付款仍待付款 " + noPaid + " / 完成无确认时间 " + noConfirm + " / 完成无结算时间 " + noSettleAt + " / 已上课无打卡 " + noCheckin,
  };
});

/* 11. 已终结订单在担保台账有出账记录 */
await check("已结算/已退款订单在担保台账有出账", async () => {
  const rows = await all("SELECT `id`,`order_no` FROM `orders` WHERE `status` IN ('settled','refunded','cancelled') AND `paid_at` IS NOT NULL");
  let bad = 0;
  for (const o of rows) {
    const out = await all("SELECT `id` FROM `escrow_ledger` WHERE `order_id` = ? AND `direction` = 'out'", [o.id]);
    if (!out.length) bad++;
  }
  return { ok: bad === 0, detail: rows.length + " 笔终结订单，缺出账 " + bad + " 笔" };
});

/* 12. 关键状态字段取值合法 */
await check("关键状态字段取值合法", async () => {
  const badOrder = await count(
    "SELECT COUNT(*) AS c FROM `orders` WHERE `status` NOT IN ('awaiting_payment','pending_class','in_class','awaiting_parent_confirm','completed','settled','cancelled','refunding','refunded')",
  );
  const badInvoice = await count("SELECT COUNT(*) AS c FROM `invoices` WHERE `status` NOT IN ('pending','issued','rejected')");
  const badWithdraw = await count("SELECT COUNT(*) AS c FROM `withdrawals` WHERE `status` NOT IN ('pending','paid','rejected','approved')");
  const total = badOrder + badInvoice + badWithdraw;
  return { ok: total === 0, detail: "订单 " + badOrder + " / 发票 " + badInvoice + " / 提现 " + badWithdraw };
});

console.log("MySQL 数据一致性巡检（库：" + (process.env.MYSQL_DATABASE || "jiajiao") + "）\n");
let bad = 0;
for (const r of results) {
  console.log((r.ok ? "  ✓ " : "  ✗ ") + r.name + "  —  " + r.detail);
  if (!r.ok) bad++;
}
console.log("\n共 " + results.length + " 项，异常 " + bad + " 项");
if (bad === 0) console.log("资金台账、分账、钱包、状态与关联数据全部自洽 ✅");
await conn.end();
process.exitCode = bad ? 1 : 0;
