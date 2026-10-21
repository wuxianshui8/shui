// 视图组装 + 按角色脱敏
import { all, get } from "./db.js";
import { maskAddress, maskIdCard, maskPhone } from "./geo.js";
import { creditLevels, teacherLevels } from "./rules.js";

export function userBrief(id) {
  const u = get("SELECT id, nickname, avatar, phone, role, status FROM users WHERE id = ?", id);
  if (!u) return null;
  return { id: u.id, nickname: u.nickname, avatar: u.avatar, phone: u.phone, role: u.role, status: u.status };
}

export function teacherCard(userId, { revealPhone = false, tp: preTp = null, user: preUser = null } = {}) {
  const tp = preTp || get("SELECT * FROM teacher_profiles WHERE user_id = ?", userId);
  const u = preUser || get("SELECT id, nickname, avatar, phone, status FROM users WHERE id = ?", userId);
  if (!tp || !u) return null;
  const lv = teacherLevels().find((l) => l.level === tp.level) || teacherLevels()[0];
  return {
    id: u.id,
    nickname: u.nickname,
    avatar: u.avatar,
    phone: revealPhone ? u.phone : maskPhone(u.phone),
    identityType: tp.identity_type,
    subjects: (tp.subjects || "").split(",").filter(Boolean),
    stages: (tp.stages || "").split(",").filter(Boolean),
    hourlyPrice: tp.hourly_price,
    serviceRadiusKm: tp.service_radius_km,
    coverArea: tp.cover_area,
    intro: tp.intro,
    level: tp.level,
    levelName: lv.name,
    levelWeight: lv.weight,
    commission: lv.commission,
    growthScore: tp.growth_score,
    ratingAvg: Number(tp.rating_avg.toFixed(2)),
    ratingCount: tp.rating_count,
    completedLessons: tp.completed_lessons,
    responseFactor: tp.response_factor,
    online: !!tp.online,
    auditStatus: tp.audit_status,
    baseLat: tp.base_lat,
    baseLng: tp.base_lng,
    status: u.status,
  };
}

export function teacherPrivate(userId) {
  const tp = get("SELECT * FROM teacher_profiles WHERE user_id = ?", userId);
  if (!tp) return null;
  return {
    ...teacherCard(userId, { revealPhone: true }),
    realName: tp.real_name,
    idCard: maskIdCard(tp.id_card),
    eduCertUrl: tp.edu_cert_url,
    teacherCertUrl: tp.teacher_cert_url,
    skillCertUrl: tp.skill_cert_url,
    schedule: tp.schedule ? JSON.parse(tp.schedule) : [],
    rejectReason: tp.reject_reason,
    responseFactor: tp.response_factor,
    createdAt: tp.created_at,
  };
}

export function creditInfo(parentId) {
  const pp = get("SELECT * FROM parent_profiles WHERE user_id = ?", parentId);
  if (!pp) return null;
  const lv = creditLevels().find((l) => l.level === pp.credit_level) || creditLevels()[0];
  return {
    creditScore: pp.credit_score,
    creditLevel: pp.credit_level,
    creditLevelName: lv.name,
    reviewWeight: lv.weight,
    completedOrders: pp.completed_orders,
    cancelCount: pp.cancel_count,
    restricted: !!pp.restricted,
    nextLevel: creditLevels().find((l) => l.min > pp.credit_score) || null,
  };
}

/**
 * 单笔订单视图（详情页用）。
 * 列表场景请用 orderViews()，它批量预取关联数据以避免 N+1 查询。
 */
export function orderView(o, viewerRole = "parent", opts = {}) {
  if (!o) return null;
  const parent = userBrief(o.parent_id);
  const teacher = teacherCard(o.teacher_id);
  return composeOrderView(o, viewerRole, {
    parent,
    teacher,
    credit: parent ? creditInfo(parent.id) : null,
    hasReview: !!get("SELECT id FROM reviews WHERE order_id = ?", o.id),
  }, opts);
}

/**
 * 批量订单视图：一次性预取用户 / 教员档案 / 家长信用 / 评价存在性，
 * 把每单约 6 次查询压缩为固定的 4 次查询（与列表长度无关）。
 */
export function orderViews(list, viewerRole = "parent", opts = {}) {
  if (!list || !list.length) return [];
  const orderIds = list.map((o) => o.id);
  const userIds = [...new Set([...list.map((o) => o.parent_id), ...list.map((o) => o.teacher_id)])];
  const ph = (arr) => arr.map(() => "?").join(",");

  const userRows = all(
    `SELECT id, nickname, avatar, phone, role, status FROM users WHERE id IN (${ph(userIds)})`,
    ...userIds
  );
  const userMap = new Map(userRows.map((u) => [u.id, u]));

  const tpRows = all(`SELECT * FROM teacher_profiles WHERE user_id IN (${ph(userIds)})`, ...userIds);
  const tpMap = new Map(tpRows.map((t) => [t.user_id, t]));

  const ppRows = all(`SELECT * FROM parent_profiles WHERE user_id IN (${ph(userIds)})`, ...userIds);
  const ppMap = new Map(ppRows.map((p) => [p.user_id, p]));

  const reviewRows = all(`SELECT order_id FROM reviews WHERE order_id IN (${ph(orderIds)})`, ...orderIds);
  const reviewed = new Set(reviewRows.map((r) => r.order_id));

  return list.map((o) => {
    const u = userMap.get(o.parent_id);
    const tu = userMap.get(o.teacher_id);
    const tp = tpMap.get(o.teacher_id);
    const pp = ppMap.get(o.parent_id);
    const creditLv = pp ? creditLevels().find((l) => l.level === pp.credit_level) || creditLevels()[0] : null;
    return composeOrderView(
      o,
      viewerRole,
      {
        parent: u ? { id: u.id, nickname: u.nickname, avatar: u.avatar, phone: u.phone, role: u.role, status: u.status } : null,
        teacher: tp && tu ? { tp, user: tu } : null,
        credit: pp && creditLv
          ? {
              creditScore: pp.credit_score,
              creditLevel: pp.credit_level,
              creditLevelName: creditLv.name,
              reviewWeight: creditLv.weight,
              completedOrders: pp.completed_orders,
              cancelCount: pp.cancel_count,
              restricted: !!pp.restricted,
              nextLevel: creditLevels().find((l) => l.min > pp.credit_score) || null,
            }
          : null,
        hasReview: reviewed.has(o.id),
      },
      opts
    );
  });
}

