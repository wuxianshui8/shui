// 家长端市场：首页、教员广场、教员详情、需求发布、抢单报名、家长确认
import { all, get, run, tx } from "../core/db.js";
import { Err, ok } from "../core/http.js";
import { nowIso } from "../core/ids.js";
import { audit, notify } from "../core/audit.js";
import { rule } from "../core/config.js";
import {
  dispatchPriority,
  levelInfo,
  levelWeightOf,
  resolveRegion,
} from "../core/rules.js";
import { haversineKm, maskPhone } from "../core/geo.js";
import { creditInfo, reviewsOfTeacher, teacherCard, userBrief, orderView, orderViews } from "../core/present.js";
import { createOrder } from "./orders.js";
/**
 * 加急费：家长可自填（加价买优先推送），但仍要有护栏。
 * - 规则 urgent.fee = 平台标准价，也是最低价；不传金额就按它（保持老行为）
 * - 规则 urgent.max_fee = 上限（缺省回落到 10 倍标准价），防手滑输成天价
 * - 不开加急一律 0
 */
function urgentFeeOf(urgent, input) {
  if (!urgent) return 0;
  const cfg = rule("urgent") || {};
  const base = Math.max(0, Math.round(Number(cfg.fee) || 0));
  const capCfg = Math.round(Number(cfg.max_fee) || 0);
  const cap = Math.max(base, capCfg > 0 ? capCfg : base * 10);
  if (input === undefined || input === null || input === "") return base;
  const n = Math.round(Number(input));
  if (!Number.isFinite(n) || n <= 0) throw Err.bad("加急费金额不正确");
  if (n < base) throw Err.bad(`加急费不能低于平台标准 ¥${(base / 100).toFixed(2)}`);
  if (n > cap) throw Err.bad(`加急费最高 ¥${(cap / 100).toFixed(2)}`);
  return n;
}


