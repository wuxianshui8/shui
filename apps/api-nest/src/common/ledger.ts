// 资金台账（需求 5.4）：担保账户 + 用户钱包，金额全部为「分」整数
// 任何资金变动都必须同时写入 wallet_txns / escrow_ledger，保证可对账
//
// 并发约束（本文件是唯一写入口，改这里前请先读这段）：
//  1. 所有钱包变动必须在事务内、且先 `lockWallet()` 用 `SELECT … FOR UPDATE` 取得行锁，
//     否则「读快照 → 算新值 → 绝对写回」会丢更新（两笔提现并发可双花）。
//  2. 担保台账的 `balance` 是全局 running balance，`SUM()` 快照 + 写一行本身不是原子的，
//     因此用 MySQL 命名锁 `GET_LOCK('jiajiao:escrow')` 串行化「读合计 + 追加一行」。
import { EntityManager } from "typeorm";
import { nowIso } from "./reply";
import { biz } from "./errors";

/** 按比例切分金额，四舍五入到分（与参考实现 core/money.js 一致） */
export const applyRate = (cents: number, rate: number) => Math.round(Number(cents) * Number(rate));

/** 只读快照：钱包不存在则创建（不加锁，仅用于展示/校验） */
export async function ensureWallet(m: EntityManager, userId: number) {
  let rows = await m.query("SELECT * FROM `wallets` WHERE `user_id` = ? LIMIT 1", [userId]);
  if (!rows.length) {
    await m.query(
      "INSERT IGNORE INTO `wallets` (`user_id`,`balance`,`frozen`,`total_income`,`total_withdraw`,`updated_at`) VALUES (?,0,0,0,0,?)",
      [userId, nowIso()],
    );
    rows = await m.query("SELECT * FROM `wallets` WHERE `user_id` = ? LIMIT 1", [userId]);
  }
  return rows[0];
}

/** 行级加锁读取（必须在事务内调用）：资金变动前唯一的读入口 */
async function lockWallet(m: EntityManager, userId: number) {
  await m.query(
    "INSERT IGNORE INTO `wallets` (`user_id`,`balance`,`frozen`,`total_income`,`total_withdraw`,`updated_at`) VALUES (?,0,0,0,0,?)",
    [userId, nowIso()],
  );
  const rows = await m.query("SELECT * FROM `wallets` WHERE `user_id` = ? FOR UPDATE", [userId]);
  if (!rows.length) throw biz("WALLET_LOCK_FAILED", "钱包锁定失败，请重试");
  return rows[0];
}

async function txn(m: EntityManager, userId: number, type: string, amount: number, balanceAfter: number, orderId: number | null, remark: string) {
  await m.query(
    "INSERT INTO `wallet_txns` (`user_id`,`order_id`,`type`,`amount`,`balance_after`,`status`,`remark`,`created_at`) VALUES (?,?,?,?,?,?,?,?)",
    [userId, orderId, type, amount, balanceAfter, "done", remark, nowIso()],
  );
}

/** 可用余额增减（amount 可正可负）；余额不足抛 INSUFFICIENT_BALANCE */
export async function walletAdd(m: EntityManager, userId: number, amount: number, opts: { orderId?: number; type?: string; remark?: string }) {
  const w = await lockWallet(m, userId);
  const next = Number(w.balance) + amount;
  if (next < 0) throw biz("INSUFFICIENT_BALANCE", "可用余额不足");
  const income = amount > 0 ? Number(w.total_income) + amount : Number(w.total_income);
  await m.query("UPDATE `wallets` SET `balance` = ?, `total_income` = ?, `updated_at` = ? WHERE `user_id` = ?", [next, income, nowIso(), userId]);
  await txn(m, userId, opts.type || (amount >= 0 ? "income" : "expense"), amount, next, opts.orderId ?? null, opts.remark || "");
  return next;
}

/** 可用 → 冻结（提现冻结等场景） */
export async function walletFreeze(m: EntityManager, userId: number, amount: number, opts: { orderId?: number; type?: string; remark?: string }) {
  const w = await lockWallet(m, userId);
  if (Number(w.balance) < amount) throw biz("INSUFFICIENT_BALANCE", "可用余额不足");
  const next = Number(w.balance) - amount;
  await m.query("UPDATE `wallets` SET `balance` = ?, `frozen` = `frozen` + ?, `updated_at` = ? WHERE `user_id` = ?", [next, amount, nowIso(), userId]);
  await txn(m, userId, opts.type || "freeze", -amount, next, opts.orderId ?? null, opts.remark || "");
  return next;
}

