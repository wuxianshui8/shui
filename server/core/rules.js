// ============================================================
// 核心业务规则引擎（第 5 章）—— 所有数值来自规则配置中心
// 金额一律为「分」的整数，禁止浮点参与最终入账
// ============================================================
import { all, get, run } from "./db.js";
import { rule } from "./config.js";
import { distanceFactor, haversineKm, pointInPolygon } from "./geo.js";
import { applyRate } from "./money.js";
import { nowIso } from "./ids.js";

/* ---------- 5.2 教员等级 ---------- */
export function teacherLevels() {
  return rule("teacher_levels") || [];
}

export function levelByScore(score) {
  const levels = teacherLevels();
  for (const lv of levels) {
    if (score >= lv.min && score <= lv.max) return lv;
  }
  return levels[levels.length - 1];
}

export function levelInfo(levelKey) {
  return teacherLevels().find((l) => l.level === levelKey) || teacherLevels()[0];
}

export function commissionRateOf(teacherId) {
  const tp = get("SELECT level FROM teacher_profiles WHERE user_id = ?", teacherId);
  return levelInfo(tp?.level || "Lv1").commission;
}

export function levelWeightOf(teacherId) {
  const tp = get("SELECT level FROM teacher_profiles WHERE user_id = ?", teacherId);
  return levelInfo(tp?.level || "Lv1").weight;
}

/** 成长分变更 + 自动升降级 */
export function applyGrowth(teacherId, delta, reason, orderId = null) {
  if (!delta) return null;
  const tp = get("SELECT growth_score, level FROM teacher_profiles WHERE user_id = ?", teacherId);
  if (!tp) return null;
  const before = tp.growth_score;
  const after = Math.max(0, before + Math.round(delta));
  run(
    "UPDATE teacher_profiles SET growth_score = ?, updated_at = ? WHERE user_id = ?",
    after,
    nowIso(),
    teacherId
  );
  run(
    "INSERT INTO growth_logs (teacher_id, change, reason, balance_after, order_id, created_at) VALUES (?,?,?,?,?,?)",
    teacherId,
    Math.round(delta),
    reason,
    after,
    orderId,
    nowIso()
  );
  const target = levelByScore(after);
  if (target.level !== tp.level) {
    run("UPDATE teacher_profiles SET level = ? WHERE user_id = ?", target.level, teacherId);
    run(
      "INSERT INTO level_logs (teacher_id, from_level, to_level, reason, created_at) VALUES (?,?,?,?,?)",
      teacherId,
      tp.level,
      target.level,
      after > before ? "成长分达标升级" : "成长分低于等级下限自动降级",
      nowIso()
    );
  }
  return { before, after, level: target.level, changed: target.level !== tp.level };
}

/** 违规扣分 */
export function applyViolation(teacherId, type, orderId = null, extraNote = "") {
  const g = rule("growth_rules");
  const delta = g.violation[type] ?? 0;
  if (!delta) return null;
  const labelMap = {
    no_show: "爽约未上门",
    fake_checkin: "虚假打卡",
    private_deal: "引导私单",
  };
  const res = applyGrowth(teacherId, delta, (labelMap[type] || type) + "扣分" + (extraNote ? "：" + extraNote : ""), orderId);
  if (type === "private_deal" && g.private_deal_ban) {
    run("UPDATE users SET status = 'disabled' WHERE id = ?", teacherId);
  }
  return res;
}

/* ---------- 5.3 家长信用等级 ---------- */
export function creditLevels() {
  return rule("parent_credit") || [];
}

export function creditByScore(score) {
  const levels = creditLevels();
  for (const lv of levels) {
    if (score >= lv.min && score <= lv.max) return lv;
  }
  return levels[0];
}

export function creditWeightOf(parentId) {
  const pp = get("SELECT credit_level FROM parent_profiles WHERE user_id = ?", parentId);
  const lv = creditLevels().find((l) => l.level === (pp?.credit_level || "L0"));
  return lv ? lv.weight : 0.6;
}

export function applyCredit(parentId, delta, reason, orderId = null) {
  if (!delta) return null;
  const pp = get("SELECT credit_score FROM parent_profiles WHERE user_id = ?", parentId);
  if (!pp) return null;
  const before = pp.credit_score;
  const after = Math.max(0, before + Math.round(delta));
  const lv = creditByScore(after);
  const restrict = rule("credit_rules").restrict_below ?? 0;
  run(
    "UPDATE parent_profiles SET credit_score = ?, credit_level = ?, restricted = ? WHERE user_id = ?",
    after,
    lv.level,
    after <= restrict ? 1 : 0,
    parentId
  );
  run(
    "INSERT INTO credit_logs (user_id, change, reason, balance_after, order_id, created_at) VALUES (?,?,?,?,?,?)",
    parentId,
    Math.round(delta),
    reason,
    after,
    orderId,
    nowIso()
  );
  return { before, after, level: lv.level, weight: lv.weight };
}

