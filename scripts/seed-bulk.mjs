// ============================================================
// 大数据量压测数据集（用于验证需求 7.1 的容量承诺）
//   用法：node scripts/seed-bulk.mjs [家长数] [教员数] [订单数]
//   默认：2000 家长 / 200 教员 / 5000 订单
//   所有订单均为「已结算」终态，并同步写入支付流水、担保台账（入/出）、
//   教员与代理钱包流水，保证 scripts/healthcheck.mjs 全部不变量通过。
//   提示：跑完请 node server/seed.js --reset 还原干净演示库。
// ============================================================
import { db, run, get, all, tx } from "../server/core/db.js";
import { calcSplit, levelByScore } from "../server/core/rules.js";
import { hashPassword } from "../server/core/auth.js";
import { nowIso, orderNo, tradeNo } from "../server/core/ids.js";

const N_PARENTS = Number(process.argv[2] || 2000);
const N_TEACHERS = Number(process.argv[3] || 200);
const N_ORDERS = Number(process.argv[4] || 5000);
const PW = hashPassword("a123456");

const regions = all("SELECT * FROM regions ORDER BY id");
if (!regions.length) {
  console.error("请先执行 node server/seed.js --reset 初始化基础数据");
  process.exit(1);
}
const agents = all("SELECT * FROM agent_profiles");

const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
const pick = (arr, i) => arr[i % arr.length];
const SUBJECTS = ["数学", "英语", "语文", "物理", "化学", "美术", "钢琴", "编程"];
const STAGES = ["小学", "初中", "高中"];

console.log("生成大数据集：" + N_PARENTS + " 家长 / " + N_TEACHERS + " 教员 / " + N_ORDERS + " 订单");
const t0 = Date.now();