/** 外部资金直接计入冻结（订单完成待结算的课时费） */
export async function walletFreezeIncoming(m: EntityManager, userId: number, amount: number, opts: { orderId?: number; type?: string; remark?: string }) {
  const w = await lockWallet(m, userId);
  await m.query("UPDATE `wallets` SET `frozen` = `frozen` + ?, `updated_at` = ? WHERE `user_id` = ?", [amount, nowIso(), userId]);
  await txn(m, userId, opts.type || "freeze", amount, Number(w.balance), opts.orderId ?? null, opts.remark || "");
  return Number(w.frozen) + amount;
}

/** 冲销冻结中的金额（退款、风控解冻回滚） */
export async function walletUnfreezeIncoming(m: EntityManager, userId: number, amount: number, opts: { orderId?: number; type?: string; remark?: string }) {
  const w = await lockWallet(m, userId);
  const take = Math.min(amount, Number(w.frozen));
  if (take <= 0) return Number(w.frozen);
  await m.query("UPDATE `wallets` SET `frozen` = `frozen` - ?, `updated_at` = ? WHERE `user_id` = ?", [take, nowIso(), userId]);
  await txn(m, userId, opts.type || "unfreeze", -take, Number(w.balance), opts.orderId ?? null, opts.remark || "");
  return Number(w.frozen) - take;
}

/** 冻结 → 可用（结算放行） */
export async function walletSettle(m: EntityManager, userId: number, amount: number, opts: { orderId?: number; type?: string; remark?: string }) {
  const w = await lockWallet(m, userId);
  const take = Math.min(amount, Number(w.frozen));
  if (take <= 0) return Number(w.balance);
  const next = Number(w.balance) + take;
  await m.query(
    "UPDATE `wallets` SET `frozen` = `frozen` - ?, `balance` = `balance` + ?, `total_income` = `total_income` + ?, `updated_at` = ? WHERE `user_id` = ?",
    [take, take, take, nowIso(), userId],
  );
  await txn(m, userId, opts.type || "lesson_income", take, next, opts.orderId ?? null, opts.remark || "");
  return next;
}

/** 钱包快照（对外字段名为 camelCase） */
export async function walletSnapshot(m: EntityManager | any, userId: number) {
  const w = await ensureWallet(m, userId);
  return {
    balance: Number(w.balance),
    frozen: Number(w.frozen),
    totalIncome: Number(w.total_income),
    totalWithdraw: Number(w.total_withdraw),
  };
}

export async function escrowBalance(m: EntityManager | any) {
  const rows = await m.query("SELECT COALESCE(SUM(CASE WHEN `direction` = 'in' THEN `amount` ELSE -`amount` END),0) AS b FROM `escrow_ledger`");
  return Number(rows[0].b);
}

/**
 * 担保台账出入账。
 * running balance 是全局量，必须在「读合计 → 追加一行」期间独占，
 * 因此用命名锁串行化；负余额校验同时阻止把其他订单的在保资金挪走。
 */
export async function escrowMove(m: EntityManager, orderId: number, direction: "in" | "out", amount: number, remark: string) {
  await m.query("SELECT GET_LOCK('jiajiao:escrow', 5) AS l");
  try {
    const bal = (await escrowBalance(m)) + (direction === "in" ? amount : -amount);
    if (bal < 0) throw biz("ESCROW_NEGATIVE", "担保账户台账异常");
    await m.query(
      "INSERT INTO `escrow_ledger` (`order_id`,`direction`,`amount`,`balance`,`remark`,`created_at`) VALUES (?,?,?,?,?,?)",
      [orderId, direction, amount, bal, remark, nowIso()],
    );
    return bal;
  } finally {
    try {
      await m.query("SELECT RELEASE_LOCK('jiajiao:escrow') AS l");
    } catch {
      /* 连接回收时锁自动释放 */
    }
  }
}
