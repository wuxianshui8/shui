// ============================================================
// 资金台账：担保账户 + 用户钱包（金额均为「分」整数）
// 任何资金变动都必须同时写入 wallet_txns / escrow_ledger，保证可对账
// ============================================================
import { get, run } from "./db.js";
import { nowIso } from "./ids.js";
import { Err } from "./http.js";

export function ensureWallet(userId) {
  let w = get("SELECT * FROM wallets WHERE user_id = ?", userId);
  if (!w) {
    run(
      "INSERT OR IGNORE INTO wallets (user_id, balance, frozen, total_income, total_withdraw, updated_at) VALUES (?,0,0,0,0,?)",
      userId,
      nowIso()
    );
    w = get("SELECT * FROM wallets WHERE user_id = ?", userId);
  }
  return w;
}

function writeTxn(userId, type, amount, balanceAfter, orderId, remark) {
  run(
    "INSERT INTO wallet_txns (user_id, order_id, type, amount, balance_after, status, remark, created_at) VALUES (?,?,?,?,?,?,?,?)",
    userId,
    orderId,
    type,
    amount,
    balanceAfter,
    "done",
    remark,
    nowIso()
  );
}

/** 可用余额增减（amount 可正可负） */
export function walletAdd(userId, amount, { orderId = null, type, remark = "" } = {}) {
  const w = ensureWallet(userId);
  const next = w.balance + amount;
  if (next < 0) throw Err.biz("INSUFFICIENT_BALANCE", "可用余额不足");
  const income = amount > 0 ? w.total_income + amount : w.total_income;
  run(
    "UPDATE wallets SET balance = ?, total_income = ?, updated_at = ? WHERE user_id = ?",
    next,
    income,
    nowIso(),
    userId
  );
  writeTxn(userId, type || (amount >= 0 ? "income" : "expense"), amount, next, orderId, remark);
  return next;
}

/** 可用 → 冻结 */
export function walletFreeze(userId, amount, { orderId = null, type = "freeze", remark = "" } = {}) {
  const w = ensureWallet(userId);
  if (w.balance < amount) throw Err.biz("INSUFFICIENT_BALANCE", "可用余额不足");
  run(
    "UPDATE wallets SET balance = balance - ?, frozen = frozen + ?, updated_at = ? WHERE user_id = ?",
    amount,
    amount,
    nowIso(),
    userId
  );
  writeTxn(userId, type, -amount, w.balance - amount, orderId, remark);
  return w.balance - amount;
}

/** 冻结 → 可用 */
export function walletUnfreeze(userId, amount, { orderId = null, type = "unfreeze", remark = "" } = {}) {
  const w = ensureWallet(userId);
  const take = Math.min(amount, w.frozen);
  if (take <= 0) return w.balance;
  run(
    "UPDATE wallets SET frozen = frozen - ?, balance = balance + ?, total_income = total_income + ?, updated_at = ? WHERE user_id = ?",
    take,
    take,
    take,
    nowIso(),
    userId
  );
  writeTxn(userId, type, take, w.balance + take, orderId, remark);
  return w.balance + take;
}

/** 冻结金额直接入可用账（结算放行） */
export function walletSettle(userId, amount, { orderId = null, type = "lesson_income", remark = "" } = {}) {
  const w = ensureWallet(userId);
  const take = Math.min(amount, w.frozen);
  if (take <= 0) return w.balance;
  run(
    "UPDATE wallets SET frozen = frozen - ?, balance = balance + ?, total_income = total_income + ?, updated_at = ? WHERE user_id = ?",
    take,
    take,
    take,
    nowIso(),
    userId
  );
  writeTxn(userId, type, take, w.balance + take, orderId, remark);
  return w.balance + take;
}

export function walletSnapshot(userId) {
  const w = ensureWallet(userId);
  return { balance: w.balance, frozen: w.frozen, totalIncome: w.total_income, totalWithdraw: w.total_withdraw };
}

/* ---------------- 担保账户台账 ---------------- */
export function escrowBalance() {
  const row = get("SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END),0) AS b FROM escrow_ledger");
  return row ? row.b : 0;
}

export function escrowMove(orderId, direction, amount, remark) {
  const bal = escrowBalance() + (direction === "in" ? amount : -amount);
  if (bal < 0) throw Err.biz("ESCROW_NEGATIVE", "担保账户台账异常");
  run(
    "INSERT INTO escrow_ledger (order_id, direction, amount, balance, remark, created_at) VALUES (?,?,?,?,?,?)",
    orderId,
    direction,
    amount,
    bal,
    remark,
    nowIso()
  );
  return bal;
}
/** 外部资金直接计入冻结（如订单完成后待结算的课时费） */
export function walletFreezeIncoming(userId, amount, { orderId = null, type = "freeze", remark = "" } = {}) {
  ensureWallet(userId);
  run("UPDATE wallets SET frozen = frozen + ?, updated_at = ? WHERE user_id = ?", amount, nowIso(), userId);
  const w = get("SELECT * FROM wallets WHERE user_id = ?", userId);
  writeTxn(userId, type, amount, w.balance, orderId, remark);
  return w.frozen;
}

/** 冲销冻结中的金额（如退款、风控冻结解冻回滚） */
export function walletUnfreezeIncoming(userId, amount, { orderId = null, type = "unfreeze", remark = "" } = {}) {
  const w = ensureWallet(userId);
  const take = Math.min(amount, w.frozen);
  if (take <= 0) return w.frozen;
  run("UPDATE wallets SET frozen = frozen - ?, updated_at = ? WHERE user_id = ?", take, nowIso(), userId);
  writeTxn(userId, type, -take, w.balance, orderId, remark);
  return w.frozen - take;
}