/* ---------------- 家长 ---------------- */
const parentIds = [];
db.exec("BEGIN");
try {
  for (let i = 0; i < N_PARENTS; i++) {
    const phone = String(13910000000 + i);
    let u = get("SELECT id FROM users WHERE phone = ?", phone);
    let uid;
    if (u) {
      uid = u.id;
    } else {
      const region = pick(regions, i);
      uid = run(
        "INSERT INTO users (phone, password_hash, nickname, role, status, region_id, created_at) VALUES (?,?,?,?,?,?,?)",
        phone, PW, "压力家长" + String(i + 1).padStart(4, "0"), "parent", "active", region.id, ago(90 - (i % 60))
      ).id;
      const credit = 100 + (i % 380);
      const lv = credit >= 451 ? "L3" : credit >= 251 ? "L2" : credit >= 101 ? "L1" : "L0";
      run("INSERT INTO parent_profiles (user_id, credit_score, credit_level, completed_orders) VALUES (?,?,?,?)", uid, credit, lv, 1 + (i % 5));
      run("INSERT OR IGNORE INTO wallets (user_id, updated_at) VALUES (?,?)", uid, nowIso());
      run(
        "INSERT INTO addresses (user_id, label, contact, phone, region_id, address, lat, lng, is_default, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        uid, "家", "压力家长" + (i + 1), phone, region.id, region.name.replace("杭州·", "") + "压力测试路 " + (i + 1) + " 号",
        region.center_lat + ((i % 20) - 10) * 0.002, region.center_lng + ((i % 15) - 7) * 0.002, 1, ago(80)
      );
    }
    parentIds.push(uid);
  }

  /* ---------------- 教员 ---------------- */
  const teacherIds = [];
  for (let i = 0; i < N_TEACHERS; i++) {
    const phone = String(13920000000 + i);
    let u = get("SELECT id FROM users WHERE phone = ?", phone);
    let uid;
    if (u) {
      uid = u.id;
    } else {
      const region = pick(regions, i);
      uid = run(
        "INSERT INTO users (phone, password_hash, nickname, role, status, region_id, created_at) VALUES (?,?,?,?,?,?,?)",
        phone, PW, "压力教员" + String(i + 1).padStart(4, "0"), "teacher", "active", region.id, ago(85)
      ).id;
      const growth = 100 + (i * 37) % 2400;
      const lv = levelByScore(growth);
      run(
        `INSERT INTO teacher_profiles (user_id, identity_type, real_name, subjects, stages, hourly_price, service_radius_km,
          base_lat, base_lng, audit_status, online, growth_score, level, rating_avg, rating_count, completed_lessons,
          response_factor, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        uid, "part_time", "压力教员" + (i + 1), pick(SUBJECTS, i) + "," + pick(SUBJECTS, i + 3), "小学,初中,高中",
        12000 + (i % 8) * 2000, 6,
        region.center_lat + ((i % 18) - 9) * 0.003, region.center_lng + ((i % 12) - 6) * 0.003,
        "approved", 1, growth, lv.level, Number((4.2 + (i % 8) * 0.1).toFixed(2)), 5 + (i % 40), growth / 6,
        Number((0.9 + (i % 5) * 0.05).toFixed(2)), ago(85), nowIso()
      );
      run("INSERT OR IGNORE INTO wallets (user_id, updated_at) VALUES (?,?)", uid, nowIso());
      run(
        "INSERT INTO teacher_services (teacher_id, title, subjects, stages, price, cover_radius_km, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        uid, pick(SUBJECTS, i) + " 一对一上门", pick(SUBJECTS, i), "小学,初中", 12000 + (i % 8) * 2000, 6, "压力测试服务", "on", ago(80), nowIso()
      );
    }
    teacherIds.push(uid);
  }
  db.exec("COMMIT");

  /* ---------------- 订单（已结算终态，账目全同步） ---------------- */
  const teacherWallet = new Map(); // uid -> running balance
  const agentWallet = new Map();
  const agentRates = new Map(agents.map((a) => [a.user_id, a]));
  const initWallet = (uid) => {
    if (!teacherWallet.has(uid)) teacherWallet.set(uid, Number(get("SELECT balance FROM wallets WHERE user_id = ?", uid)?.balance || 0));
    return teacherWallet.get(uid);
  };
  const initAgent = (uid) => {
    if (!agentWallet.has(uid)) agentWallet.set(uid, Number(get("SELECT balance FROM wallets WHERE user_id = ?", uid)?.balance || 0));
    return agentWallet.get(uid);
  };

  db.exec("BEGIN");
  for (let i = 0; i < N_ORDERS; i++) {
    const parentId = pick(parentIds, i * 7 + 3);
    const teacherId = pick(teacherIds, i * 11 + 5);
    const tp = get("SELECT level FROM teacher_profiles WHERE user_id = ?", teacherId);
    const amount = 12000 + (i % 10) * 2000;
    // 抽佣比例与 rules.js 的 teacherLevels 配置一致
    const COMMISSION = { Lv1: 0.18, Lv2: 0.15, Lv3: 0.12, Lv4: 0.09, Lv5: 0.06 };
    const rate = COMMISSION[tp?.level] ?? 0.18;
    const agentId = agents.length ? pick(agents, i).user_id : null;
    const ar = agentId ? agentRates.get(agentId) : null;
    const split = calcSplit({
      amount,
      commissionRate: rate,
      feeShareRate: ar ? ar.commission_rate : 0,
      mgmtRate: ar ? ar.mgmt_rate : 0,
      salesRate: 0,
    });
    const region = pick(regions, i);
    const daysAgo = 5 + (i % 55);
    const ts = ago(daysAgo);
    const settledAt = ago(Math.max(0, daysAgo - 7));

    const oid = run(
      `INSERT INTO orders (order_no, parent_id, teacher_id, subject, stage, lesson_time, address, lat, lng, region_id,
        agent_id, amount, status, commission_rate, service_fee, teacher_income, agent_share, sales_commission,
        platform_revenue, paid_at, checkin_at, finished_at, confirm_at, settle_at, remind_sent, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      orderNo(), parentId, teacherId, pick(SUBJECTS, i), pick(STAGES, i * 3),
      ago(daysAgo - 1), "压力测试路 " + (i % 500) + " 号", region.center_lat, region.center_lng, region.id,
      agentId, amount, "settled", rate, split.serviceFee, split.teacherIncome, split.agentShare, split.salesCommission,
      split.platformRevenue, ts, ts, ago(Math.max(0, daysAgo - 0.2)), ago(Math.max(0, daysAgo - 0.3)),
      settledAt, 1, ts, settledAt
    ).id;

    run(
      "INSERT INTO payments (order_id, user_id, type, amount, channel, trade_no, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
      oid, parentId, "pay", amount, "wechat_jsapi", tradeNo("WX"), "success", ts
    );
    // 担保台账：入账 + 结算出账（净额为 0）
    run("INSERT INTO escrow_ledger (order_id, direction, amount, balance, remark, created_at) VALUES (?,?,?,?,?,?)",
      oid, "in", amount, amount, "家长预付 ", ts);
    run("INSERT INTO escrow_ledger (order_id, direction, amount, balance, remark, created_at) VALUES (?,?,?,?,?,?)",
      oid, "out", amount, 0, "订单结算放款", settledAt);

    // 教员钱包
    const tb = initWallet(teacherId) + split.teacherIncome;
    teacherWallet.set(teacherId, tb);
    run("INSERT INTO wallet_txns (user_id, order_id, type, amount, balance_after, status, remark, created_at) VALUES (?,?,?,?,?,?,?,?)",
      teacherId, oid, "lesson_income", split.teacherIncome, tb, "done", "课时费结算", settledAt);

    // 代理钱包
    if (agentId && split.agentShare > 0) {
      const ab = initAgent(agentId) + split.agentShare;
      agentWallet.set(agentId, ab);
      run("INSERT INTO wallet_txns (user_id, order_id, type, amount, balance_after, status, remark, created_at) VALUES (?,?,?,?,?,?,?,?)",
        agentId, oid, "agent_share", split.agentShare, ab, "done", "片区分成", settledAt);
    }
  }
  db.exec("COMMIT");

  // 回写钱包余额（余额与流水末笔保持一致）
  db.exec("BEGIN");
  for (const [uid, bal] of teacherWallet) {
    run("UPDATE wallets SET balance = ?, total_income = ?, updated_at = ? WHERE user_id = ?", bal, bal, nowIso(), uid);
  }
  for (const [uid, bal] of agentWallet) {
    run("UPDATE wallets SET balance = ?, total_income = ?, updated_at = ? WHERE user_id = ?", bal, bal, nowIso(), uid);
  }
  // 担保台账余额列按真实累加值重算
  const rows = all("SELECT id, amount, direction FROM escrow_ledger ORDER BY id");
  let bal = 0;
  for (const r of rows) {
    bal += r.direction === "in" ? r.amount : -r.amount;
    run("UPDATE escrow_ledger SET balance = ? WHERE id = ?", bal, r.id);
  }
  db.exec("COMMIT");
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  console.error("生成失败：" + e.message);
  process.exit(1);
}

const ms = Date.now() - t0;
const stat = {
  users: get("SELECT COUNT(*) AS c FROM users").c,
  teachers: get("SELECT COUNT(*) AS c FROM teacher_profiles").c,
  orders: get("SELECT COUNT(*) AS c FROM orders").c,
  txns: get("SELECT COUNT(*) AS c FROM wallet_txns").c,
  escrowRows: get("SELECT COUNT(*) AS c FROM escrow_ledger").c,
};
const escrow = get("SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END),0) AS b FROM escrow_ledger").b;
console.log("完成，用时 " + (ms / 1000).toFixed(1) + "s");
console.log("  用户 " + stat.users + "（教员档案 " + stat.teachers + "）");
console.log("  订单 " + stat.orders + "，钱包流水 " + stat.txns + " 条，担保台账 " + stat.escrowRows + " 条");
console.log("  担保台账净余额 ¥" + (escrow / 100).toFixed(2) + "（已结算订单净额为 0）");
console.log("\n下一步：node scripts/bench.mjs   然后   node scripts/healthcheck.mjs");