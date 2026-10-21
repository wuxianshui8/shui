// ============================================================
// 订单生命周期：下单 → 支付 → 打卡上课 → 结束授课 → 家长确认 → 冻结 → 结算
// 同时承载：取消/退款、评价、风控校验、分账
// ============================================================
import { all, get, run, tx } from "../core/db.js";
import { Err, ok } from "../core/http.js";
import { nowIso, orderNo, tradeNo, addDaysIso } from "../core/ids.js";
import { audit, notify } from "../core/audit.js";
import { rule } from "../core/config.js";
import {
  agentRates,
  applyCredit,
  applyGrowth,
  applyViolation,
  calcSplit,
  cancelPenalty,
  commissionRateOf,
  creditWeightOf,
  isFreeCancelWindow,
  salesTierRate,
} from "../core/rules.js";
import { haversineKm } from "../core/geo.js";
import {
  escrowBalance,
  escrowMove,
  walletFreezeIncoming,
  walletSettle,
  walletUnfreezeIncoming,
  walletAdd,
  walletSnapshot,
} from "../core/ledger.js";
import { orderView, orderStatusText } from "../core/present.js";

/* ---------- 创建订单 ---------- */
export function createOrder({ parentId, teacherId, demandId = null, serviceId = null, subject, stage, lessonTime, lessonEnd = null, address, lat, lng, regionId, amount, urgentFee = 0, remark = "", couponId = null }) {
  const sales = get("SELECT sales_id, agent_id, region_id FROM bindings WHERE user_id = ?", parentId);
  const teacherSales = get("SELECT sales_id, agent_id, region_id FROM bindings WHERE user_id = ?", teacherId);
  const region = regionId || get("SELECT id FROM regions ORDER BY id LIMIT 1").id;
  const finalRegion = demandId
    ? get("SELECT region_id FROM demands WHERE id = ?", demandId)?.region_id ?? region
    : region;
  // 收益归属（需求 5.5）：优先取订单所在片区（即需求发布地址片区）的代理，
  // 跨区订单的收益归需求地址所在片区，而非家长或教员的归属片区。
  const regionAgent = get(
    "SELECT user_id FROM agent_profiles WHERE region_id = ? AND status = 'active' ORDER BY user_id LIMIT 1",
    finalRegion
  );
  const agentId = regionAgent?.user_id ?? sales?.agent_id ?? teacherSales?.agent_id ?? null;

  let finalAmount = amount;
  let couponNote = "";
  if (couponId) {
    const uc = get(
      "SELECT uc.id, uc.used, c.amount, c.threshold, c.name FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE uc.id = ? AND uc.user_id = ?",
      couponId,
      parentId
    );
    if (!uc) throw Err.bad("优惠券不可用");
    if (uc.used) throw Err.bad("优惠券已使用");
    if (amount < uc.threshold) throw Err.bad("未达到优惠券使用门槛");
    finalAmount = Math.max(0, amount - uc.amount);
    couponNote = "使用优惠券「" + uc.name + "」立减 ¥" + (uc.amount / 100).toFixed(2);
    run("UPDATE user_coupons SET used = 1 WHERE id = ?", uc.id);
  }

  // 反作弊：同一家长 24 小时内高频下单 → 标记刷单风险并冻结结算，等待人工复核
  const riskCfg = rule("risk");
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const recentOrders = get("SELECT COUNT(*) AS c FROM orders WHERE parent_id = ? AND created_at >= ?", parentId, dayAgo).c;
  const needReview = recentOrders >= (riskCfg.order_per_parent_day ?? 10);

  return tx(() => {
    const r = run(
      `INSERT INTO orders (order_no, parent_id, teacher_id, demand_id, service_id, subject, stage, lesson_time, lesson_end,
        address, lat, lng, region_id, sales_id, agent_id, amount, urgent_fee, status, commission_rate, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      orderNo(), parentId, teacherId, demandId, serviceId, subject, stage, lessonTime, lessonEnd,
      address, lat, lng, finalRegion, sales?.sales_id ?? null, agentId, finalAmount, urgentFee,
      "awaiting_payment", commissionRateOf(teacherId), couponNote || remark, nowIso(), nowIso()
    );
    if (couponId) run("UPDATE user_coupons SET order_id = ? WHERE id = ?", r.id, couponId);
    if (needReview) {
      run(
        "INSERT INTO risk_events (order_id, user_id, region_id, type, level, reason, status, settlement_hold, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        r.id, parentId, finalRegion, "brush", recentOrders >= (riskCfg.order_per_parent_day ?? 10) * 2 ? "high" : "mid",
        "同一家长 24 小时内下单 " + (recentOrders + 1) + " 笔，超过阈值 " + (riskCfg.order_per_parent_day ?? 10) + " 笔，疑似刷单",
        "open", 1, nowIso()
      );
    }
    const order = get("SELECT * FROM orders WHERE id = ?", r.id);
    notify(teacherId, "收到新订单", "家长已确认您接单，订单 " + order.order_no + " 待家长支付", "order", "/order/" + order.id);
    return order;
  });
}

/* ---------- 支付（担保交易）---------- */
export function payOrder(ctx, orderId) {
  const order = get("SELECT * FROM orders WHERE id = ?", orderId);
  if (!order) throw Err.notFound("订单不存在");
  if (order.parent_id !== ctx.user.id) throw Err.forbidden();
  if (order.status !== "awaiting_payment") {
    if (order.status === "pending_class" || order.status === "in_class" || order.status === "completed") {
      return order; // 幂等：已支付直接返回
    }
    throw Err.biz("BAD_STATUS", "当前订单状态不可支付：" + orderStatusText(order.status));
  }

  return tx(() => {
    const amount = order.amount + order.urgent_fee;
    const r = run(
      "INSERT INTO payments (order_id, user_id, type, amount, channel, trade_no, status, idem_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      order.id,
      ctx.user.id,
      "pay",
      amount,
      ctx.body.channel || "wechat_jsapi",
      tradeNo("WX"),
      "success",
      ctx.req.headers["x-idem-key"] || null,
      nowIso()
    );
    escrowMove(order.id, "in", amount, "家长预付课时费 " + order.order_no);

    const ar = agentRates(order.agent_id);
    const split = calcSplit({
      amount: order.amount,
      commissionRate: order.commission_rate,
      feeShareRate: ar.feeShareRate,
      mgmtRate: ar.mgmtRate,
      salesRate: order.sales_id ? salesTierRate(order.amount) : 0,
    });

    run(
      `UPDATE orders SET status = 'pending_class', paid_at = ?, service_fee = ?, teacher_income = ?, agent_share = ?,
        sales_commission = ?, platform_revenue = ?, updated_at = ? WHERE id = ?`,
      nowIso(), split.serviceFee, split.teacherIncome, split.agentShare, split.salesCommission,
      split.platformRevenue, nowIso(), order.id
    );

    // 业务员成交提成（pending，周结）
    if (order.sales_id && split.salesCommission > 0) {
      run(
        "INSERT INTO rewards (sales_id, type, amount, ref_order_id, status, calc_note, created_at) VALUES (?,?,?,?,?,?,?)",
        order.sales_id, "deal", split.salesCommission, order.id, "pending",
        "订单 " + order.order_no + " 成交提成 " + (salesTierRate(order.amount) * 100).toFixed(1) + "% × ¥" + (order.amount / 100).toFixed(2),
        nowIso()
      );
    }

    notify(order.teacher_id, "订单已支付", "订单 " + order.order_no + " 家长已完成担保支付，请按时上门", "payment", "/order/" + order.id);
    audit(ctx, "order.pay", "orders:" + order.id, { amount, tradeNo: r.id });
    return get("SELECT * FROM orders WHERE id = ?", order.id);
  });
}

/* ---------- 教员上门打卡 ---------- */
export function checkin(ctx, orderId, lat, lng) {
  const order = get("SELECT * FROM orders WHERE id = ?", orderId);
  if (!order) throw Err.notFound("订单不存在");
  if (order.teacher_id !== ctx.user.id) throw Err.forbidden();
  if (order.status !== "pending_class") throw Err.biz("BAD_STATUS", "当前状态不可打卡（" + orderStatusText(order.status, "teacher") + "）");
  if (lat == null || lng == null) throw Err.bad("请开启定位后再打卡");

  const threshold = rule("checkin").max_distance_m ?? 500;
  const distance = Math.round(haversineKm(Number(lat), Number(lng), order.lat, order.lng) * 1000);
  if (distance > threshold) {
    run(
      "INSERT INTO risk_events (order_id, user_id, region_id, type, level, reason, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
      order.id, ctx.user.id, order.region_id, "abnormal_location", distance > threshold * 3 ? "high" : "mid",
      "打卡定位距离 " + distance + " 米，超出阈值 " + threshold + " 米", "open", nowIso()
    );
    throw Err.biz("CHECKIN_TOO_FAR", "当前位置距离上课地点 " + distance + " 米，超出 " + threshold + " 米阈值，无法打卡");
  }

  run(
    "UPDATE orders SET status = 'in_class', checkin_at = ?, checkin_lat = ?, checkin_lng = ?, checkin_distance = ?, updated_at = ? WHERE id = ?",
    nowIso(), Number(lat), Number(lng), distance, nowIso(), order.id
  );
  notify(order.parent_id, "教员已到达", "教员已在距上课地点 " + distance + " 米处打卡，课程开始", "order", "/order/" + order.id);
  audit(ctx, "order.checkin", "orders:" + order.id, { distance });
  return get("SELECT * FROM orders WHERE id = ?", order.id);
}

/* ---------- 教员结束授课 ---------- */
export function finish(ctx, orderId) {
  const order = get("SELECT * FROM orders WHERE id = ?", orderId);
  if (!order) throw Err.notFound("订单不存在");
  if (order.teacher_id !== ctx.user.id) throw Err.forbidden();
  if (order.status !== "in_class") throw Err.biz("BAD_STATUS", "尚未开始上课，无法结束授课");
  run("UPDATE orders SET status = 'awaiting_parent_confirm', finished_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), order.id);
  notify(order.parent_id, "待确认完成", "教员已结束授课，请确认完成以结算课时费", "order", "/order/" + order.id);
  audit(ctx, "order.finish", "orders:" + order.id);
  return get("SELECT * FROM orders WHERE id = ?", order.id);
}

/* ---------- 家长确认完成 → 进入冻结期 ---------- */
export function confirmComplete(ctx, orderId) {
  const order = get("SELECT * FROM orders WHERE id = ?", orderId);
  if (!order) throw Err.notFound("订单不存在");
  if (order.parent_id !== ctx.user.id) throw Err.forbidden();
  if (!["awaiting_parent_confirm", "in_class"].includes(order.status)) {
    throw Err.biz("BAD_STATUS", "当前状态不可确认完成");
  }
  const freezeDays = rule("settlement").freeze_days ?? 7;

  return tx(() => {
    const settleAt = addDaysIso(nowIso(), freezeDays);
    run(
      "UPDATE orders SET status = 'completed', confirm_at = ?, settle_at = ?, updated_at = ? WHERE id = ?",
      nowIso(), settleAt, nowIso(), order.id
    );
    walletFreezeIncoming(order.teacher_id, order.teacher_income, {
      orderId: order.id,
      type: "freeze",
      remark: "课时费待结算（" + freezeDays + " 天冻结）",
    });
    run("UPDATE teacher_profiles SET completed_lessons = completed_lessons + 1, updated_at = ? WHERE user_id = ?", nowIso(), order.teacher_id);
    applyGrowth(order.teacher_id, rule("growth_rules").per_lesson ?? 2, "完成有效课时", order.id);
    applyCredit(order.parent_id, rule("credit_rules").order_completed ?? 3, "完成订单", order.id);
    run("UPDATE parent_profiles SET completed_orders = completed_orders + 1 WHERE user_id = ?", order.parent_id);

    notify(order.teacher_id, "家长已确认完成", "课时费 ¥" + ((order.teacher_income) / 100).toFixed(2) + " 将于 " + freezeDays + " 天后结算到账", "payment", "/order/" + order.id);
    notify(order.parent_id, "评价提醒", "请在 72 小时内评价本次家教服务", "order", "/review/" + order.id);
    audit(ctx, "order.confirmComplete", "orders:" + order.id);
    return get("SELECT * FROM orders WHERE id = ?", order.id);
  });
}

/* ---------- 结算（T+N 解冻分账）---------- */
export function runSettlement(now = new Date(), force = false) {
  const due = force
    ? all("SELECT * FROM orders WHERE status = 'completed'")
    : all("SELECT * FROM orders WHERE status = 'completed' AND settle_at IS NOT NULL AND settle_at <= ?", now.toISOString());
  let count = 0;
  for (const order of due) {
    const hold = get(
      "SELECT id FROM risk_events WHERE order_id = ? AND settlement_hold = 1 AND status <> 'closed'",
      order.id
    );
    if (hold) continue;

    tx(() => {
      escrowMove(order.id, "out", order.amount + order.urgent_fee, "订单结算放款 " + order.order_no);
      walletSettle(order.teacher_id, order.teacher_income, {
        orderId: order.id,
        type: "lesson_income",
        remark: "订单 " + order.order_no + " 课时费结算（已扣平台服务费 ¥" + (order.service_fee / 100).toFixed(2) + "）",
      });
      if (order.agent_id && order.agent_share > 0) {
        walletAdd(order.agent_id, order.agent_share, {
          orderId: order.id,
          type: "agent_share",
          remark: "片区分成 ¥" + (order.agent_share / 100).toFixed(2) + "（订单 " + order.order_no + "）",
        });
      }
      run("UPDATE orders SET status = 'settled', updated_at = ? WHERE id = ?", nowIso(), order.id);
      notify(order.teacher_id, "课时费已到账", "订单 " + order.order_no + " 课时费 ¥" + (order.teacher_income / 100).toFixed(2) + " 已结算至余额", "payment", "/wallet");
      count++;
    });
  }
  return count;
}

/* ---------- 上课前提醒（需求 4.1.5：上课前 1 小时推送提醒）---------- */
export function runLessonReminders(now = new Date()) {
  const cfg = rule("notify") || {};
  if (cfg.enabled === false) return 0;
  const minutes = cfg.lesson_remind_minutes ?? 60;
  const horizon = new Date(now.getTime() + minutes * 60000).toISOString();
  const due = all(
    `SELECT * FROM orders
     WHERE status = 'pending_class' AND remind_sent = 0
       AND lesson_time > ? AND lesson_time <= ?`,
    now.toISOString(), horizon
  );
  let n = 0;
  for (const o of due) {
    const r = run("UPDATE orders SET remind_sent = 1 WHERE id = ? AND remind_sent = 0", o.id);
    if (!r.changes) continue;
    n++;
    const when = new Date(o.lesson_time).toLocaleString("zh-CN", { hour12: false });
    notify(o.parent_id, "上课提醒",
      "您预约的课程将在 " + minutes + " 分钟后开始（" + o.subject + " · " + o.stage + "，" + when + "），地址：" + o.address,
      "order", "/order/" + o.id);
    notify(o.teacher_id, "上课提醒",
      "您有一节课将在 " + minutes + " 分钟后开始（" + o.subject + " · " + o.stage + "，" + when + "），请提前出发并在到达后完成定位打卡",
      "order", "/order/" + o.id);
  }
  return n;
}

/* ---------- 取消 / 退款 ---------- */
export function cancelOrder(ctx, orderId, reason = "") {
  const order = get("SELECT * FROM orders WHERE id = ?", orderId);
  if (!order) throw Err.notFound("订单不存在");
  const isParent = order.parent_id === ctx.user.id;
  const isTeacher = order.teacher_id === ctx.user.id;
  if (!isParent && !isTeacher && ctx.user.role !== "admin") throw Err.forbidden();
  if (["completed", "settled", "cancelled", "refunded"].includes(order.status)) {
    throw Err.biz("BAD_STATUS", "当前订单状态不可取消");
  }

  return tx(() => {
    let refund = 0;
    let penalty = 0;

    if (order.status === "awaiting_payment") {
      run("UPDATE orders SET status = 'cancelled', cancel_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ?",
        ctx.user.role, reason, nowIso(), order.id);
    } else {
      const paid = order.amount + order.urgent_fee;
      if (isParent) {
        const inWindow = isFreeCancelWindow(order.lesson_time);
        if (order.status === "in_class") throw Err.biz("BAD_STATUS", "课程进行中，请通过客服发起纠纷处理");
        if (inWindow) {
          refund = paid;
          applyCredit(order.parent_id, rule("credit_rules").monthly_no_cancel ? 0 : 0, "取消订单");
        } else {
          penalty = cancelPenalty(paid);
          refund = paid - penalty;
          applyCredit(order.parent_id, rule("credit_rules").cancel_within_4h ?? -8, "课前 4 小时内取消订单", order.id);
          run("UPDATE parent_profiles SET cancel_count = cancel_count + 1 WHERE user_id = ?", order.parent_id);
        }
      } else if (isTeacher) {
        refund = paid;
        applyViolation(order.teacher_id, order.status === "pending_class" ? "no_show" : "no_show", order.id, "教员取消已确认订单");
      } else {
        refund = paid;
      }

      escrowMove(order.id, "out", refund, "订单退款 " + order.order_no);
      if (penalty > 0) {
        walletAdd(order.teacher_id, penalty, {
          orderId: order.id,
          type: "compensation",
          remark: "家长临时取消违约金补偿（订单 " + order.order_no + "）",
        });
      }
      run(
        "INSERT INTO payments (order_id, user_id, type, amount, channel, trade_no, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
        order.id, order.parent_id, "refund", refund, "wechat_jsapi", tradeNo("RF"), "success", nowIso()
      );
      run(
        "UPDATE orders SET status = 'refunded', cancel_by = ?, cancel_reason = ?, penalty = ?, refund_amount = ?, updated_at = ? WHERE id = ?",
        ctx.user.role, reason, penalty, refund, nowIso(), order.id
      );
      if (penalty > 0) {
        applyCredit(order.parent_id, 0, "违约金扣除 ¥" + (penalty / 100).toFixed(2), order.id);
      }
    }

    notify(
      isParent ? order.teacher_id : order.parent_id,
      "订单已取消",
      "订单 " + order.order_no + " 已取消" + (refund > 0 ? "，退款 ¥" + (refund / 100).toFixed(2) : "") + (reason ? "。原因：" + reason : ""),
      "order", "/order/" + order.id
    );
    audit(ctx, "order.cancel", "orders:" + order.id, { refund, penalty, reason });
    return get("SELECT * FROM orders WHERE id = ?", order.id);
  });
}

export function applyRefund(ctx, orderId, reason) {
  const order = get("SELECT * FROM orders WHERE id = ?", orderId);
  if (!order) throw Err.notFound("订单不存在");
  if (order.parent_id !== ctx.user.id) throw Err.forbidden();
  if (!["pending_class", "awaiting_parent_confirm"].includes(order.status)) {
    throw Err.biz("BAD_STATUS", "当前状态不支持申请退款");
  }
  if (!reason) throw Err.bad("请填写退款原因");
  run("UPDATE orders SET status = 'refunding', cancel_reason = ?, updated_at = ? WHERE id = ?", reason, nowIso(), order.id);
  run(
    "INSERT INTO complaints (order_id, from_user, from_role, against_user, region_id, type, title, content, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    order.id, ctx.user.id, "parent", order.teacher_id, order.region_id, "complaint",
    "退款申请：订单 " + order.order_no, reason, "open", nowIso()
  );
  audit(ctx, "order.refundApply", "orders:" + order.id, { reason });
  return get("SELECT * FROM orders WHERE id = ?", order.id);
}

/* ---------- 紧急求助（需求第 8 章 上门安全）---------- */
export function raiseSos(ctx, orderId, { lat = null, lng = null, note = "" } = {}) {
  const order = get("SELECT * FROM orders WHERE id = ?", orderId);
  if (!order) throw Err.notFound("订单不存在");
  const u = ctx.user;
  const isParent = order.parent_id === u.id;
  const isTeacher = order.teacher_id === u.id;
  if (!isParent && !isTeacher) throw Err.forbidden("仅订单双方可发起紧急求助");
  if (["cancelled", "refunded"].includes(order.status)) throw Err.biz("BAD_STATUS", "该订单已结束，如需帮助请通过客服工单");

  // 同一订单 10 分钟内不重复建单，避免误触刷屏
  const recent = get(
    "SELECT id, created_at FROM risk_events WHERE order_id = ? AND type = 'sos' ORDER BY id DESC LIMIT 1",
    order.id
  );
  if (recent && Date.now() - new Date(recent.created_at).getTime() < 10 * 60000) {
    return { sosId: recent.id, duplicated: true, notified: 0 };
  }

  const distance =
    lat != null && lng != null
      ? Math.round(haversineKm(Number(lat), Number(lng), order.lat, order.lng) * 1000)
      : null;
  const where = lat != null ? "（求助定位距上课地址 " + distance + " 米）" : "";
  const reason =
    (isParent ? "家长" : "教员") + "在订单 " + order.order_no + " 发起紧急求助" + where + (note ? "：" + note : "");

  return tx(() => {
    const r = run(
      `INSERT INTO risk_events (order_id, user_id, region_id, type, level, reason, status, settlement_hold, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      order.id, u.id, order.region_id, "sos", "high", reason, "open", 0, nowIso()
    );

    // 通知全体管理员 + 所属片区代理 + 订单另一方
    let notified = 0;
    for (const a of all("SELECT id FROM users WHERE role = 'admin'")) {
      notify(a.id, "🚨 紧急求助", reason + "。请立即联系当事人核实处置。", "risk", "/admin#/risk");
      notified++;
    }
    if (order.agent_id) {
      notify(order.agent_id, "🚨 片区紧急求助", reason + "。请立即联系当事人核实处置。", "risk", "/agent#/risk");
      notified++;
    }
    const counterpart = isParent ? order.teacher_id : order.parent_id;
    notify(counterpart, "订单内已发起紧急求助",
      "该订单已提交紧急求助，平台客服将尽快介入。如为误触可忽略。", "risk", "/order/" + order.id);
    notified++;

    audit(ctx, "order.sos", "orders:" + order.id, { role: u.role, distance, note });
    return { sosId: r.id, duplicated: false, notified, distance, level: "high" };
  });
}

/* ---------- 评价 ---------- */
export function submitReview(ctx, orderId, { score, content = "", tags = [] }) {
  const order = get("SELECT * FROM orders WHERE id = ?", orderId);
  if (!order) throw Err.notFound("订单不存在");
  if (order.parent_id !== ctx.user.id) throw Err.forbidden();
  if (!["completed", "settled"].includes(order.status)) throw Err.biz("BAD_STATUS", "订单完成后才可评价");
  const existing = get("SELECT id FROM reviews WHERE order_id = ?", order.id);
  if (existing) throw Err.biz("ALREADY_REVIEWED", "该订单已评价");
  const s = Number(score);
  if (!(s >= 1 && s <= 5)) throw Err.bad("评分需为 1-5 星");

  const cfg = rule("review_scoring");
  const windowHours = cfg.window_hours ?? 72;
  const base = order.finished_at || order.confirm_at || order.updated_at;
  if (base && Date.now() - new Date(base).getTime() > windowHours * 3600000) {
    throw Err.biz("REVIEW_EXPIRED", "评价时效已过（" + windowHours + " 小时）");
  }

  const weight = creditWeightOf(order.parent_id);
  return tx(() => {
    const r = run(
      "INSERT INTO reviews (order_id, parent_id, teacher_id, score, content, tags, weight, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      order.id, order.parent_id, order.teacher_id, s, content, JSON.stringify(tags || []), weight, "public", nowIso()
    );

    // 教员成长分：好评 +base×权重，差评 -base×权重
    let delta = 0;
    if (s >= (cfg.good_threshold ?? 4)) delta = Math.round((cfg.good_base ?? 5) * weight);
    else if (s <= (cfg.bad_threshold ?? 2)) delta = -Math.round((cfg.bad_base ?? 5) * weight);
    if (delta !== 0) applyGrowth(order.teacher_id, delta, (delta > 0 ? "收到" + s + "星好评" : "收到" + s + "星差评") + "（家长权重 " + weight + "）", order.id);

    // 重新计算评分均值（按评价权重加权）
    const rows = all("SELECT score, weight FROM reviews WHERE teacher_id = ? AND status = 'public'", order.teacher_id);
    const totalW = rows.reduce((a, b) => a + b.weight, 0) || 1;
    const avg = rows.reduce((a, b) => a + b.score * b.weight, 0) / totalW;
    run("UPDATE teacher_profiles SET rating_avg = ?, rating_count = ?, updated_at = ? WHERE user_id = ?",
      Number(avg.toFixed(2)), rows.length, nowIso(), order.teacher_id);

    applyCredit(order.parent_id, rule("credit_rules").review_given ?? 2, "主动评价", order.id);
    notify(order.teacher_id, "收到新评价", s + " 星评价：" + (content || "无文字内容"), "order", "/teacher/reviews");
    audit(ctx, "review.create", "reviews:" + r.id, { score: s, weight });
    return get("SELECT * FROM reviews WHERE id = ?", r.id);
  });
}

/* ---------- 路由 ---------- */
export function register(router) {
  router.get("/api/orders/:id", (ctx) => {
    const order = get("SELECT * FROM orders WHERE id = ?", ctx.params.id);
    if (!order) throw Err.notFound("订单不存在");
    const u = ctx.user;
    // 数据范围：本人订单 / 管理员全量 / 代理限本片区 / 业务员限本人推广的客户
    let allowed = order.parent_id === u.id || order.teacher_id === u.id || u.role === "admin";
    if (!allowed && u.role === "agent") {
      const ap = get("SELECT region_id FROM agent_profiles WHERE user_id = ?", u.id);
      allowed = !!ap && ap.region_id === order.region_id;
    }
    if (!allowed && u.role === "sales") {
      const bound = get("SELECT id FROM bindings WHERE user_id = ? AND sales_id = ?", order.parent_id, u.id);
      allowed = !!bound || order.sales_id === u.id;
    }
    if (!allowed) throw Err.forbidden("无权查看该订单");
    const view = orderView(order, u.role === "teacher" ? "teacher" : "parent", {
      mask: u.role === "agent" || u.role === "sales",
    });
    view.refundRecords = all("SELECT * FROM payments WHERE order_id = ? AND type = 'refund'", order.id);
    view.payments = all("SELECT * FROM payments WHERE order_id = ? ORDER BY id", order.id);
    ok(ctx.res, view);
  });

  router.post("/api/orders/:id/pay", (ctx) => {
    const order = payOrder(ctx, ctx.params.id);
    ok(ctx.res, orderView(order, "parent"));
  }, { idem: true });

  router.post("/api/orders/:id/checkin", (ctx) => {
    const order = checkin(ctx, ctx.params.id, ctx.body.lat, ctx.body.lng);
    ok(ctx.res, orderView(order, "teacher"));
  });

  router.post("/api/orders/:id/finish", (ctx) => {
    const order = finish(ctx, ctx.params.id);
    ok(ctx.res, orderView(order, "teacher"));
  });

  router.post("/api/orders/:id/confirm", (ctx) => {
    const order = confirmComplete(ctx, ctx.params.id);
    ok(ctx.res, orderView(order, "parent"));
  });

  router.post("/api/orders/:id/cancel", (ctx) => {
    const order = cancelOrder(ctx, ctx.params.id, ctx.body.reason || "");
    ok(ctx.res, orderView(order, ctx.user.role === "teacher" ? "teacher" : "parent"));
  });

  router.post("/api/orders/:id/refund", (ctx) => {
    const order = applyRefund(ctx, ctx.params.id, ctx.body.reason);
    ok(ctx.res, orderView(order, "parent"));
  });

  // 紧急求助（家长 / 教员均可发起）
  router.post("/api/orders/:id/sos", (ctx) => {
    const r = raiseSos(ctx, ctx.params.id, ctx.body || {});
    ok(ctx.res, {
      ...r,
      message: r.duplicated
        ? "该订单已有进行中的求助工单，平台正在处理，无需重复提交"
        : "求助已提交，平台客服与片区负责人将立即介入",
    });
  });

  router.post("/api/orders/:id/review", (ctx) => {
    const review = submitReview(ctx, ctx.params.id, ctx.body);
    ok(ctx.res, review);
  });

  // 手动触发上课提醒（需求 4.1.5）
  router.post("/api/admin/reminders/run", (ctx) => {
    if (ctx.user.role !== "admin") throw Err.forbidden();
    const n = runLessonReminders();
    audit(ctx, "reminder.run", null, { count: n });
    ok(ctx.res, { reminded: n, remindMinutes: rule("notify").lesson_remind_minutes });
  });

  // 演示用：手动触发结算批处理
  router.post("/api/admin/settlement/run", (ctx) => {
    if (ctx.user.role !== "admin") throw Err.forbidden();
    const n = runSettlement(new Date(), !!ctx.body.force);
    audit(ctx, "settlement.run", null, { count: n });
    ok(ctx.res, { settled: n, escrowBalance: escrowBalance() });
  });
}