/* ---------- 5.1 派单匹配 ---------- */
export function resolveRegion(lat, lng) {
  const regions = all("SELECT * FROM regions");
  for (const r of regions) {
    if (r.polygon) {
      try {
        if (pointInPolygon(lat, lng, JSON.parse(r.polygon))) return r;
      } catch {
        /* ignore */
      }
    }
  }
  let best = null;
  let bestD = Infinity;
  for (const r of regions) {
    const d = haversineKm(lat, lng, r.center_lat, r.center_lng);
    if (d <= r.radius_km && d < bestD) {
      best = r;
      bestD = d;
    }
  }
  return best;
}

/**
 * 加急放大系数：家长自填的加急费越高，派单优先级越高。
 * 标准价（urgent.fee）取 dispatch.urgent_boost，上限价（urgent.max_fee）取 dispatch.urgent_boost_max，
 * 中间线性插值；没有金额或老库缺 urgent_boost_max 时回落到基准系数（与改造前一致）。
 */
export function urgentBoostOf(cfg, urgentFee) {
  const base = Number(cfg?.urgent_boost) > 0 ? Number(cfg.urgent_boost) : 1;
  const fee = Number(urgentFee);
  if (!(fee > 0)) return base;
  const u = rule("urgent") || {};
  const min = Math.max(0, Number(u.fee) || 0);
  const capCfg = Number(u.max_fee) || 0;
  const cap = Math.max(min, capCfg > 0 ? capCfg : min * 10);
  const maxBoost = Number(cfg?.urgent_boost_max);
  if (!(maxBoost > base) || cap <= min) return base;
  const ratio = Math.min(1, Math.max(0, (fee - min) / (cap - min)));
  return Number((base + (maxBoost - base) * ratio).toFixed(4));
}

/** 推送优先级 = 距离系数 × 教员等级权重 × 响应速度系数 × 加急放大系数 */
export function dispatchPriority({ distanceKm, levelWeight, responseFactor, urgent, urgentFee }) {
  const cfg = rule("dispatch");
  const df = distanceFactor(distanceKm, cfg.max_radius_km, cfg.distance_factor_min);
  let p = df * levelWeight * (responseFactor || 1);
  if (urgent) p *= urgentBoostOf(cfg, urgentFee);
  return Number(p.toFixed(4));
}

/* ---------- 5.4 分佣与结算 ---------- */
export function salesTierRate(amount) {
  const cfg = rule("sales_rewards");
  const tiers = cfg.deal_tiers || [];
  for (const t of tiers) {
    const max = t.max == null ? Infinity : t.max;
    if (amount >= t.min && amount <= max) return t.rate;
  }
  return tiers.length ? tiers[tiers.length - 1].rate : 0;
}

export function agentRates(agentId) {
  const cfg = rule("agent_commission");
  const ap = agentId ? get("SELECT commission_rate, mgmt_rate FROM agent_profiles WHERE user_id = ?", agentId) : null;
  return {
    feeShareRate: ap?.commission_rate ?? cfg.fee_share_rate,
    mgmtRate: ap?.mgmt_rate ?? cfg.mgmt_rate,
  };
}

/**
 * 订单分账计算
 * 平台服务费 = 实付 × 教员等级抽佣比例
 * 教员实收   = 实付 - 平台服务费
 * 代理收益   = 服务费 × 服务费分成比例 + 实付 × 管理提成比例
 * 业务员提成 = 实付 × 阶梯提成比例（独立于代理分成）
 * 平台净收入 = 服务费 - 代理收益 - 业务员提成
 */
export function calcSplit({ amount, commissionRate, feeShareRate = 0, mgmtRate = 0, salesRate = 0 }) {
  const serviceFee = applyRate(amount, commissionRate);
  const teacherIncome = amount - serviceFee;
  const agentShare = applyRate(serviceFee, feeShareRate) + applyRate(amount, mgmtRate);
  const salesCommission = applyRate(amount, salesRate);
  const platformRevenue = Math.max(0, serviceFee - agentShare - salesCommission);
  return { serviceFee, teacherIncome, agentShare, salesCommission, platformRevenue };
}

/** 免费取消截止时间 = 上课时间 - free_cancel_hours */
export function freeCancelDeadline(lessonTime) {
  const h = rule("settlement").free_cancel_hours ?? 4;
  return new Date(new Date(lessonTime).getTime() - h * 3600000).toISOString();
}

export function isFreeCancelWindow(lessonTime, at = new Date()) {
  return at.getTime() <= new Date(freeCancelDeadline(lessonTime)).getTime();
}

export function cancelPenalty(amount) {
  return applyRate(amount, rule("settlement").cancel_penalty_rate ?? 0.2);
}