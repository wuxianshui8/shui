// 教员端：入驻认证、接单首页、服务管理、订单、等级权益、收入、排课日历
import { all, get, run } from "../core/db.js";
import { Err, ok } from "../core/http.js";
import { nowIso } from "../core/ids.js";
import { audit } from "../core/audit.js";
import { rule } from "../core/config.js";
import { dispatchPriority, levelByScore, levelInfo, resolveRegion } from "../core/rules.js";
import { haversineKm } from "../core/geo.js";
import { distanceFactor } from "../core/geo.js";
import { orderView, orderViews, reviewsOfTeacher, teacherPrivate } from "../core/present.js";
import { walletSnapshot } from "../core/ledger.js";

function requireApprovedProfile(userId) {
  const tp = get("SELECT * FROM teacher_profiles WHERE user_id = ?", userId);
  if (!tp) throw Err.biz("NOT_APPLIED", "请先提交入驻资料");
  return tp;
}

export function register(router) {
  /* ---------------- 入驻 ---------------- */
  router.post("/api/teacher/apply", (ctx) => {
    const b = ctx.body;
    if (!b.realName || !b.idCard) throw Err.bad("请填写真实姓名与身份证号");
    if (!/^\d{17}[\dXx]$/.test(String(b.idCard))) throw Err.bad("身份证号格式不正确");
    if (!b.subjects || !String(b.subjects).length) throw Err.bad("请选择擅长科目");
    if (!(Number(b.hourlyPrice) > 0)) throw Err.bad("请填写课时单价");
    const exist = get("SELECT * FROM teacher_profiles WHERE user_id = ?", ctx.user.id);
    if (exist && exist.audit_status === "approved") throw Err.biz("ALREADY_APPROVED", "您已通过资质审核");
    if (exist && exist.audit_status === "pending") throw Err.biz("IN_REVIEW", "资料审核中，请耐心等待");

    const lat = b.lat != null ? Number(b.lat) : 30.2741;
    const lng = b.lng != null ? Number(b.lng) : 120.1551;
    const region = resolveRegion(lat, lng);

    if (exist) {
      run(
        `UPDATE teacher_profiles SET identity_type = ?, real_name = ?, id_card = ?, edu_cert_url = ?, teacher_cert_url = ?,
         skill_cert_url = ?, intro = ?, subjects = ?, stages = ?, hourly_price = ?, service_radius_km = ?,
         base_lat = ?, base_lng = ?, schedule = ?, cover_area = ?, audit_status = 'pending', reject_reason = NULL, updated_at = ?
         WHERE user_id = ?`,
        b.identityType || "student", b.realName, b.idCard, b.eduCertUrl || null, b.teacherCertUrl || null,
        b.skillCertUrl || null, b.intro || "", b.subjects, b.stages || "", Math.round(Number(b.hourlyPrice)),
        Number(b.serviceRadiusKm || 5), lat, lng, JSON.stringify(b.schedule || []), b.coverArea || "",
        nowIso(), ctx.user.id
      );
    } else {
      run(
        `INSERT INTO teacher_profiles (user_id, identity_type, real_name, id_card, edu_cert_url, teacher_cert_url,
          skill_cert_url, intro, subjects, stages, hourly_price, service_radius_km, base_lat, base_lng, schedule,
          cover_area, audit_status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ctx.user.id, b.identityType || "student", b.realName, b.idCard, b.eduCertUrl || null, b.teacherCertUrl || null,
        b.skillCertUrl || null, b.intro || "", b.subjects, b.stages || "", Math.round(Number(b.hourlyPrice)),
        Number(b.serviceRadiusKm || 5), lat, lng, JSON.stringify(b.schedule || []), b.coverArea || "",
        "pending", nowIso(), nowIso()
      );
    }
    run("UPDATE users SET role = 'teacher', real_name = ?, id_card = ?, region_id = ? WHERE id = ?",
      b.realName, b.idCard, region?.id ?? null, ctx.user.id);
    run("INSERT OR IGNORE INTO wallets (user_id, updated_at) VALUES (?,?)", ctx.user.id, nowIso());
    audit(ctx, "teacher.apply", "users:" + ctx.user.id);
    ok(ctx.res, { auditStatus: "pending" });
  });

  router.get("/api/teacher/profile", (ctx) => {
    const tp = get("SELECT * FROM teacher_profiles WHERE user_id = ?", ctx.user.id);
    if (!tp) return ok(ctx.res, { applied: false });
    ok(ctx.res, { applied: true, profile: teacherPrivate(ctx.user.id) });
  }, { roles: ["teacher", "parent"] });

  router.put("/api/teacher/profile", (ctx) => {
    const tp = requireApprovedProfile(ctx.user.id);
    const b = ctx.body;
    run(
      `UPDATE teacher_profiles SET intro = ?, subjects = ?, stages = ?, hourly_price = ?, service_radius_km = ?,
       base_lat = ?, base_lng = ?, schedule = ?, cover_area = ?, updated_at = ? WHERE user_id = ?`,
      b.intro ?? tp.intro,
      b.subjects ?? tp.subjects,
      b.stages ?? tp.stages,
      b.hourlyPrice != null ? Math.round(Number(b.hourlyPrice)) : tp.hourly_price,
      b.serviceRadiusKm != null ? Number(b.serviceRadiusKm) : tp.service_radius_km,
      b.lat != null ? Number(b.lat) : tp.base_lat,
      b.lng != null ? Number(b.lng) : tp.base_lng,
      JSON.stringify(b.schedule ?? (tp.schedule ? JSON.parse(tp.schedule) : [])),
      b.coverArea ?? tp.cover_area,
      nowIso(), ctx.user.id
    );
    audit(ctx, "teacher.updateProfile", "users:" + ctx.user.id);
    ok(ctx.res, teacherPrivate(ctx.user.id));
  }, { roles: ["teacher"] });

  router.post("/api/teacher/online", (ctx) => {
    const tp = requireApprovedProfile(ctx.user.id);
    if (tp.audit_status !== "approved") throw Err.biz("NOT_APPROVED", "资质审核通过后才能上线接单");
    const online = ctx.body.online ? 1 : 0;
    run("UPDATE teacher_profiles SET online = ?, updated_at = ? WHERE user_id = ?", online, nowIso(), ctx.user.id);
    audit(ctx, "teacher.online", "users:" + ctx.user.id, { online });
    ok(ctx.res, { online: !!online });
  }, { roles: ["teacher"] });

  /* ---------------- 接单首页 ---------------- */
  router.get("/api/teacher/dashboard", (ctx) => {
    const tp = requireApprovedProfile(ctx.user.id);
    const today = new Date().toISOString().slice(0, 10);
    const todayLessons = get(
      "SELECT COUNT(*) AS c FROM orders WHERE teacher_id = ? AND lesson_time LIKE ? AND status IN ('pending_class','in_class','awaiting_parent_confirm','completed','settled')",
      ctx.user.id, today + "%"
    ).c;
    const todayIncome = get(
      "SELECT COALESCE(SUM(teacher_income),0) AS s FROM orders WHERE teacher_id = ? AND updated_at LIKE ? AND status IN ('completed','settled')",
      ctx.user.id, today + "%"
    ).s;
    // 本周课时（周一起算），对应 UI 说明书 3.1「数据概览卡：本周课时」
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    weekStart.setHours(0, 0, 0, 0);
    const weekLessons = get(
      "SELECT COUNT(*) AS c FROM orders WHERE teacher_id = ? AND lesson_time >= ? AND status IN ('pending_class','in_class','awaiting_parent_confirm','completed','settled')",
      ctx.user.id, weekStart.toISOString()
    ).c;
    const lv = levelInfo(tp.level);
    const next = levelByScore(tp.growth_score + 1);
    const all_levels = rule("teacher_levels");
    const idx = all_levels.findIndex((l) => l.level === tp.level);
    const nextLevel = all_levels[idx + 1] || null;
    ok(ctx.res, {
      online: !!tp.online,
      auditStatus: tp.audit_status,
      overview: {
        todayLessons,
        weekLessons,
        todayIncome,
        ratingAvg: Number(tp.rating_avg.toFixed(2)),
        ratingCount: tp.rating_count,
        level: tp.level,
        levelName: lv.name,
        growthScore: tp.growth_score,
        commission: lv.commission,
        levelWeight: lv.weight,
        completedLessons: tp.completed_lessons,
      },
      nextLevel: nextLevel ? { level: nextLevel.level, name: nextLevel.name, need: Math.max(0, nextLevel.min - tp.growth_score) } : null,
      serviceStatus: {
        subjects: (tp.subjects || "").split(",").filter(Boolean),
        radiusKm: tp.service_radius_km,
        coverArea: tp.cover_area,
        price: tp.hourly_price,
      },
      pendingCount: get("SELECT COUNT(*) AS c FROM orders WHERE teacher_id = ? AND status IN ('awaiting_payment','pending_class','in_class','awaiting_parent_confirm')", ctx.user.id).c,
      wallet: walletSnapshot(ctx.user.id),
      notices: all("SELECT * FROM announcements WHERE status = 'on' AND (audience = 'all' OR audience = 'teacher') ORDER BY pinned DESC, created_at DESC LIMIT 2"),
    });
  }, { roles: ["teacher"] });

  /* ---------------- 我的服务 ---------------- */
  router.get("/api/teacher/services", (ctx) => {
    ok(ctx.res, all("SELECT * FROM teacher_services WHERE teacher_id = ? ORDER BY status = 'on' DESC, id DESC", ctx.user.id));
  }, { roles: ["teacher"] });

  router.post("/api/teacher/services", (ctx) => {
    const b = ctx.body;
    if (!b.title) throw Err.bad("请填写服务标题");
    if (!(Number(b.price) > 0)) throw Err.bad("请填写课时价格");
    const r = run(
      "INSERT INTO teacher_services (teacher_id, title, subjects, stages, price, cover_radius_km, schedule, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ctx.user.id, b.title, b.subjects || "", b.stages || "", Math.round(Number(b.price)),
      Number(b.coverRadiusKm || 5), JSON.stringify(b.schedule || []), b.description || "", "on", nowIso(), nowIso()
    );
    audit(ctx, "teacher.service.create", "services:" + r.id);
    ok(ctx.res, get("SELECT * FROM teacher_services WHERE id = ?", r.id));
  }, { roles: ["teacher"] });

  router.put("/api/teacher/services/:id", (ctx) => {
    const s = get("SELECT * FROM teacher_services WHERE id = ? AND teacher_id = ?", ctx.params.id, ctx.user.id);
    if (!s) throw Err.notFound("服务不存在");
    const b = ctx.body;
    run(
      "UPDATE teacher_services SET title = ?, subjects = ?, stages = ?, price = ?, cover_radius_km = ?, description = ?, status = ?, updated_at = ? WHERE id = ?",
      b.title ?? s.title, b.subjects ?? s.subjects, b.stages ?? s.stages,
      b.price != null ? Math.round(Number(b.price)) : s.price,
      b.coverRadiusKm != null ? Number(b.coverRadiusKm) : s.cover_radius_km,
      b.description ?? s.description, b.status ?? s.status, nowIso(), s.id
    );
    ok(ctx.res, get("SELECT * FROM teacher_services WHERE id = ?", s.id));
  }, { roles: ["teacher"] });

  router.post("/api/teacher/services/:id/toggle", (ctx) => {
    const s = get("SELECT * FROM teacher_services WHERE id = ? AND teacher_id = ?", ctx.params.id, ctx.user.id);
    if (!s) throw Err.notFound("服务不存在");
    const next = s.status === "on" ? "off" : "on";
    run("UPDATE teacher_services SET status = ?, updated_at = ? WHERE id = ?", next, nowIso(), s.id);
    audit(ctx, "teacher.service.toggle", "services:" + s.id, { status: next });
    ok(ctx.res, { status: next });
  }, { roles: ["teacher"] });

  router.del("/api/teacher/services/:id", (ctx) => {
    const s = get("SELECT * FROM teacher_services WHERE id = ? AND teacher_id = ?", ctx.params.id, ctx.user.id);
    if (!s) throw Err.notFound("服务不存在");
    run("DELETE FROM teacher_services WHERE id = ?", s.id);
    ok(ctx.res, { ok: true });
  }, { roles: ["teacher"] });

  /* ---------------- 订单 ---------------- */
  router.get("/api/teacher/orders", (ctx) => {
    const status = ctx.query.status;
    let where = "o.teacher_id = ?";
    const params = [ctx.user.id];
    if (status === "awaiting") { where += " AND o.status = 'awaiting_payment'"; }
    else if (status === "pending") { where += " AND o.status IN ('pending_class','in_class','awaiting_parent_confirm')"; }
    else if (status === "completed") { where += " AND o.status IN ('completed','settled')"; }
    else if (status === "cancelled") { where += " AND o.status IN ('cancelled','refunded','refunding')"; }
    const list = orderViews(all("SELECT o.* FROM orders o WHERE " + where + " ORDER BY o.id DESC", ...params), "teacher");
    ok(ctx.res, { list, total: list.length });
  }, { roles: ["teacher"] });

  /* ---------------- 等级权益 ---------------- */
  router.get("/api/teacher/level", (ctx) => {
    const tp = requireApprovedProfile(ctx.user.id);
    const levels = rule("teacher_levels");
    const idx = levels.findIndex((l) => l.level === tp.level);
    const cur = levels[idx];
    const next = levels[idx + 1] || null;
    ok(ctx.res, {
      level: cur.level,
      levelName: cur.name,
      growthScore: tp.growth_score,
      commission: cur.commission,
      levelWeight: cur.weight,
      nextLevel: next ? { level: next.level, name: next.name, min: next.min, need: Math.max(0, next.min - tp.growth_score) } : null,
      progress: next ? Math.min(100, Math.round(((tp.growth_score - cur.min) / (next.min - cur.min)) * 100)) : 100,
      levels,
      growthRules: rule("growth_rules"),
      logs: all("SELECT * FROM growth_logs WHERE teacher_id = ? ORDER BY id DESC LIMIT 30", ctx.user.id),
      levelLogs: all("SELECT * FROM level_logs WHERE teacher_id = ? ORDER BY id DESC LIMIT 20", ctx.user.id),
      ratingAvg: Number(tp.rating_avg.toFixed(2)),
      ratingCount: tp.rating_count,
      completedLessons: tp.completed_lessons,
    });
  }, { roles: ["teacher"] });

  /* ---------------- 收入 ---------------- */
  router.get("/api/teacher/income", (ctx) => {
    const w = walletSnapshot(ctx.user.id);
    const list = all(
      "SELECT t.*, o.order_no FROM wallet_txns t LEFT JOIN orders o ON o.id = t.order_id WHERE t.user_id = ? ORDER BY t.id DESC LIMIT 100",
      ctx.user.id
    );
    const month = new Date().toISOString().slice(0, 7);
    const monthIncome = get(
      "SELECT COALESCE(SUM(teacher_income),0) AS s FROM orders WHERE teacher_id = ? AND status IN ('completed','settled') AND updated_at LIKE ?",
      ctx.user.id, month + "%"
    ).s;
    const frozenOrders = all(
      "SELECT order_no, teacher_income, settle_at FROM orders WHERE teacher_id = ? AND status = 'completed'",
      ctx.user.id
    );
    ok(ctx.res, {
      wallet: w,
      monthIncome,
      totalServiceFee: get("SELECT COALESCE(SUM(service_fee),0) AS s FROM orders WHERE teacher_id = ? AND status IN ('completed','settled')", ctx.user.id).s,
      frozenOrders,
      txns: list,
      rule: rule("settlement"),
      level: levelInfo(requireApprovedProfile(ctx.user.id).level),
    });
  }, { roles: ["teacher"] });

  /* ---------------- 排课日历 ---------------- */
  router.get("/api/teacher/calendar", (ctx) => {
    const month = ctx.query.month || new Date().toISOString().slice(0, 7);
    const rows = all(
      "SELECT id, order_no, subject, stage, lesson_time, address, status FROM orders WHERE teacher_id = ? AND lesson_time LIKE ? AND status IN ('awaiting_payment','pending_class','in_class','awaiting_parent_confirm','completed','settled') ORDER BY lesson_time",
      ctx.user.id, month + "%"
    );
    const tp = requireApprovedProfile(ctx.user.id);
    ok(ctx.res, { month, lessons: rows, schedule: tp.schedule ? JSON.parse(tp.schedule) : [] });
  }, { roles: ["teacher"] });

  /* ---------------- 评价管理 ---------------- */
  router.get("/api/teacher/reviews", (ctx) => {
    const list = all(
      "SELECT r.*, u.nickname AS parentName, o.order_no FROM reviews r JOIN users u ON u.id = r.parent_id LEFT JOIN orders o ON o.id = r.order_id WHERE r.teacher_id = ? ORDER BY r.id DESC",
      ctx.user.id
    ).map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));
    ok(ctx.res, {
      list,
      ratingAvg: requireApprovedProfile(ctx.user.id).rating_avg,
      ratingCount: requireApprovedProfile(ctx.user.id).rating_count,
      publicReviews: reviewsOfTeacher(ctx.user.id, 10),
    });
  }, { roles: ["teacher"] });

  // 差评申诉
  router.post("/api/teacher/reviews/:id/appeal", (ctx) => {
    const r = get("SELECT * FROM reviews WHERE id = ? AND teacher_id = ?", ctx.params.id, ctx.user.id);
    if (!r) throw Err.notFound("评价不存在");
    if (r.appeal_status !== "none") throw Err.biz("APPEALED", "该评价已提交申诉");
    if (!ctx.body.reason) throw Err.bad("请填写申诉理由");
    run("UPDATE reviews SET appeal_status = 'pending', appeal_reason = ? WHERE id = ?", ctx.body.reason, r.id);
    run(
      "INSERT INTO complaints (order_id, from_user, from_role, against_user, region_id, type, title, content, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      r.order_id, ctx.user.id, "teacher", r.parent_id,
      get("SELECT region_id FROM orders WHERE id = ?", r.order_id)?.region_id ?? null,
      "review_appeal", "差评申诉：评价 #" + r.id, ctx.body.reason, "open", nowIso()
    );
    audit(ctx, "review.appeal", "reviews:" + r.id);
    ok(ctx.res, { ok: true });
  }, { roles: ["teacher"] });

  /* ---------------- 教员个人中心 ---------------- */
  router.get("/api/teacher/profile-page", (ctx) => {
    const tp = requireApprovedProfile(ctx.user.id);
    ok(ctx.res, {
      profile: teacherPrivate(ctx.user.id),
      wallet: walletSnapshot(ctx.user.id),
      stats: {
        orders: get("SELECT COUNT(*) AS c FROM orders WHERE teacher_id = ?", ctx.user.id).c,
        services: get("SELECT COUNT(*) AS c FROM teacher_services WHERE teacher_id = ?", ctx.user.id).c,
        reviews: tp.rating_count,
      },
      auditStatus: tp.audit_status,
      rejectReason: tp.reject_reason,
    });
  }, { roles: ["teacher"] });
}