function coords(ctx) {
  const lat = Number(ctx.query.lat ?? ctx.body.lat);
  const lng = Number(ctx.query.lng ?? ctx.body.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  const def = ctx.user
    ? get("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1", ctx.user.id)
    : null;
  if (def) return { lat: def.lat, lng: def.lng };
  return { lat: 30.2741, lng: 120.1551 };
}

function priceFilter(price, q) {
  if (q.priceMin && price < Number(q.priceMin)) return false;
  if (q.priceMax && price > Number(q.priceMax)) return false;
  return true;
}

/**
 * 抢单超时自动失效（需求 5.1：教员接单后家长 grab_confirm_timeout_hours 小时未确认，自动失效）
 * 由服务启动的定时器每分钟调用一次，也可由后台手动触发。
 */
export function expireApplications(now = new Date()) {
  const hours = rule("dispatch").grab_confirm_timeout_hours ?? 24;
  const cutoff = new Date(now.getTime() - hours * 3600000).toISOString();
  const stale = all(
    `SELECT a.id, a.demand_id, a.teacher_id, d.parent_id, d.subject, d.stage
     FROM applications a JOIN demands d ON d.id = a.demand_id
     WHERE a.status = 'pending' AND a.created_at <= ?`,
    cutoff
  );
  let n = 0;
  for (const a of stale) {
    const r = run("UPDATE applications SET status = 'expired' WHERE id = ? AND status = 'pending'", a.id);
    if (!r.changes) continue;
    n++;
    notify(a.parent_id, "教员报名已超时失效",
      "需求「" + a.subject + " · " + a.stage + "」有 1 条教员报名超过 " + hours + " 小时未确认，已自动失效", "order", "/demand/" + a.demand_id);
    notify(a.teacher_id, "报名已超时失效",
      "您对需求「" + a.subject + " · " + a.stage + "」的报名因家长超时未确认而失效", "order");
  }
  return n;
}

/* ---------------- 教员广场 ---------------- */
export function nearbyTeachers(ctx) {
  const { lat, lng } = coords(ctx);
  const q = ctx.query;
  const maxR = Number(q.radiusKm || rule("dispatch").max_radius_km);
  const rows = all(
    `SELECT tp.*, u.nickname, u.avatar, u.phone, u.status FROM teacher_profiles tp
     JOIN users u ON u.id = tp.user_id
     WHERE tp.audit_status = 'approved' AND u.status = 'active'`
  );
  // 批量取当前家长的收藏，避免逐个教员查询（列表长度无关的固定查询数）
  // 游客（ctx.user 为空）也走同一条列表逻辑：收藏集合为空即可，其余字段与家长端一致
  const favoriteSet = new Set(
    all("SELECT teacher_id FROM favorites WHERE user_id = ?", ctx.user?.id ?? 0).map((r) => r.teacher_id)
  );
  const list = [];
  for (const tp of rows) {
    const tLat = tp.base_lat ?? 30.2741;
    const tLng = tp.base_lng ?? 120.1551;
    const distance = Number(haversineKm(lat, lng, tLat, tLng).toFixed(2));
    const radius = Number(q.radiusKm || tp.service_radius_km);
    if (distance > radius) continue;
    if (q.subject && !(tp.subjects || "").includes(q.subject)) continue;
    if (q.stage && !(tp.stages || "").includes(q.stage)) continue;
    if (q.level && tp.level !== q.level) continue;
    if (!priceFilter(tp.hourly_price, q)) continue;
    if (q.online === "1" && !tp.online) continue;
    // 直接用 JOIN 结果组装，不再逐条查库
    const card = teacherCard(tp.user_id, {
      tp,
      user: { id: tp.user_id, nickname: tp.nickname, avatar: tp.avatar, phone: tp.phone, status: tp.status },
    });
    if (!card) continue;
    card.distanceKm = distance;
    card.priority = dispatchPriority({
      distanceKm: distance,
      levelWeight: levelInfo(tp.level).weight,
      responseFactor: tp.response_factor,
      urgent: false,
    });
    card.favorited = favoriteSet.has(tp.user_id);
    list.push(card);
  }
  const sort = q.sort || "priority";
  list.sort((a, b) => {
    if (sort === "price") return a.hourlyPrice - b.hourlyPrice;
    if (sort === "rating") return b.ratingAvg - a.ratingAvg;
    if (sort === "distance") return a.distanceKm - b.distanceKm;
    return b.priority - a.priority;
  });
  const total = list.length;
  const page = Math.max(1, Number(q.page || 1));
  const size = Math.min(50, Number(q.pageSize || 20));
  return { list: list.slice((page - 1) * size, page * size), total, center: { lat, lng } };
}

/* ---------------- 需求发布 ---------------- */
function validateDemand(b) {
  if (!b.stage) throw Err.bad("请选择学段");
  if (!b.subject) throw Err.bad("请选择科目");
  if (!b.address) throw Err.bad("请填写上课地址");
  if (b.lat == null || b.lng == null) throw Err.bad("地址需解析定位坐标");
  if (!(Number(b.budget) > 0)) throw Err.bad("请填写预算金额");
}

export function register(router) {
  router.get("/api/parent/home", (ctx) => {
    const { lat, lng } = coords(ctx);
    const region = resolveRegion(lat, lng);
    const banners = all("SELECT * FROM banners WHERE status = 'on' ORDER BY sort LIMIT 5");
    const notices = all("SELECT * FROM announcements WHERE status = 'on' AND (audience = 'all' OR audience = 'parent') ORDER BY pinned DESC, created_at DESC LIMIT 3");
    const near = nearbyTeachers({ ...ctx, query: { ...ctx.query, lat, lng, pageSize: 6, online: "1" } });
    const defaultAddr = get("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1", ctx.user.id);
    const couponCount = get("SELECT COUNT(*) AS c FROM user_coupons WHERE user_id = ? AND used = 0", ctx.user.id).c;
    const stats = {
      onlineTeachers: near.total,
      ongoingOrders: get("SELECT COUNT(*) AS c FROM orders WHERE parent_id = ? AND status IN ('pending_class','in_class')", ctx.user.id).c,
      unread: get("SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND read = 0", ctx.user.id).c,
    };
    ok(ctx.res, {
      region: region ? { id: region.id, name: region.name } : null,
      location: { lat, lng },
      banners,
      notices,
      teachers: near.list,
      defaultAddress: defaultAddr,
      couponCount,
      stats,
      credit: creditInfo(ctx.user.id),
      compliance: rule("platforms").compliance_notice,
      urgentFee: rule("urgent").fee,
      // 家长可自填加急费的区间（最低 = 平台标准价，最高 = 规则上限）
      urgentMaxFee: Math.max(Number(rule("urgent").fee) || 0, Number(rule("urgent").max_fee) || (Number(rule("urgent").fee) || 0) * 10),
      urgentEnabled: rule("urgent").enabled !== false,
    });
  }, { roles: ["parent"] });

  router.get("/api/parent/teachers", (ctx) => {
    ok(ctx.res, nearbyTeachers(ctx));
  }, { roles: ["parent"] });

  router.get("/api/parent/teachers/:id", (ctx) => {
    const card = teacherCard(ctx.params.id);
    if (!card || card.auditStatus !== "approved") throw Err.notFound("教员不存在");
    const { lat, lng } = coords(ctx);
    card.distanceKm = Number(haversineKm(lat, lng, card.baseLat ?? 30.2741, card.baseLng ?? 120.1551).toFixed(2));
    card.services = all("SELECT * FROM teacher_services WHERE teacher_id = ? AND status = 'on'", ctx.params.id);
    card.reviews = reviewsOfTeacher(ctx.params.id, 20);
    const dist = {};
    for (const r of card.reviews) dist[r.score] = (dist[r.score] || 0) + 1;
    card.scoreDist = dist;
    card.favorited = !!get("SELECT id FROM favorites WHERE user_id = ? AND teacher_id = ?", ctx.user.id, ctx.params.id);
    card.levelTable = rule("teacher_levels");
    ok(ctx.res, card);
  }, { roles: ["parent"] });
  /* ---------------- 游客浏览（需求 4.1：未登录也能看首页与附近教员） ---------------- */
  // 家长端首页对游客开放：只去掉「我的」数据（地址/优惠券/订单/未读/信用），
  // 片区、轮播、公告、附近在线教员、加急费区间都照常下发，登录后同一份前端逻辑无缝切回个人数据。
  router.get("/api/public/home", (ctx) => {
    const { lat, lng } = coords(ctx);
    const region = resolveRegion(lat, lng);
    const near = nearbyTeachers({ ...ctx, query: { ...ctx.query, lat, lng, pageSize: 6, online: "1" } });
    ok(ctx.res, {
      guest: true,
      region: region ? { id: region.id, name: region.name } : null,
      location: { lat, lng },
      banners: all("SELECT * FROM banners WHERE status = 'on' ORDER BY sort LIMIT 5"),
      notices: all("SELECT * FROM announcements WHERE status = 'on' AND (audience = 'all' OR audience = 'parent') ORDER BY pinned DESC, created_at DESC LIMIT 3"),
      teachers: near.list,
      defaultAddress: null,
      couponCount: 0,
      stats: { onlineTeachers: near.total, ongoingOrders: 0, unread: 0 },
      credit: null,
      compliance: rule("platforms").compliance_notice,
      urgentFee: rule("urgent").fee,
      urgentMaxFee: Math.max(Number(rule("urgent").fee) || 0, Number(rule("urgent").max_fee) || (Number(rule("urgent").fee) || 0) * 10),
      urgentEnabled: rule("urgent").enabled !== false,
    });
  }, { auth: false });

  router.get("/api/public/teachers", (ctx) => {
    ok(ctx.res, nearbyTeachers(ctx));
  }, { auth: false });

  // 游客也能看教员详情（手机号仍脱敏、收藏状态恒 false），点「立即预约」时才由前端弹登录
  router.get("/api/public/teachers/:id", (ctx) => {
    const card = teacherCard(ctx.params.id);
    if (!card || card.auditStatus !== "approved") throw Err.notFound("教员不存在");
    const { lat, lng } = coords(ctx);
    card.distanceKm = Number(haversineKm(lat, lng, card.baseLat ?? 30.2741, card.baseLng ?? 120.1551).toFixed(2));
    card.services = all("SELECT * FROM teacher_services WHERE teacher_id = ? AND status = 'on'", ctx.params.id);
    card.reviews = reviewsOfTeacher(ctx.params.id, 20);
    const dist = {};
    for (const r of card.reviews) dist[r.score] = (dist[r.score] || 0) + 1;
    card.scoreDist = dist;
    card.favorited = !!(ctx.user && get("SELECT id FROM favorites WHERE user_id = ? AND teacher_id = ?", ctx.user.id, ctx.params.id));
    card.levelTable = rule("teacher_levels");
    ok(ctx.res, card);
  }, { auth: false });


  /* ---------------- 需求 ---------------- */
  router.post("/api/demands", (ctx) => {
    const b = ctx.body;
    validateDemand(b);
    const pp = get("SELECT * FROM parent_profiles WHERE user_id = ?", ctx.user.id);
    if (b.urgent && pp?.restricted) throw Err.biz("RESTRICTED", "信用分过低，暂不可发布加急需求");
    const region = resolveRegion(Number(b.lat), Number(b.lng));
    if (!region) throw Err.biz("OUT_OF_SERVICE", "该上课地址暂未开通服务片区");

    // 区域归属（需求 5.5）：非扫码注册（无归属记录）的用户，按首次发布订单的上课地址定位归属片区
    const bound = get("SELECT * FROM bindings WHERE user_id = ?", ctx.user.id);
    if (!bound) {
      const regionAgent = get(
        "SELECT user_id FROM agent_profiles WHERE region_id = ? AND status = 'active' ORDER BY user_id LIMIT 1",
        region.id
      );
      run(
        "INSERT OR IGNORE INTO bindings (user_id, sales_id, agent_id, region_id, source, bound_at) VALUES (?,?,?,?,?,?)",
        ctx.user.id, null, regionAgent?.user_id ?? null, region.id, "natural", nowIso()
      );
      run("UPDATE users SET region_id = ? WHERE id = ?", region.id, ctx.user.id);
    }
    const urgentFee = urgentFeeOf(b.urgent, b.urgentFee);
    const r = run(
      `INSERT INTO demands (parent_id, stage, subject, mode, address_id, address, lat, lng, region_id, times, budget,
        remark, gender_pref, urgent, urgent_fee, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ctx.user.id, b.stage, b.subject, "home", b.addressId ?? null, b.address, Number(b.lat), Number(b.lng),
      region.id, JSON.stringify(b.times || []), Math.round(Number(b.budget)), b.remark || "", b.genderPref || "",
      b.urgent ? 1 : 0, urgentFee, "published", nowIso(), nowIso()
    );
    audit(ctx, "demand.create", "demands:" + r.id);
    ok(ctx.res, get("SELECT * FROM demands WHERE id = ?", r.id));
  }, { roles: ["parent"] });

  router.get("/api/demands/mine", (ctx) => {
    const list = all(
      "SELECT d.*, (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status IN ('pending','confirmed')) AS applyCount FROM demands d WHERE d.parent_id = ? ORDER BY d.id DESC",
      ctx.user.id
    ).map((d) => ({ ...d, times: d.times ? JSON.parse(d.times) : [] }));
    ok(ctx.res, list);
  }, { roles: ["parent"] });

  router.get("/api/demands/:id", (ctx) => {
    const d = get("SELECT * FROM demands WHERE id = ?", ctx.params.id);
    if (!d) throw Err.notFound("需求不存在");
    const u = ctx.user;
    let allowed = d.parent_id === u.id || u.role === "admin";
    if (!allowed && u.role === "teacher") {
      // 教员只能看到：自己已报名的需求，或符合自身服务半径与科目的在招需求
      const applied = get("SELECT id FROM applications WHERE demand_id = ? AND teacher_id = ?", d.id, u.id);
      if (applied) {
        allowed = true;
      } else if (d.status === "published") {
        const tp = get("SELECT * FROM teacher_profiles WHERE user_id = ? AND audit_status = 'approved'", u.id);
        if (tp) {
          const dist = haversineKm(tp.base_lat ?? 30.2741, tp.base_lng ?? 120.1551, d.lat, d.lng);
          const inRange = dist <= (tp.service_radius_km || rule("dispatch").max_radius_km);
          const subjectOk = !tp.subjects || tp.subjects.split(",").includes(d.subject);
          allowed = inRange && subjectOk;
        }
      }
    }
    if (!allowed) throw Err.forbidden("无权查看该需求");
    // 报名优先级「读时计算」：按当前规则重算，而不是报名当时的快照（与 NestJS 版一致）
    const apps = all(
      `SELECT a.*, u.nickname, u.avatar FROM applications a JOIN users u ON u.id = a.teacher_id
       WHERE a.demand_id = ? ORDER BY a.status = 'confirmed' DESC, a.priority DESC`,
      d.id
    ).map((a) => {
      const tp = get("SELECT * FROM teacher_profiles WHERE user_id = ?", a.teacher_id);
      const snapshot = Number(a.priority);
      const live = tp
        ? dispatchPriority({
            distanceKm: Number(a.distance_km),
            levelWeight: levelInfo(tp.level).weight,
            responseFactor: tp.response_factor,
            urgent: !!d.urgent,
            urgentFee: Number(d.urgent_fee),
          })
        : snapshot;
      return { ...a, priority: live, prioritySnapshot: snapshot, teacher: teacherCard(a.teacher_id) };
    });
    apps.sort((x, y) => {
      const cx = x.status === "confirmed" ? 1 : 0;
      const cy = y.status === "confirmed" ? 1 : 0;
      return cy - cx || Number(y.priority) - Number(x.priority);
    });
    ok(ctx.res, { ...d, times: d.times ? JSON.parse(d.times) : [], applications: apps });
  });

  router.put("/api/demands/:id", (ctx) => {
    const d = get("SELECT * FROM demands WHERE id = ? AND parent_id = ?", ctx.params.id, ctx.user.id);
    if (!d) throw Err.notFound("需求不存在");
    if (!["published", "paused"].includes(d.status)) throw Err.biz("BAD_STATUS", "该需求已不可编辑");
    const b = ctx.body;
    const nextUrgent = b.urgent != null ? !!b.urgent : !!d.urgent;
    let nextUrgentFee = Number(d.urgent_fee) || 0;
    if (!nextUrgent) nextUrgentFee = 0;
    else if (b.urgentFee != null) nextUrgentFee = urgentFeeOf(true, b.urgentFee);
    else if (!d.urgent) nextUrgentFee = urgentFeeOf(true, undefined);
    run(
      "UPDATE demands SET stage = ?, subject = ?, address = ?, lat = ?, lng = ?, times = ?, budget = ?, remark = ?, urgent = ?, urgent_fee = ?, updated_at = ? WHERE id = ?",
      b.stage ?? d.stage, b.subject ?? d.subject, b.address ?? d.address,
      b.lat != null ? Number(b.lat) : d.lat, b.lng != null ? Number(b.lng) : d.lng,
      JSON.stringify(b.times ?? (d.times ? JSON.parse(d.times) : [])),
      b.budget != null ? Math.round(Number(b.budget)) : d.budget,
      b.remark ?? d.remark, b.urgent != null ? (b.urgent ? 1 : 0) : d.urgent,
      nextUrgentFee,
      nowIso(), d.id
    );
    ok(ctx.res, get("SELECT * FROM demands WHERE id = ?", d.id));
  }, { roles: ["parent"] });

  router.post("/api/demands/:id/action", (ctx) => {
    const d = get("SELECT * FROM demands WHERE id = ? AND parent_id = ?", ctx.params.id, ctx.user.id);
    if (!d) throw Err.notFound("需求不存在");
    const action = ctx.body.action;
    if (!["pause", "resume", "revoke"].includes(action)) throw Err.bad("不支持的操作");
    if (action === "revoke") {
      if (d.status === "matched") throw Err.biz("BAD_STATUS", "已确认教员的需求请走订单取消流程");
      run("UPDATE demands SET status = 'revoked', updated_at = ? WHERE id = ?", nowIso(), d.id);
      run("UPDATE applications SET status = 'cancelled' WHERE demand_id = ? AND status = 'pending'", d.id);
    } else {
      const next = action === "pause" ? "paused" : "published";
      run("UPDATE demands SET status = ?, updated_at = ? WHERE id = ?", next, nowIso(), d.id);
    }
    audit(ctx, "demand." + action, "demands:" + d.id);
    ok(ctx.res, get("SELECT * FROM demands WHERE id = ?", d.id));
  }, { roles: ["parent"] });

  /* ---------------- 教员抢单 ---------------- */
  router.get("/api/teacher/nearby-demands", (ctx) => {
    const tp = get("SELECT * FROM teacher_profiles WHERE user_id = ?", ctx.user.id);
    if (!tp) throw Err.notFound("请先完成入驻");
    if (tp.audit_status !== "approved") throw Err.biz("NOT_APPROVED", "资质审核通过后才能接单");
    // 按当前位置算距离：手机端传 ?lat=&lng=（实时定位），否则回落到入驻服务基点
    const qLat = Number(ctx.query.lat);
    const qLng = Number(ctx.query.lng);
    const hasCurrent = Number.isFinite(qLat) && Number.isFinite(qLng) && Math.abs(qLat) <= 90 && Math.abs(qLng) <= 180 && !(qLat === 0 && qLng === 0);
    const lat = hasCurrent ? qLat : (tp.base_lat ?? 30.2741);
    const lng = hasCurrent ? qLng : (tp.base_lng ?? 120.1551);
    const originSource = hasCurrent ? "current" : "profile";
    const cfg = rule("dispatch");
    const rows = all("SELECT * FROM demands WHERE status = 'published'");
    const list = [];
    for (const d of rows) {
      const distance = Number(haversineKm(lat, lng, d.lat, d.lng).toFixed(2));
      if (distance > (tp.service_radius_km || cfg.max_radius_km)) continue;
      if (tp.subjects && !tp.subjects.split(",").includes(d.subject)) continue;
      const applied = get("SELECT status FROM applications WHERE demand_id = ? AND teacher_id = ?", d.id, ctx.user.id);
      list.push({
        id: d.id,
        stage: d.stage,
        subject: d.subject,
        address: d.address,
        lessonTimes: d.times ? JSON.parse(d.times) : [],
        budget: d.budget,
        remark: d.remark,
        urgent: !!d.urgent,
        urgentFee: d.urgent_fee,
        distanceKm: distance,
        priority: dispatchPriority({
          distanceKm: distance,
          levelWeight: levelInfo(tp.level).weight,
          responseFactor: tp.response_factor,
          urgent: !!d.urgent,
          urgentFee: Number(d.urgent_fee),
        }),
        appliedStatus: applied?.status || null,
        createdAt: d.created_at,
      });
    }
    list.sort((a, b) => b.priority - a.priority);
    ok(ctx.res, {
      list, total: list.length, online: !!tp.online,
      origin: { lat, lng, source: originSource },
      radiusKm: tp.service_radius_km || cfg.max_radius_km,
    });
  }, { roles: ["teacher"] });

  router.post("/api/demands/:id/apply", (ctx) => {
    const tp = get("SELECT * FROM teacher_profiles WHERE user_id = ?", ctx.user.id);
    if (!tp) throw Err.notFound("请先完成入驻");
    if (tp.audit_status !== "approved") throw Err.biz("NOT_APPROVED", "资质审核通过后才能接单");
    if (!tp.online) throw Err.biz("OFFLINE", "请先切换到在线接单状态");
    const d = get("SELECT * FROM demands WHERE id = ?", ctx.params.id);
    if (!d) throw Err.notFound("需求不存在");
    if (d.status !== "published") throw Err.biz("BAD_STATUS", "该需求已停止接单");

    // 抢单同样支持当前位置：body 里带 lat/lng 就用实时定位算距离
    const bLat = Number(ctx.body?.lat);
    const bLng = Number(ctx.body?.lng);
    const curOk = Number.isFinite(bLat) && Number.isFinite(bLng) && Math.abs(bLat) <= 90 && Math.abs(bLng) <= 180 && !(bLat === 0 && bLng === 0);
    const fromLat = curOk ? bLat : (tp.base_lat ?? 30.2741);
    const fromLng = curOk ? bLng : (tp.base_lng ?? 120.1551);
    const distance = Number(haversineKm(fromLat, fromLng, d.lat, d.lng).toFixed(2));
    if (distance > (tp.service_radius_km || rule("dispatch").max_radius_km)) {
      throw Err.biz("TOO_FAR", "该需求距离超出您的服务半径");
    }
    const priority = dispatchPriority({
      distanceKm: distance,
      levelWeight: levelInfo(tp.level).weight,
      responseFactor: tp.response_factor,
      urgent: !!d.urgent,
      urgentFee: Number(d.urgent_fee),
    });

    return tx(() => {
      // 原子抢单：唯一索引 + 条件插入，保证无重复接单
      const r = run(
        "INSERT OR IGNORE INTO applications (demand_id, teacher_id, status, priority, distance_km, created_at) VALUES (?,?,?,?,?,?)",
        d.id, ctx.user.id, "pending", priority, distance, nowIso()
      );
      if (r.changes === 0) throw Err.biz("ALREADY_APPLIED", "您已报名该需求，请等待家长确认");
      notify(d.parent_id, "有教员报名", "需求「" + d.subject + " · " + d.stage + "」收到新的教员报名", "order", "/demand/" + d.id);
      audit(ctx, "demand.apply", "demands:" + d.id, { priority, distance });
      return ok(ctx.res, { applicationId: r.id, priority, distanceKm: distance, status: "pending" });
    });
  }, { roles: ["teacher"] });

  /* ---------------- 家长确认教员 → 生成订单 ---------------- */
  router.post("/api/demands/:id/confirm", (ctx) => {
    const d = get("SELECT * FROM demands WHERE id = ?", ctx.params.id);
    if (!d) throw Err.notFound("需求不存在");
    if (d.parent_id !== ctx.user.id) throw Err.forbidden();
    const appId = Number(ctx.body.applicationId);
    const app = get("SELECT * FROM applications WHERE id = ? AND demand_id = ?", appId, d.id);
    if (!app) throw Err.notFound("报名记录不存在");
    if (app.status !== "pending") {
      if (d.status === "matched") throw Err.conflict("该需求已被确认，请勿重复操作");
      throw Err.biz("BAD_STATUS", "该教员报名状态已变更");
    }

    return tx(() => {
      // 原子占位：只有一次确认能成功（并发安全）
      const claim = run(
        "UPDATE demands SET status = 'matched', confirm_app_id = ?, updated_at = ? WHERE id = ? AND status = 'published'",
        app.id, nowIso(), d.id
      );
      if (claim.changes === 0) throw Err.conflict("该需求已被确认或已关闭");
      run("UPDATE applications SET status = 'confirmed' WHERE id = ?", app.id);
      run("UPDATE applications SET status = 'rejected' WHERE demand_id = ? AND id <> ? AND status = 'pending'", d.id, app.id);

      const times = d.times ? JSON.parse(d.times) : [];
      const first = times[0] || {};
      const lessonTime = first.date ? new Date(first.date + "T" + (first.start || "09:00") + ":00").toISOString() : new Date(Date.now() + 86400000).toISOString();

      const order = createOrder({
        parentId: ctx.user.id,
        teacherId: app.teacher_id,
        demandId: d.id,
        subject: d.subject,
        stage: d.stage,
        lessonTime,
        lessonEnd: first.end || null,
        address: d.address,
        lat: d.lat,
        lng: d.lng,
        regionId: d.region_id,
        amount: d.budget,
        urgentFee: d.urgent_fee,
        remark: d.remark || "",
      });
      audit(ctx, "demand.confirm", "demands:" + d.id, { applicationId: app.id, orderId: order.id });
      return ok(ctx.res, orderView(order, "parent"));
    });
  }, { roles: ["parent"] });

  /* ---------------- 直接选购教员服务下单 ---------------- */
  router.post("/api/orders/from-service", (ctx) => {
    const b = ctx.body;
    const svc = get("SELECT * FROM teacher_services WHERE id = ? AND status = 'on'", b.serviceId);
    if (!svc) throw Err.notFound("服务不存在或已下架");
    const tp = get("SELECT * FROM teacher_profiles WHERE user_id = ? AND audit_status = 'approved'", svc.teacher_id);
    if (!tp) throw Err.biz("BAD_STATUS", "该教员暂不可接单");
    if (!b.lessonTime) throw Err.bad("请选择上课时间");

    const addr = b.addressId
      ? get("SELECT * FROM addresses WHERE id = ? AND user_id = ?", b.addressId, ctx.user.id)
      : get("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1", ctx.user.id);
    if (!addr) throw Err.bad("请先添加上课地址");
    const region = resolveRegion(addr.lat, addr.lng);
    if (!region) throw Err.biz("OUT_OF_SERVICE", "该地址暂未开通服务片区");

    // 时间冲突校验：教员同时段不可重复接单
    const conflict = get(
      "SELECT id FROM orders WHERE teacher_id = ? AND lesson_time = ? AND status IN ('pending_class','in_class','awaiting_parent_confirm','completed')",
      svc.teacher_id, b.lessonTime
    );
    if (conflict) throw Err.biz("TIME_CONFLICT", "该教员此时段已有课程，请另选时间");

    const order = createOrder({
      parentId: ctx.user.id,
      teacherId: svc.teacher_id,
      serviceId: svc.id,
      subject: (svc.subjects || "").split(",")[0] || "其他",
      stage: (svc.stages || "").split(",")[0] || "小学",
      lessonTime: b.lessonTime,
      lessonEnd: b.lessonEnd || null,
      address: addr.address,
      lat: addr.lat,
      lng: addr.lng,
      regionId: region.id,
      amount: svc.price,
      urgentFee: 0,
      remark: b.remark || "",
      couponId: b.couponId || null,
    });
    audit(ctx, "order.fromService", "orders:" + order.id, { serviceId: svc.id });
    ok(ctx.res, orderView(order, "parent"));
  }, { roles: ["parent"] });

  /* ---------------- 家长订单列表 ---------------- */
  router.get("/api/parent/orders", (ctx) => {
    const status = ctx.query.status;
    const groups = {
      awaiting: "('awaiting_payment')",
      pending: "('pending_class','in_class','awaiting_parent_confirm')",
      completed: "('completed','settled')",
      cancelled: "('cancelled','refunding','refunded')",
    };
    let where = "o.parent_id = ?";
    const params = [ctx.user.id];
    if (status && groups[status]) where += " AND o.status IN " + groups[status];
    else if (status) {
      where += " AND o.status = ?";
      params.push(status);
    }
    const list = orderViews(all("SELECT o.* FROM orders o WHERE " + where + " ORDER BY o.id DESC", ...params), "parent");
    ok(ctx.res, { list, total: list.length });
  }, { roles: ["parent"] });

  router.get("/api/parent/profile", (ctx) => {
    const u = userBrief(ctx.user.id);
    const pp = get("SELECT * FROM parent_profiles WHERE user_id = ?", ctx.user.id);
    ok(ctx.res, {
      user: { ...u, phone: maskPhone(u.phone), realName: ctx.user.real_name },
      credit: creditInfo(ctx.user.id),
      creditRules: rule("credit_rules"),
      creditLevels: rule("parent_credit"),
      stats: {
        orders: get("SELECT COUNT(*) AS c FROM orders WHERE parent_id = ?", ctx.user.id).c,
        favorites: get("SELECT COUNT(*) AS c FROM favorites WHERE user_id = ?", ctx.user.id).c,
        addresses: get("SELECT COUNT(*) AS c FROM addresses WHERE user_id = ?", ctx.user.id).c,
      },
      creditLogs: all("SELECT * FROM credit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 30", ctx.user.id),
      restricted: !!pp.restricted,
    });
  }, { roles: ["parent"] });

  // 家长头像：先 POST /api/upload 落盘拿 /uploads/xxx，再提交到这里；avatar=null 恢复首字母头像
  router.put("/api/parent/avatar", (ctx) => {
    const raw = ctx.body.avatar == null ? "" : String(ctx.body.avatar).trim();
    let next = null;
    if (raw) {
      if (!/^\/uploads\/[A-Za-z0-9._-]{1,120}$/.test(raw)) {
        throw Err.bad("头像地址不合法：请先上传图片，只接受本站 /uploads/ 下的地址");
      }
      next = raw;
    }
    run("UPDATE users SET avatar = ? WHERE id = ?", next, ctx.user.id);
    const u = get("SELECT * FROM users WHERE id = ?", ctx.user.id);
    ok(ctx.res, {
      user: { id: u.id, nickname: u.nickname, avatar: u.avatar, role: u.role, phone: maskPhone(u.phone) },
      hasAvatar: !!u.avatar,
    });
  }, { roles: ["parent"] });
}