/** 组装订单视图（字段顺序与含义对单条/批量保持一致） */
function composeOrderView(o, viewerRole, parts, { mask = false } = {}) {
  const { parent, teacher, credit, hasReview } = parts;
  const teacherLevel = teacher ? (teacher.level ?? teacher.tp?.level ?? "Lv1") : "Lv1";
  const lv = teacherLevels().find((l) => l.level === teacherLevel);
  const teacherInfo = teacher
    ? {
        id: teacher.tp ? teacher.user.id : teacher.id,
        nickname: teacher.tp ? teacher.user.nickname : teacher.nickname,
        avatar: teacher.tp ? teacher.user.avatar : teacher.avatar,
        phone: mask
          ? maskPhone(teacher.tp ? teacher.user.phone : teacher.phone)
          : (teacher.tp ? teacher.user.phone : teacher.phone),
        level: teacherLevel,
        levelName: lv?.name,
        ratingAvg: teacher.tp ? Number(teacher.tp.rating_avg.toFixed(2)) : teacher.ratingAvg,
        ratingCount: teacher.tp ? teacher.tp.rating_count : teacher.ratingCount,
        subjects: teacher.tp ? (teacher.tp.subjects || "").split(",").filter(Boolean) : teacher.subjects,
        identityType: teacher.tp ? teacher.tp.identity_type : teacher.identityType,
      }
    : null;
  return {
    id: o.id,
    orderNo: o.order_no,
    subject: o.subject,
    stage: o.stage,
    lessonTime: o.lesson_time,
    lessonEnd: o.lesson_end,
    address: mask ? maskAddress(o.address) : o.address,
    lat: o.lat,
    lng: o.lng,
    amount: o.amount,
    urgentFee: o.urgent_fee,
    status: o.status,
    statusText: orderStatusText(o.status, viewerRole),
    commissionRate: o.commission_rate,
    serviceFee: o.service_fee,
    teacherIncome: o.teacher_income,
    agentShare: o.agent_share,
    salesCommission: o.sales_commission,
    platformRevenue: o.platform_revenue,
    regionId: o.region_id,
    salesId: o.sales_id,
    agentId: o.agent_id,
    paidAt: o.paid_at,
    checkinAt: o.checkin_at,
    checkinDistance: o.checkin_distance,
    finishedAt: o.finished_at,
    confirmAt: o.confirm_at,
    settleAt: o.settle_at,
    cancelBy: o.cancel_by,
    cancelReason: o.cancel_reason,
    penalty: o.penalty,
    refundAmount: o.refund_amount,
    remark: o.remark,
    createdAt: o.created_at,
    freeCancelDeadline: o.lesson_time
      ? new Date(new Date(o.lesson_time).getTime() - 4 * 3600000).toISOString()
      : null,
    parent: parent
      ? { id: parent.id, nickname: parent.nickname, phone: mask ? maskPhone(parent.phone) : parent.phone, credit }
      : null,
    teacher: teacherInfo,
    hasReview,
  };
}

export function orderStatusText(status, role = "parent") {
  const parentMap = {
    awaiting_payment: "待付款",
    pending_class: "待上课",
    in_class: "进行中",
    awaiting_parent_confirm: "待确认完成",
    completed: "已完成",
    settled: "已完成",
    cancelled: "已取消",
    refunding: "退款中",
    refunded: "已退款",
  };
  const teacherMap = {
    awaiting_payment: "待确认",
    pending_class: "待上门",
    in_class: "上课中",
    awaiting_parent_confirm: "待家长确认",
    completed: "已完成",
    settled: "已完成",
    cancelled: "已取消",
    refunding: "退款中",
    refunded: "已退款",
  };
  const map = role === "teacher" ? teacherMap : parentMap;
  return map[status] || status;
}

export function reviewsOfTeacher(teacherId, limit = 20) {
  return all(
    "SELECT r.*, u.nickname AS parentName, u.avatar AS parentAvatar FROM reviews r JOIN users u ON u.id = r.parent_id WHERE r.teacher_id = ? AND r.status = 'public' ORDER BY r.created_at DESC LIMIT ?",
    teacherId,
    limit
  ).map((r) => ({
    id: r.id,
    score: r.score,
    content: r.content,
    tags: r.tags ? JSON.parse(r.tags) : [],
    weight: r.weight,
    parentName: r.parentName,
    parentAvatar: r.parentAvatar,
    createdAt: r.created_at,
    appealStatus: r.appeal_status,
  }));
}