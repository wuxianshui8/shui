// 平台管理后台（PC）：数据总览、用户、订单、规则配置中心、区域代理、财务、风控、运营、系统
import { all, get, run, tx } from "../core/db.js";
import { Err, ok } from "../core/http.js";
import { nowIso, tradeNo } from "../core/ids.js";
import { audit, notify } from "../core/audit.js";
import { listRules, rule, setRule, invalidate } from "../core/config.js";
import { maskAddress, maskIdCard, maskPhone } from "../core/geo.js";
import { escrowBalance, escrowMove, walletAdd } from "../core/ledger.js";
import { orderView, orderViews } from "../core/present.js";
import { applyGrowth, levelByScore, teacherLevels } from "../core/rules.js";
import { hashPassword } from "../core/auth.js";
import { expireApplications } from "./market.js";
import { paging, pagedResult } from "../core/paging.js";
import { DEMO_PASSWORD } from "../core/defaults.js";
import { adminAreasStatus, areasByCodes, fenceFromCodes, searchAreas } from "../core/admin-areas.js";

/** 把 admin_codes 解析成行政区名，列表页显示「按行政区：张北县」 */
function decorateRegion(r) {
  let codes = [];
  try {
    codes = r.admin_codes ? JSON.parse(r.admin_codes) : [];
  } catch {
    codes = [];
  }
  if (!Array.isArray(codes) || !codes.length) return { adminCodes: [], adminNames: [] };
  return { adminCodes: codes, adminNames: areasByCodes(codes).map((a) => a.name) };
}

function adminOnly(ctx) {
  if (ctx.user.role !== "admin") throw Err.forbidden();
}

export function register(router) {
  /* ---------------- 数据总览 ---------------- */
  router.get("/api/admin/overview", (ctx) => {
    adminOnly(ctx);
    const today = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);
    const totalUsers = get("SELECT COUNT(*) AS c FROM users").c;
    const dau = get("SELECT COUNT(*) AS c FROM users WHERE last_login_at LIKE ?", today + "%").c;
    const todayOrders = get("SELECT COUNT(*) AS c FROM orders WHERE created_at LIKE ?", today + "%").c;
    const monthGmv = get("SELECT COALESCE(SUM(amount),0) AS s FROM orders WHERE paid_at LIKE ?", month + "%").s;
    const revenue = get("SELECT COALESCE(SUM(platform_revenue),0) AS s FROM orders WHERE status IN ('completed','settled')").s;
    const serviceFee = get("SELECT COALESCE(SUM(service_fee),0) AS s FROM orders WHERE status IN ('completed','settled')").s;
    const totalGmv = get("SELECT COALESCE(SUM(amount),0) AS s FROM orders WHERE paid_at IS NOT NULL").s;

    const roleCount = all("SELECT role, COUNT(*) AS c FROM users GROUP BY role");
    const regionRank = all(
      `SELECT r.id, r.name, COUNT(o.id) AS orders, COALESCE(SUM(o.amount),0) AS gmv
       FROM regions r LEFT JOIN orders o ON o.region_id = r.id AND o.paid_at IS NOT NULL
       GROUP BY r.id ORDER BY gmv DESC`
    );
    const supplyDemand = all(
      `SELECT r.name,
        (SELECT COUNT(*) FROM teacher_profiles tp JOIN users u ON u.id = tp.user_id WHERE u.region_id = r.id AND tp.audit_status = 'approved') AS teachers,
        (SELECT COUNT(*) FROM demands d WHERE d.region_id = r.id AND d.status = 'published') AS demands
       FROM regions r`
    );
    // 14 天趋势：一次性 GROUP BY，避免 14 次循环查询
    const since14 = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
    const trendRows = all(
      "SELECT substr(paid_at,1,10) AS d, COUNT(*) AS c, COALESCE(SUM(amount),0) AS gmv FROM orders WHERE paid_at >= ? GROUP BY d",
      since14
    );
    const trendMap = new Map(trendRows.map((r) => [r.d, r]));
    const trend = [];
    for (let i = 13; i >= 0; i--) {
      const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const row = trendMap.get(key);
      trend.push({ date: key, orders: row ? row.c : 0, gmv: row ? row.gmv : 0 });
    }
    ok(ctx.res, {
      metrics: { totalUsers, dau, todayOrders, monthGmv, revenue, serviceFee, totalGmv, escrow: escrowBalance() },
      roleCount,
      regionRank,
      supplyDemand,
      trend,
      pending: {
        teacherAudits: get("SELECT COUNT(*) AS c FROM teacher_profiles WHERE audit_status = 'pending'").c,
        withdrawals: get("SELECT COUNT(*) AS c FROM withdrawals WHERE status = 'pending'").c,
        refunds: get("SELECT COUNT(*) AS c FROM orders WHERE status = 'refunding'").c,
        appeals: get("SELECT COUNT(*) AS c FROM reviews WHERE appeal_status = 'pending'").c,
        risks: get("SELECT COUNT(*) AS c FROM risk_events WHERE status <> 'closed'").c,
        complaints: get("SELECT COUNT(*) AS c FROM complaints WHERE status <> 'closed'").c,
      },
    });
  });

  /* ---------------- 用户管理 ---------------- */
  router.get("/api/admin/users", (ctx) => {
    adminOnly(ctx);
    let where = " WHERE 1=1";
    const params = [];
    // 默认不列「已删除（软删除/匿名化）」的账号
    if (ctx.query.includeDeleted !== "1") where += " AND deleted_at IS NULL";
    if (ctx.query.role) { where += " AND role = ?"; params.push(ctx.query.role); }
    if (ctx.query.status) { where += " AND status = ?"; params.push(ctx.query.status); }
    if (ctx.query.keyword) { where += " AND (nickname LIKE ? OR phone LIKE ?)"; params.push("%" + ctx.query.keyword + "%", "%" + ctx.query.keyword + "%"); }
    const pg = paging(ctx, { defaultSize: 300 });
    const total = get("SELECT COUNT(*) AS c FROM users" + where, ...params).c;
    const userRows = all("SELECT * FROM users" + where + " ORDER BY id DESC LIMIT ? OFFSET ?", ...params, pg.pageSize, pg.offset);
    if (!userRows.length) return ok(ctx.res, pagedResult([], total, pg));

    // 批量预取各角色档案，避免逐用户查询（N+1）
    const ids = userRows.map((u) => u.id);
    const ph = ids.map(() => "?").join(",");
    const tpMap = new Map(all(`SELECT * FROM teacher_profiles WHERE user_id IN (${ph})`, ...ids).map((t) => [t.user_id, t]));
    const ppMap = new Map(all(
      `SELECT user_id, credit_score, credit_level, completed_orders, restricted FROM parent_profiles WHERE user_id IN (${ph})`, ...ids
    ).map((p) => [p.user_id, p]));
    const apMap = new Map(all(`SELECT * FROM agent_profiles WHERE user_id IN (${ph})`, ...ids).map((a) => [a.user_id, a]));
    const spMap = new Map(all(`SELECT * FROM sales_profiles WHERE user_id IN (${ph})`, ...ids).map((s) => [s.user_id, s]));

    const list = userRows.map((u) => {
      const row = {
        id: u.id,
        nickname: u.nickname,
        phone: u.phone,
        role: u.role,
        status: u.status,
        regionId: u.region_id,
        createdAt: u.created_at,
        realName: u.real_name,
      };
      if (u.role === "teacher") {
        const tp = tpMap.get(u.id);
        row.teacher = tp ? {
          auditStatus: tp.audit_status,
          level: tp.level,
          growthScore: tp.growth_score,
          ratingAvg: Number(tp.rating_avg.toFixed(2)),
          identityType: tp.identity_type,
          hourlyPrice: tp.hourly_price,
          online: !!tp.online,
          subjects: tp.subjects,
        } : null;
      }
      if (u.role === "parent") row.parent = ppMap.get(u.id) || null;
      if (u.role === "agent") row.agent = apMap.get(u.id) || null;
      if (u.role === "sales") row.sales = spMap.get(u.id) || null;
      return row;
    });
    ok(ctx.res, pagedResult(list, total, pg));
  });

  router.post("/api/admin/users/:id/toggle", (ctx) => {
    adminOnly(ctx);
    const u = get("SELECT * FROM users WHERE id = ?", ctx.params.id);
    if (!u) throw Err.notFound("用户不存在");
    if (u.role === "admin") throw Err.forbidden("不可禁用管理员账号");
    const next = u.status === "active" ? "disabled" : "active";
    run("UPDATE users SET status = ? WHERE id = ?", next, u.id);
    audit(ctx, "admin.user.toggle", "users:" + u.id, { status: next, reason: ctx.body.reason || "" });
    ok(ctx.res, { status: next });
  });

  // 删除普通用户（家长/教员/业务员）：软删除（打标记 + 匿名化），业务台账保留。
  // 完全空白的账号才物理删除；有未完结订单或冻结待结算金额时拒绝（删了会有人吃亏）。
  router.del("/api/admin/users/:id", (ctx) => {
    adminOnly(ctx);
    const u = get("SELECT * FROM users WHERE id = ?", ctx.params.id);
    if (!u) throw Err.notFound("用户不存在");
    if (u.role === "admin") throw Err.forbidden("管理员账号不可在用户管理里删除");
    if (u.role === "agent") throw Err.biz("USE_DEDICATED_PAGE", "代理账号请到「代理管理」删除（那里有保证金与分成台账）");
    if (!["parent", "teacher", "sales"].includes(u.role)) throw Err.bad("只支持删除家长 / 教员 / 业务员账号");
    const id = Number(u.id);

    const active = get(
      "SELECT COUNT(*) AS c FROM orders WHERE (parent_id = ? OR teacher_id = ?) AND status IN ('awaiting_payment','pending_class','in_class','awaiting_parent_confirm','refunding')",
      id, id
    ).c;
    if (active) throw Err.biz("HAS_ACTIVE_ORDER", "还有 " + active + " 笔订单未完结，请先完结或关闭订单再删除");
    const w = get("SELECT balance, frozen FROM wallets WHERE user_id = ?", id);
    if (w && Number(w.frozen) !== 0) {
      throw Err.biz("HAS_FROZEN", "账户还有 ¥" + (Number(w.frozen) / 100).toFixed(2) + " 冻结金额待结算，请等结算完成再删除");
    }

    const history = [];
    const add = (n, label) => { if (n) history.push(label.replace("{n}", String(n))); };
    add(get("SELECT COUNT(*) AS c FROM orders WHERE parent_id = ? OR teacher_id = ?", id, id).c, "{n} 笔历史订单");
    add(get("SELECT COUNT(*) AS c FROM demands WHERE parent_id = ?", id).c, "{n} 条需求");
    add(get("SELECT COUNT(*) AS c FROM applications WHERE teacher_id = ?", id).c, "{n} 条报名记录");
    add(get("SELECT COUNT(*) AS c FROM reviews WHERE parent_id = ? OR teacher_id = ?", id, id).c, "{n} 条评价");
    add(get("SELECT COUNT(*) AS c FROM withdrawals WHERE user_id = ?", id).c, "{n} 笔提现记录");
    add(get("SELECT COUNT(*) AS c FROM wallet_txns WHERE user_id = ?", id).c, "{n} 条资金流水");
    add(get("SELECT COUNT(*) AS c FROM bindings WHERE user_id = ?", id).c, "{n} 条归属绑定");
    if (w && Number(w.balance) !== 0) history.push("钱包余额 " + (Number(w.balance) / 100).toFixed(2) + " 元");
    const soft = history.length > 0;

    tx(() => {
      if (!soft) {
        run("DELETE FROM addresses WHERE user_id = ?", id);
        run("DELETE FROM favorites WHERE user_id = ?", id);
        run("DELETE FROM user_coupons WHERE user_id = ?", id);
        run("DELETE FROM messages WHERE user_id = ?", id);
        run("DELETE FROM bindings WHERE user_id = ?", id);
        run("DELETE FROM wallets WHERE user_id = ?", id);
        run("DELETE FROM wallet_txns WHERE user_id = ?", id);
        run("DELETE FROM credit_logs WHERE user_id = ?", id);
        run("DELETE FROM parent_profiles WHERE user_id = ?", id);
        run("DELETE FROM teacher_services WHERE teacher_id = ?", id);
        run("DELETE FROM growth_logs WHERE teacher_id = ?", id);
        run("DELETE FROM level_logs WHERE teacher_id = ?", id);
        run("DELETE FROM teacher_profiles WHERE user_id = ?", id);
        run("DELETE FROM sales_profiles WHERE user_id = ?", id);
        run("DELETE FROM users WHERE id = ? AND role IN ('parent','teacher','sales')", id);
        audit(ctx, "admin.user.delete", "users:" + id, { mode: "hard", nickname: u.nickname ?? null, phone: maskPhone(u.phone ?? ""), role: u.role });
        return;
      }
      // 参考实现没有 token_version（它每次请求都回查 status），禁用即让旧令牌失效
      run(
        "UPDATE users SET status = 'disabled', deleted_at = ?, phone = NULL, wx_openid = NULL, nickname = ?, " +
          "avatar = NULL, real_name = NULL, id_card = NULL, password_hash = NULL, device_fp = NULL, reg_ip = NULL " +
          "WHERE id = ?",
        nowIso(), "已删除用户#" + id, id
      );
      run(
        "UPDATE teacher_profiles SET online = 0, real_name = NULL, id_card = NULL, id_card_name = NULL, " +
          "id_card_front_url = NULL, id_card_back_url = NULL, intro = NULL, edu_cert_url = NULL, " +
          "teacher_cert_url = NULL, skill_cert_url = NULL WHERE user_id = ?",
        id
      );
      run("UPDATE teacher_services SET status = 'off' WHERE teacher_id = ?", id);
      run("UPDATE demands SET status = 'revoked' WHERE parent_id = ? AND status IN ('published','paused')", id);
      run("UPDATE sales_profiles SET status = 'disabled' WHERE user_id = ?", id);
      run("DELETE FROM addresses WHERE user_id = ?", id);
      run("DELETE FROM favorites WHERE user_id = ?", id);
      run("DELETE FROM messages WHERE user_id = ?", id);
      run("DELETE FROM user_coupons WHERE user_id = ?", id);
      audit(ctx, "admin.user.delete", "users:" + id, { mode: "soft", kept: history, nickname: u.nickname ?? null, phone: maskPhone(u.phone ?? ""), role: u.role });
    });
    ok(ctx.res, { deleted: true, mode: soft ? "soft" : "hard", userId: id, role: u.role, kept: history });
  });

  router.get("/api/admin/teachers/pending", (ctx) => {
    adminOnly(ctx);
    const list = all(
      `SELECT tp.*, u.nickname, u.phone, u.created_at AS regAt FROM teacher_profiles tp JOIN users u ON u.id = tp.user_id
       WHERE tp.audit_status IN ('pending','rejected') ORDER BY tp.audit_status = 'pending' DESC, tp.created_at DESC`
    ).map((t) => ({
      userId: t.user_id,
      nickname: t.nickname,
      phone: maskPhone(t.phone),
      realName: t.real_name,
      idCard: maskIdCard(t.id_card),
      identityType: t.identity_type,
      subjects: t.subjects,
      stages: t.stages,
      hourlyPrice: t.hourly_price,
      eduCertUrl: t.edu_cert_url,
      teacherCertUrl: t.teacher_cert_url,
      skillCertUrl: t.skill_cert_url,
      intro: t.intro,
      auditStatus: t.audit_status,
      rejectReason: t.reject_reason,
      createdAt: t.created_at,
    }));
    ok(ctx.res, list);
  });

  router.post("/api/admin/teachers/:id/audit", (ctx) => {
    adminOnly(ctx);
    const tp = get("SELECT * FROM teacher_profiles WHERE user_id = ?", ctx.params.id);
    if (!tp) throw Err.notFound("教员不存在");
    const { approve, reason } = ctx.body;
    if (approve) {
      run("UPDATE teacher_profiles SET audit_status = 'approved', reject_reason = NULL, updated_at = ? WHERE user_id = ?", nowIso(), tp.user_id);
      run("UPDATE users SET role = 'teacher' WHERE id = ?", tp.user_id);
      notify(tp.user_id, "资质审核通过", "恭喜！您的教员资质已通过审核，可上线接单", "system", "/teacher/home");
    } else {
      if (!reason) throw Err.bad("驳回需填写原因");
      run("UPDATE teacher_profiles SET audit_status = 'rejected', reject_reason = ?, online = 0, updated_at = ? WHERE user_id = ?", reason, nowIso(), tp.user_id);
      notify(tp.user_id, "资质审核未通过", "原因：" + reason, "system", "/teacher/apply");
    }
    audit(ctx, "admin.teacher.audit", "users:" + tp.user_id, { approve, reason });
    ok(ctx.res, { auditStatus: approve ? "approved" : "rejected" });
  });

  router.post("/api/admin/teachers/:id/level", (ctx) => {
    adminOnly(ctx);
    const tp = get("SELECT * FROM teacher_profiles WHERE user_id = ?", ctx.params.id);
    if (!tp) throw Err.notFound("教员不存在");
    const { level, note } = ctx.body;
    const target = teacherLevels().find((l) => l.level === level);
    if (!target) throw Err.bad("等级不存在");
    run("UPDATE teacher_profiles SET level = ?, growth_score = ?, updated_at = ? WHERE user_id = ?", target.level, target.min, nowIso(), tp.user_id);
    run("INSERT INTO level_logs (teacher_id, from_level, to_level, reason, created_at) VALUES (?,?,?,?,?)",
      tp.user_id, tp.level, target.level, "平台人工调整：" + (note || ""), nowIso());
    notify(tp.user_id, "等级已调整", "平台将您的等级调整为 " + target.name, "system");
    audit(ctx, "admin.teacher.level", "users:" + tp.user_id, { from: tp.level, to: target.level, note });
    ok(ctx.res, { level: target.level });
  });

  /* ---------------- 订单管理 ---------------- */
  router.get("/api/admin/orders", (ctx) => {
    adminOnly(ctx);
    let where = " WHERE 1=1";
    const params = [];
    if (ctx.query.status) { where += " AND status = ?"; params.push(ctx.query.status); }
    if (ctx.query.regionId) { where += " AND region_id = ?"; params.push(ctx.query.regionId); }
    if (ctx.query.keyword) { where += " AND order_no LIKE ?"; params.push("%" + ctx.query.keyword + "%"); }
    const pg = paging(ctx, { defaultSize: 300 });
    const total = get("SELECT COUNT(*) AS c FROM orders" + where, ...params).c;
    const rows = all("SELECT * FROM orders" + where + " ORDER BY id DESC LIMIT ? OFFSET ?", ...params, pg.pageSize, pg.offset);
    const list = orderViews(rows, "parent", { mask: false });
    ok(ctx.res, { ...pagedResult(list, total, pg), statuses: rule("settlement") });
  });

  router.post("/api/admin/orders/:id/price", (ctx) => {
    adminOnly(ctx);
    const o = get("SELECT * FROM orders WHERE id = ?", ctx.params.id);
    if (!o) throw Err.notFound("订单不存在");
    if (o.paid_at) throw Err.biz("BAD_STATUS", "已支付订单不可改价，请走退款流程");
    const amount = Math.round(Number(ctx.body.amount));
    if (!(amount > 0)) throw Err.bad("金额不合法");
    run("UPDATE orders SET amount = ?, remark = ?, updated_at = ? WHERE id = ?",
      amount, (o.remark || "") + " [平台改价 " + (o.amount / 100).toFixed(2) + "→" + (amount / 100).toFixed(2) + "]", nowIso(), o.id);
    audit(ctx, "admin.order.price", "orders:" + o.id, { from: o.amount, to: amount, note: ctx.body.note });
    ok(ctx.res, get("SELECT * FROM orders WHERE id = ?", o.id));
  });

  router.post("/api/admin/orders/:id/close", (ctx) => {
    adminOnly(ctx);
    const o = get("SELECT * FROM orders WHERE id = ?", ctx.params.id);
    if (!o) throw Err.notFound("订单不存在");
    if (["settled", "refunded", "cancelled"].includes(o.status)) throw Err.biz("BAD_STATUS", "订单已终结");
    return tx(() => {
      let refunded = 0;
      if (o.paid_at) {
        // 已支付订单被平台关闭：资金原路退回，并按已出账处理，保证担保台账闭合
        refunded = o.amount + o.urgent_fee;
        escrowMove(o.id, "out", refunded, "平台强制关闭订单，担保资金退回 " + o.order_no);
        run(
          "INSERT INTO payments (order_id, user_id, type, amount, channel, trade_no, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
          o.id, o.parent_id, "refund", refunded, "wechat_jsapi", tradeNo("RF"), "success", nowIso()
        );
        notify(o.parent_id, "订单已关闭并退款", "订单 " + o.order_no + " 已被平台关闭，退款 ¥" + (refunded / 100).toFixed(2) + " 原路退回", "order");
        notify(o.teacher_id, "订单已关闭", "订单 " + o.order_no + " 已被平台关闭", "order");
      }
      run(
        "UPDATE orders SET status = 'cancelled', cancel_by = 'admin', cancel_reason = ?, refund_amount = ?, updated_at = ? WHERE id = ?",
        ctx.body.reason || "平台关闭", refunded, nowIso(), o.id
      );
      audit(ctx, "admin.order.close", "orders:" + o.id, { refunded });
      return ok(ctx.res, { ok: true, refunded });
    });
  });

  // 订单导出 CSV（需求 4.5.3「筛选、导出」）
  router.get("/api/admin/orders/export", (ctx) => {
    adminOnly(ctx);
    let sql = "SELECT * FROM orders WHERE 1=1";
    const params = [];
    if (ctx.query.status) { sql += " AND status = ?"; params.push(ctx.query.status); }
    if (ctx.query.regionId) { sql += " AND region_id = ?"; params.push(ctx.query.regionId); }
    if (ctx.query.keyword) { sql += " AND order_no LIKE ?"; params.push("%" + ctx.query.keyword + "%"); }
    sql += " ORDER BY id DESC LIMIT 5000";
    const rows = all(sql, ...params);
    const regionName = (id) => get("SELECT name FROM regions WHERE id = ?", id)?.name || "";
    const statusText = {
      awaiting_payment: "待付款", pending_class: "待上课", in_class: "进行中",
      awaiting_parent_confirm: "待家长确认", completed: "已完成", settled: "已结算",
      cancelled: "已取消", refunding: "退款中", refunded: "已退款",
    };
    const header = [
      "订单号", "片区", "家长", "教员", "科目", "学段", "实付(元)", "平台服务费(元)", "教员实收(元)",
      "代理分成(元)", "业务员提成(元)", "平台净收入(元)", "状态", "上课时间", "创建时间",
    ].join(",");
    const esc = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    const body = rows.map((o) => [
      o.order_no,
      esc(regionName(o.region_id)),
      esc(get("SELECT nickname FROM users WHERE id = ?", o.parent_id)?.nickname || o.parent_id),
      esc(get("SELECT nickname FROM users WHERE id = ?", o.teacher_id)?.nickname || o.teacher_id),
      esc(o.subject), esc(o.stage),
      (o.amount / 100).toFixed(2), (o.service_fee / 100).toFixed(2), (o.teacher_income / 100).toFixed(2),
      (o.agent_share / 100).toFixed(2), (o.sales_commission / 100).toFixed(2), (o.platform_revenue / 100).toFixed(2),
      esc(statusText[o.status] || o.status), esc(o.lesson_time), esc(o.created_at),
    ].join(",")).join("\n");
    audit(ctx, "admin.orders.export", null, { count: rows.length });
    ctx.res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="platform-orders.csv"',
    });
    ctx.res.end("\uFEFF" + header + "\n" + body);
  });

  // 手动清理超时未确认的教员报名（需求 5.1 抢单超时规则）
  router.post("/api/admin/applications/expire", (ctx) => {
    adminOnly(ctx);
    const n = expireApplications();
    audit(ctx, "admin.applications.expire", null, { count: n });
    ok(ctx.res, { expired: n, timeoutHours: rule("dispatch").grab_confirm_timeout_hours });
  });

  router.get("/api/admin/demands", (ctx) => {
    adminOnly(ctx);
    const pg = paging(ctx, { defaultSize: 200 });
    const total = get("SELECT COUNT(*) AS c FROM demands").c;
    const list = all(
      `SELECT d.*, u.nickname AS parentName, r.name AS regionName FROM demands d JOIN users u ON u.id = d.parent_id
       LEFT JOIN regions r ON r.id = d.region_id
       ORDER BY d.id DESC LIMIT ? OFFSET ?`,
      pg.pageSize, pg.offset
    );
    ok(ctx.res, pagedResult(list, total, pg));
  });

  /* ---------------- 退款工单 ---------------- */
  router.get("/api/admin/refunds", (ctx) => {
    adminOnly(ctx);
    const orders = orderViews(
      all("SELECT * FROM orders WHERE status IN ('refunding','refunded') ORDER BY id DESC LIMIT 100"),
      "parent", { mask: false }
    );
    ok(ctx.res, orders);
  });

  router.post("/api/admin/refunds/:id/review", (ctx) => {
    adminOnly(ctx);
    const o = get("SELECT * FROM orders WHERE id = ?", ctx.params.id);
    if (!o) throw Err.notFound("订单不存在");
    if (o.status !== "refunding") throw Err.biz("BAD_STATUS", "该订单不在退款审核中");
    const approve = !!ctx.body.approve;
    return tx(() => {
      if (approve) {
        const paid = o.amount + o.urgent_fee;
        // 担保资金必须出账，否则台账与订单状态不一致（由 healthcheck 巡检守护）
        run(
          "INSERT INTO payments (order_id, user_id, type, amount, channel, trade_no, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
          o.id, o.parent_id, "refund", paid, "wechat_jsapi", tradeNo("RF"), "success", nowIso()
        );
        escrowMove(o.id, "out", paid, "平台批准退款，担保资金原路退回 " + o.order_no);
        run("UPDATE orders SET status = 'refunded', refund_amount = ?, cancel_by = 'admin', updated_at = ? WHERE id = ?",
          paid, nowIso(), o.id);
        notify(o.parent_id, "退款已通过", "订单 " + o.order_no + " 退款 ¥" + (paid / 100).toFixed(2) + " 已原路退回", "payment");
        notify(o.teacher_id, "订单已退款", "订单 " + o.order_no + " 平台已批准家长退款", "order");
      } else {
        run("UPDATE orders SET status = 'pending_class', updated_at = ? WHERE id = ?", nowIso(), o.id);
        notify(o.parent_id, "退款未通过", "订单 " + o.order_no + " 退款申请被驳回：" + (ctx.body.reason || "不符合退款条件"), "payment");
      }
      run("UPDATE complaints SET status = 'closed', handler_id = ?, resolved_at = ? WHERE order_id = ? AND type = 'complaint'", ctx.user.id, nowIso(), o.id);
      audit(ctx, "admin.refund.review", "orders:" + o.id, { approve });
      return ok(ctx.res, { status: approve ? "refunded" : "pending_class" });
    });
  });

  /* ---------------- 规则配置中心 ---------------- */
  router.get("/api/admin/rules", (ctx) => {
    adminOnly(ctx);
    const rules = listRules();
    const groups = {};
    for (const r of rules) {
      groups[r.grp] = groups[r.grp] || [];
      groups[r.grp].push(r);
    }
    ok(ctx.res, { rules, groups });
  });

  router.put("/api/admin/rules/:key", (ctx) => {
    adminOnly(ctx);
    const exist = get("SELECT * FROM rule_configs WHERE key = ?", ctx.params.key);
    if (!exist) throw Err.notFound("规则不存在");
    if (!exist.editable) throw Err.forbidden("该规则不可修改");
    const before = JSON.parse(exist.value);
    setRule(ctx.params.key, ctx.body.value, ctx.user.id);
    audit(ctx, "admin.rule.update", "rule_configs:" + ctx.params.key, { before, after: ctx.body.value });
    notify(get("SELECT id FROM users WHERE role = 'agent' LIMIT 1")?.id, "平台规则变更", "规则「" + exist.label + "」已更新", "notice");
    ok(ctx.res, { key: ctx.params.key, value: ctx.body.value });
  });

  /* ---------------- 区域与代理 ---------------- */
  /** 行政区搜索：?q=张北 按地名找；?codes=130722,330106 按 adcode 取边界（含 rings） */
  router.get("/api/admin/regions/areas", (ctx) => {
    adminOnly(ctx);
    const codesCsv = String(ctx.query.codes || "").trim();
    if (codesCsv) {
      const list = areasByCodes(codesCsv.split(",").map((s) => s.trim()).filter(Boolean)).map((a) => ({
        code: a.code, name: a.name, short: a.short, level: a.level, parentCode: a.parentCode,
        center: a.center, points: a.rings.reduce((s, r) => s + r.length, 0), rings: a.rings,
      }));
      return ok(ctx.res, { list });
    }
    const list = searchAreas(ctx.query.q, 20).map((a) => ({
      code: a.code, name: a.name, short: a.short, level: a.level, parentCode: a.parentCode,
      center: a.center, points: a.rings.reduce((s, r) => s + r.length, 0),
    }));
    ok(ctx.res, { list, dataset: adminAreasStatus() });
  });

  router.get("/api/admin/regions", (ctx) => {
    adminOnly(ctx);
    const rows = all("SELECT * FROM regions ORDER BY id");
    ok(ctx.res, rows.map((r) => ({ ...r, ...decorateRegion(r) })));
  });

  router.post("/api/admin/regions", (ctx) => {
    adminOnly(ctx);
    const b = ctx.body;
    if (!b.name) throw Err.bad("请填写片区名称");
    // 两种设置方式：① adminCodes（按行政区设置，围栏=这些边界的并集）；② polygon（按地图设置）
    const adminCodes = Array.isArray(b.adminCodes) ? b.adminCodes.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [];
    let polygon = b.polygon || null;
    let centerLat = b.centerLat == null ? 0 : Number(b.centerLat);
    let centerLng = b.centerLng == null ? 0 : Number(b.centerLng);
    if (adminCodes.length) {
      const fence = fenceFromCodes(adminCodes);
      if (!fence) throw Err.bad("所选行政区不在内置数据集中（可用「按地图设置」手绘，或导入更完整的区划边界）");
      if (fence.missing.length) throw Err.bad("这些行政区未收录边界：" + fence.missing.join(","));
      polygon = fence.rings;
      if (!centerLat) centerLat = fence.center[0];
      if (!centerLng) centerLng = fence.center[1];
    } else if (b.centerLat == null || b.centerLng == null) {
      throw Err.bad("请填写片区名称与中心坐标（或直接选择行政区）");
    }
    const r = run(
      "INSERT INTO regions (name, code, center_lat, center_lng, radius_km, polygon, admin_codes, created_at) VALUES (?,?,?,?,?,?,?,?)",
      b.name, b.code || "R" + Date.now(), centerLat, centerLng,
      Number(b.radiusKm || 6), polygon ? JSON.stringify(polygon) : null,
      adminCodes.length ? JSON.stringify(adminCodes) : null, nowIso()
    );
    audit(ctx, "admin.region.create", "regions:" + r.id);
    const row = get("SELECT * FROM regions WHERE id = ?", r.id);
    ok(ctx.res, { ...row, ...decorateRegion(row) });
  });

  router.get("/api/admin/agents", (ctx) => {
    adminOnly(ctx);
    const list = all(
      `SELECT ap.*, u.nickname, u.phone, u.status AS userStatus, r.name AS regionName,
        (SELECT COUNT(*) FROM sales_profiles sp WHERE sp.agent_id = ap.user_id) AS salesCount,
        (SELECT COALESCE(SUM(agent_share),0) FROM orders o WHERE o.agent_id = ap.user_id AND o.status IN ('completed','settled')) AS totalShare
       FROM agent_profiles ap JOIN users u ON u.id = ap.user_id LEFT JOIN regions r ON r.id = ap.region_id ORDER BY ap.user_id`
    ).map((a) => ({ ...a, phone: maskPhone(a.phone) }));
    ok(ctx.res, list);
  });

  router.post("/api/admin/agents", (ctx) => {
    adminOnly(ctx);
    const b = ctx.body;
    if (!b.nickname || !/^1\d{10}$/.test(String(b.phone || ""))) throw Err.bad("请填写姓名与正确手机号");
    if (!b.regionId) throw Err.bad("请选择代理片区");
    if (get("SELECT id FROM users WHERE phone = ?", b.phone)) throw Err.biz("PHONE_EXISTS", "手机号已注册");
    const r = run(
      "INSERT INTO users (phone, password_hash, nickname, role, status, region_id, created_at) VALUES (?,?,?,?,?,?,?)",
      b.phone, hashPassword(DEMO_PASSWORD), b.nickname, "agent", "active", Number(b.regionId), nowIso()
    );
    run(
      "INSERT INTO agent_profiles (user_id, region_id, level, signed_at, deposit, status, commission_rate, mgmt_rate) VALUES (?,?,?,?,?,?,?,?)",
      r.id, Number(b.regionId), b.level || "A", nowIso(), Math.round(Number(b.deposit || 0)), "active",
      Number(b.commissionRate || rule("agent_commission").fee_share_rate),
      Number(b.mgmtRate || rule("agent_commission").mgmt_rate)
    );
    run("INSERT OR IGNORE INTO wallets (user_id, updated_at) VALUES (?,?)", r.id, nowIso());
    audit(ctx, "admin.agent.create", "users:" + r.id);
    ok(ctx.res, { id: r.id, initialPassword: DEMO_PASSWORD });
  });

  // 代理详情（含保证金台账与考核完成度）
  router.get("/api/admin/agents/:id", (ctx) => {
    adminOnly(ctx);
    const ap = get("SELECT * FROM agent_profiles WHERE user_id = ?", ctx.params.id);
    if (!ap) throw Err.notFound("代理不存在");
    const u = get("SELECT * FROM users WHERE id = ?", ap.user_id);
    const deposits = all("SELECT * FROM agent_deposits WHERE agent_id = ? ORDER BY id DESC", ap.user_id);
    const month = new Date().toISOString().slice(0, 7);
    const m = get("SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS gmv FROM orders WHERE agent_id = ? AND paid_at LIKE ?", ap.user_id, month + "%");
    const salesCount = get("SELECT COUNT(*) AS c FROM sales_profiles WHERE agent_id = ? AND status = 'active'", ap.user_id).c;
    const assess = rule("agent_assessment");
    const rate = (v, t) => (t > 0 ? Math.round((v / t) * 100) : 0);
    ok(ctx.res, {
      agent: {
        userId: ap.user_id, nickname: u.nickname, phone: maskPhone(u.phone), userStatus: u.status,
        regionId: ap.region_id, level: ap.level, signedAt: ap.signed_at, deposit: ap.deposit,
        status: ap.status, commissionRate: ap.commission_rate, mgmtRate: ap.mgmt_rate,
      },
      deposits,
      assessment: {
        targets: assess,
        monthGmv: m.gmv, monthOrders: m.c, salesCount,
        gmvRate: rate(m.gmv, assess.monthly_gmv_target),
        orderRate: rate(m.c, assess.monthly_orders_target),
        salesRate: rate(salesCount, assess.active_sales_target),
      },
    });
  });

  // 代理编辑：片区 / 等级 / 分成比例 / 考核相关
  router.put("/api/admin/agents/:id", (ctx) => {
    adminOnly(ctx);
    const ap = get("SELECT * FROM agent_profiles WHERE user_id = ?", ctx.params.id);
    if (!ap) throw Err.notFound("代理不存在");
    const b = ctx.body;
    if (b.regionId !== undefined && !get("SELECT id FROM regions WHERE id = ?", Number(b.regionId))) {
      throw Err.bad("片区不存在");
    }
    const cr = b.commissionRate !== undefined ? Number(b.commissionRate) : ap.commission_rate;
    const mr = b.mgmtRate !== undefined ? Number(b.mgmtRate) : ap.mgmt_rate;
    if (!(cr >= 0 && cr <= 1) || !(mr >= 0 && mr <= 1)) throw Err.bad("分成比例需在 0 ~ 1 之间");
    run(
      "UPDATE agent_profiles SET region_id = ?, level = ?, commission_rate = ?, mgmt_rate = ? WHERE user_id = ?",
      b.regionId !== undefined ? Number(b.regionId) : ap.region_id,
      b.level !== undefined ? b.level : ap.level,
      cr, mr, ap.user_id
    );
    if (b.regionId !== undefined) {
      run("UPDATE users SET region_id = ? WHERE id = ?", Number(b.regionId), ap.user_id);
      run("UPDATE sales_profiles SET region_id = ? WHERE agent_id = ?", Number(b.regionId), ap.user_id);
      run("UPDATE bindings SET region_id = ? WHERE agent_id = ?", Number(b.regionId), ap.user_id);
    }
    audit(ctx, "admin.agent.update", "users:" + ap.user_id, { before: ap, after: b });
    ok(ctx.res, get("SELECT * FROM agent_profiles WHERE user_id = ?", ap.user_id));
  });

  // 代理启用 / 禁用（禁用后代理端接口全部 403）
  router.post("/api/admin/agents/:id/toggle", (ctx) => {
    adminOnly(ctx);
    const ap = get("SELECT * FROM agent_profiles WHERE user_id = ?", ctx.params.id);
    if (!ap) throw Err.notFound("代理不存在");
    const next = ap.status === "active" ? "disabled" : "active";
    run("UPDATE agent_profiles SET status = ? WHERE user_id = ?", next, ap.user_id);
    run("UPDATE users SET status = ? WHERE id = ?", next === "active" ? "active" : "disabled", ap.user_id);
    audit(ctx, "admin.agent.toggle", "users:" + ap.user_id, { status: next });
    ok(ctx.res, { status: next });
  });

  // 删除代理账号：有业务数据（订单分成/绑定/下属业务员/保证金或钱包余额）时拒绝，提示改用禁用
  router.del("/api/admin/agents/:id", (ctx) => {
    adminOnly(ctx);
    const ap = get("SELECT * FROM agent_profiles WHERE user_id = ?", ctx.params.id);
    if (!ap) throw Err.notFound("代理不存在");
    const uid = Number(ap.user_id);
    const blockers = [];
    const orders = get("SELECT COUNT(*) AS c FROM orders WHERE agent_id = ?", uid).c;
    if (orders) blockers.push("名下有 " + orders + " 笔订单分成");
    const binds = get("SELECT COUNT(*) AS c FROM bindings WHERE agent_id = ?", uid).c;
    if (binds) blockers.push("已绑定 " + binds + " 个家长/业务员");
    const sales = get("SELECT COUNT(*) AS c FROM sales_profiles WHERE agent_id = ?", uid).c;
    if (sales) blockers.push("下属有 " + sales + " 名业务员");
    if (Number(ap.deposit || 0) !== 0) blockers.push("保证金余额 " + (Number(ap.deposit) / 100).toFixed(2) + " 元未退");
    const w = get("SELECT balance, frozen FROM wallets WHERE user_id = ?", uid);
    if (w && (Number(w.balance) !== 0 || Number(w.frozen) !== 0)) {
      blockers.push("钱包余额 " + (Number(w.balance) / 100).toFixed(2) + " 元未提现");
    }
    if (blockers.length) {
      throw Err.biz("AGENT_HAS_DATA", "该代理还有业务数据（" + blockers.join("；") + "），请改用「禁用」而不是删除");
    }
    const u = get("SELECT nickname, phone FROM users WHERE id = ?", uid) || {};
    tx(() => {
      run("DELETE FROM bindings WHERE agent_id = ?", uid);
      run("DELETE FROM agent_deposits WHERE agent_id = ?", uid);
      run("DELETE FROM wallets WHERE user_id = ?", uid);
      run("DELETE FROM agent_profiles WHERE user_id = ?", uid);
      run("DELETE FROM users WHERE id = ? AND role = 'agent'", uid);
      audit(ctx, "admin.agent.delete", "users:" + uid, { nickname: u.nickname ?? null, phone: maskPhone(u.phone ?? "") });
    });
    ok(ctx.res, { deleted: true, userId: uid });
  });

  // 保证金台账：缴纳 / 退还（不可退超过余额）
  router.post("/api/admin/agents/:id/deposit", (ctx) => {
    adminOnly(ctx);
    const ap = get("SELECT * FROM agent_profiles WHERE user_id = ?", ctx.params.id);
    if (!ap) throw Err.notFound("代理不存在");
    const direction = ctx.body.direction === "out" ? "out" : "in";
    const amount = Math.round(Number(ctx.body.amount));
    if (!(amount > 0)) throw Err.bad("保证金金额必须大于 0");
    if (direction === "out" && amount > ap.deposit) {
      throw Err.biz("DEPOSIT_INSUFFICIENT", "可退保证金不足，当前保证金余额 ¥" + (ap.deposit / 100).toFixed(2));
    }
    return tx(() => {
      const next = direction === "in" ? ap.deposit + amount : ap.deposit - amount;
      run("UPDATE agent_profiles SET deposit = ? WHERE user_id = ?", next, ap.user_id);
      const r = run(
        "INSERT INTO agent_deposits (agent_id, direction, amount, balance, remark, operator, created_at) VALUES (?,?,?,?,?,?,?)",
        ap.user_id, direction, amount, next, ctx.body.remark || (direction === "in" ? "缴纳保证金" : "退还保证金"), ctx.user.id, nowIso()
      );
      audit(ctx, "admin.agent.deposit", "agents:" + ap.user_id, { direction, amount, balance: next });
      return ok(ctx.res, get("SELECT * FROM agent_deposits WHERE id = ?", r.id));
    });
  });

  /* ---------------- 财务资金 ---------------- */
  router.get("/api/admin/finance", (ctx) => {
    adminOnly(ctx);
    const totalGmv = get("SELECT COALESCE(SUM(amount),0) AS s FROM orders WHERE paid_at IS NOT NULL").s;
    const serviceFee = get("SELECT COALESCE(SUM(service_fee),0) AS s FROM orders WHERE status IN ('completed','settled')").s;
    const agentShare = get("SELECT COALESCE(SUM(agent_share),0) AS s FROM orders WHERE status IN ('completed','settled')").s;
    const salesCommission = get("SELECT COALESCE(SUM(sales_commission),0) AS s FROM orders WHERE status IN ('completed','settled')").s;
    const revenue = get("SELECT COALESCE(SUM(platform_revenue),0) AS s FROM orders WHERE status IN ('completed','settled')").s;
    const pendingSettle = get("SELECT COALESCE(SUM(teacher_income),0) AS s FROM orders WHERE status = 'completed'").s;
    const withdrawals = all(
      "SELECT w.*, u.nickname, u.role FROM withdrawals w JOIN users u ON u.id = w.user_id ORDER BY w.status = 'pending' DESC, w.id DESC LIMIT 100"
    );
    const rewards = all("SELECT r.*, u.nickname FROM rewards r JOIN users u ON u.id = r.sales_id ORDER BY r.status = 'pending' DESC, r.id DESC LIMIT 100");
    ok(ctx.res, {
      summary: {
        totalGmv, serviceFee, agentShare, salesCommission, revenue,
        escrow: escrowBalance(), pendingSettle,
        totalWallet: get("SELECT COALESCE(SUM(balance),0) AS s FROM wallets").s,
        totalFrozen: get("SELECT COALESCE(SUM(frozen),0) AS s FROM wallets").s,
        withdrawPending: get("SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE status = 'pending'").s,
        invoicePending: get("SELECT COUNT(*) AS c FROM invoices WHERE status = 'pending'").c,
        invoiceIssued: get("SELECT COUNT(*) AS c FROM invoices WHERE status = 'issued'").c,
      },
      withdrawals,
      rewards,
      invoices: all(
        `SELECT i.*, u.nickname, u.phone, o.order_no, o.subject, o.stage FROM invoices i
         LEFT JOIN users u ON u.id = i.user_id LEFT JOIN orders o ON o.id = i.order_id
         ORDER BY i.status = 'pending' DESC, i.id DESC LIMIT 100`
      ),
      escrowLedger: all("SELECT * FROM escrow_ledger ORDER BY id DESC LIMIT 60"),
      payments: all("SELECT p.*, o.order_no FROM payments p LEFT JOIN orders o ON o.id = p.order_id ORDER BY p.id DESC LIMIT 60"),
      reconciliation: {
        gmvFormula: totalGmv,
        splitFormula: serviceFee,
        platformRevenue: revenue,
        agentShare,
        salesCommission,
      },
    });
  });

  // 发票受理：开票 / 驳回（需求 4.1.6）
  router.post("/api/admin/invoices/:id/review", (ctx) => {
    adminOnly(ctx);
    const inv = get("SELECT * FROM invoices WHERE id = ?", ctx.params.id);
    if (!inv) throw Err.notFound("发票申请不存在");
    if (inv.status !== "pending") throw Err.biz("BAD_STATUS", "该申请已受理（" + inv.status + "）");
    const approve = !!ctx.body.approve;
    return tx(() => {
      if (approve) {
        const url = String(ctx.body.invoiceUrl || "").trim();
        run(
          "UPDATE invoices SET status = 'issued', invoice_url = ?, handled_by = ?, handled_at = ?, reject_reason = NULL WHERE id = ?",
          url || null, ctx.user.id, nowIso(), inv.id
        );
        notify(inv.user_id, "发票已开具",
          "申请单 " + inv.invoice_no + " 已开票成功（¥" + (inv.amount / 100).toFixed(2) + "）" +
          (url ? "，下载地址：" + url : "，电子发票请留意邮箱"),
          "payment", "/wallet");
      } else {
        const reason = String(ctx.body.rejectReason || "").trim();
        if (!reason) throw Err.bad("驳回需填写原因");
        run(
          "UPDATE invoices SET status = 'rejected', reject_reason = ?, handled_by = ?, handled_at = ? WHERE id = ?",
          reason, ctx.user.id, nowIso(), inv.id
        );
        notify(inv.user_id, "发票申请被驳回",
          "申请单 " + inv.invoice_no + " 驳回原因：" + reason + "，可修改后重新申请", "payment", "/wallet");
      }
      audit(ctx, "admin.invoice.review", "invoices:" + inv.id, { approve, invoiceUrl: ctx.body.invoiceUrl || null });
      return ok(ctx.res, get("SELECT * FROM invoices WHERE id = ?", inv.id));
    });
  });

  router.post("/api/admin/withdrawals/:id/review", (ctx) => {
    adminOnly(ctx);
    const w = get("SELECT * FROM withdrawals WHERE id = ?", ctx.params.id);
    if (!w) throw Err.notFound("提现申请不存在");
    if (w.status !== "pending") throw Err.biz("BAD_STATUS", "该申请已处理");
    const approve = !!ctx.body.approve;
    return tx(() => {
      if (approve) {
        run("UPDATE withdrawals SET status = 'paid', reviewed_by = ?, reviewed_at = ? WHERE id = ?", ctx.user.id, nowIso(), w.id);
        run("UPDATE wallets SET total_withdraw = total_withdraw + ?, updated_at = ? WHERE user_id = ?", w.amount, nowIso(), w.user_id);
        notify(w.user_id, "提现已打款", "¥" + (w.actual / 100).toFixed(2) + " 已打款至您的账户", "payment", "/wallet");
      } else {
        run("UPDATE withdrawals SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
          ctx.body.reason || "不符合提现条件", ctx.user.id, nowIso(), w.id);
        walletAdd(w.user_id, w.amount, { type: "withdraw_refund", remark: "提现驳回退回 ¥" + (w.amount / 100).toFixed(2) });
        notify(w.user_id, "提现被驳回", "原因：" + (ctx.body.reason || "不符合提现条件") + "，金额已退回余额", "payment", "/wallet");
      }
      audit(ctx, "admin.withdraw.review", "withdrawals:" + w.id, { approve });
      return ok(ctx.res, { status: approve ? "paid" : "rejected" });
    });
  });

  router.post("/api/admin/rewards/settle", (ctx) => {
    adminOnly(ctx);
    const pending = all("SELECT * FROM rewards WHERE status = 'pending'");
    let n = 0;
    for (const r of pending) {
      tx(() => {
        walletAdd(r.sales_id, r.amount, { type: "reward", orderId: r.ref_order_id, remark: "奖励结算：" + r.type });
        run("UPDATE rewards SET status = 'settled', settle_at = ? WHERE id = ?", nowIso(), r.id);
        n++;
      });
    }
    audit(ctx, "admin.reward.settle", null, { count: n });
    ok(ctx.res, { settled: n });
  });

  /* ---------------- 风控与仲裁 ---------------- */
  router.get("/api/admin/risks", (ctx) => {
    adminOnly(ctx);
    const events = all(
      `SELECT e.*, o.order_no, u.nickname, u.role AS userRole FROM risk_events e
       LEFT JOIN orders o ON o.id = e.order_id LEFT JOIN users u ON u.id = e.user_id
       ORDER BY e.status = 'closed' ASC, e.id DESC LIMIT 200`
    );
    const appeals = all(
      `SELECT r.*, t.nickname AS teacherName, p.nickname AS parentName, o.order_no FROM reviews r
       LEFT JOIN users t ON t.id = r.teacher_id LEFT JOIN users p ON p.id = r.parent_id
       LEFT JOIN orders o ON o.id = r.order_id WHERE r.appeal_status <> 'none' ORDER BY r.id DESC LIMIT 100`
    ).map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));
    const complaints = all(
      `SELECT c.*, u.nickname AS fromName, o.order_no FROM complaints c LEFT JOIN users u ON u.id = c.from_user
       LEFT JOIN orders o ON o.id = c.order_id ORDER BY c.status = 'closed' ASC, c.id DESC LIMIT 100`
    );
    ok(ctx.res, { events, appeals, complaints });
  });

  router.post("/api/admin/risks/:id/handle", (ctx) => {
    adminOnly(ctx);
    const e = get("SELECT * FROM risk_events WHERE id = ?", ctx.params.id);
    if (!e) throw Err.notFound("事件不存在");
    const { action, note } = ctx.body; // close | hold | release | punish
    if (action === "close") {
      run("UPDATE risk_events SET status = 'closed', settlement_hold = 0, handled_by = ? WHERE id = ?", ctx.user.id, e.id);
    } else if (action === "hold") {
      run("UPDATE risk_events SET status = 'reviewing', settlement_hold = 1, handled_by = ? WHERE id = ?", ctx.user.id, e.id);
    } else if (action === "release") {
      run("UPDATE risk_events SET settlement_hold = 0, handled_by = ? WHERE id = ?", ctx.user.id, e.id);
    } else if (action === "punish") {
      if (e.user_id && e.type === "fake_checkin") applyGrowth(e.user_id, -100, "虚假打卡扣分：" + (note || ""), e.order_id);
      if (e.user_id && e.type === "brush") run("UPDATE users SET status = 'disabled' WHERE id = ?", e.user_id);
      run("UPDATE risk_events SET status = 'closed', settlement_hold = 0, handled_by = ? WHERE id = ?", ctx.user.id, e.id);
      notify(e.user_id, "违规处理通知", "平台检测到异常行为并已处理：" + (note || e.type), "risk");
    } else {
      throw Err.bad("不支持的处理动作");
    }
    audit(ctx, "admin.risk." + action, "risk_events:" + e.id);
    ok(ctx.res, { ok: true });
  });

  router.post("/api/admin/appeals/:id/arbitrate", (ctx) => {
    adminOnly(ctx);
    const r = get("SELECT * FROM reviews WHERE id = ?", ctx.params.id);
    if (!r) throw Err.notFound("评价不存在");
    if (r.appeal_status !== "pending") throw Err.biz("BAD_STATUS", "该评价无待处理申诉");
    const accept = !!ctx.body.accept;
    return tx(() => {
      if (accept) {
        run("UPDATE reviews SET appeal_status = 'accepted', status = 'hidden', appeal_result = ? WHERE id = ?",
          "平台仲裁撤销，扣分回滚", r.id);
        const cfg = rule("review_scoring");
        const back = Math.round((cfg.bad_base ?? 5) * r.weight);
        applyGrowth(r.teacher_id, back, "差评申诉成功回滚扣分", r.order_id);
        run("UPDATE teacher_profiles SET rating_count = MAX(0, rating_count - 1) WHERE user_id = ?", r.teacher_id);
        notify(r.teacher_id, "申诉成功", "平台已撤销该评价并返还成长分", "system");
      } else {
        run("UPDATE reviews SET appeal_status = 'rejected', appeal_result = ? WHERE id = ?", ctx.body.reason || "维持原判", r.id);
        notify(r.teacher_id, "申诉未通过", "平台维持原评价：" + (ctx.body.reason || ""), "system");
      }
      run("UPDATE complaints SET status = 'closed', handler_id = ?, resolved_at = ? WHERE type = 'review_appeal' AND from_user = ?", ctx.user.id, nowIso(), r.teacher_id);
      audit(ctx, "admin.appeal.arbitrate", "reviews:" + r.id, { accept });
      return ok(ctx.res, { status: accept ? "accepted" : "rejected" });
    });
  });

  router.post("/api/admin/complaints/:id/close", (ctx) => {
    adminOnly(ctx);
    const c = get("SELECT * FROM complaints WHERE id = ?", ctx.params.id);
    if (!c) throw Err.notFound("工单不存在");
    run("UPDATE complaints SET status = 'closed', handler_id = ?, handle_note = ?, resolved_at = ? WHERE id = ?",
      ctx.user.id, ctx.body.note || "平台终审结案", nowIso(), c.id);
    audit(ctx, "admin.complaint.close", "complaints:" + c.id);
    ok(ctx.res, { ok: true });
  });

  /* ---------------- 运营工具 ---------------- */
  const BANNER_STATUS = ["on", "off"];
  const ANNOUNCE_AUDIENCE = ["all", "parent", "teacher", "sales", "agent"];

  router.get("/api/admin/banners", (ctx) => { adminOnly(ctx); ok(ctx.res, all("SELECT * FROM banners ORDER BY sort")); });
  router.post("/api/admin/banners", (ctx) => {
    adminOnly(ctx);
    const b = ctx.body;
    if (!b.title) throw Err.bad("请填写标题");
    const status = BANNER_STATUS.includes(b.status) ? b.status : "on";
    const r = run("INSERT INTO banners (title, image, link, sort, status, created_at) VALUES (?,?,?,?,?,?)",
      b.title, b.image || "", b.link || "", Number(b.sort || 0), status, nowIso());
    audit(ctx, "admin.banner.create", "banners:" + r.id);
    ok(ctx.res, get("SELECT * FROM banners WHERE id = ?", r.id));
  });
  router.put("/api/admin/banners/:id", (ctx) => {
    adminOnly(ctx);
    const row = get("SELECT * FROM banners WHERE id = ?", ctx.params.id);
    if (!row) throw Err.notFound("Banner 不存在");
    const b = ctx.body;
    if (b.title !== undefined && !String(b.title).trim()) throw Err.bad("标题不能为空");
    if (b.status !== undefined && !BANNER_STATUS.includes(b.status)) throw Err.bad("状态只能为 on / off");
    run(
      "UPDATE banners SET title = ?, image = ?, link = ?, sort = ?, status = ? WHERE id = ?",
      b.title !== undefined ? String(b.title).trim() : row.title,
      b.image !== undefined ? b.image : row.image,
      b.link !== undefined ? b.link : row.link,
      b.sort !== undefined ? Number(b.sort) : row.sort,
      b.status !== undefined ? b.status : row.status,
      row.id
    );
    audit(ctx, "admin.banner.update", "banners:" + row.id, { before: row, after: b });
    ok(ctx.res, get("SELECT * FROM banners WHERE id = ?", row.id));
  });
  router.post("/api/admin/banners/:id/toggle", (ctx) => {
    adminOnly(ctx);
    const row = get("SELECT * FROM banners WHERE id = ?", ctx.params.id);
    if (!row) throw Err.notFound("Banner 不存在");
    const next = row.status === "on" ? "off" : "on";
    run("UPDATE banners SET status = ? WHERE id = ?", next, row.id);
    audit(ctx, "admin.banner.toggle", "banners:" + row.id, { status: next });
    ok(ctx.res, { id: row.id, status: next });
  });
  router.del("/api/admin/banners/:id", (ctx) => {
    adminOnly(ctx);
    const row = get("SELECT * FROM banners WHERE id = ?", ctx.params.id);
    if (!row) throw Err.notFound("Banner 不存在");
    run("DELETE FROM banners WHERE id = ?", row.id);
    audit(ctx, "admin.banner.delete", "banners:" + row.id, { title: row.title });
    ok(ctx.res, { ok: true });
  });

  router.get("/api/admin/announcements", (ctx) => { adminOnly(ctx); ok(ctx.res, all("SELECT * FROM announcements ORDER BY id DESC")); });
  router.post("/api/admin/announcements", (ctx) => {
    adminOnly(ctx);
    const b = ctx.body;
    if (!b.title) throw Err.bad("请填写标题");
    if (b.audience && !ANNOUNCE_AUDIENCE.includes(b.audience)) throw Err.bad("公告可见范围不合法");
    const status = BANNER_STATUS.includes(b.status) ? b.status : "on";
    const r = run("INSERT INTO announcements (title, content, audience, pinned, status, created_at) VALUES (?,?,?,?,?,?)",
      b.title, b.content || "", b.audience || "all", b.pinned ? 1 : 0, status, nowIso());
    audit(ctx, "admin.announcement.create", "announcements:" + r.id);
    if (b.push) {
      const users = all("SELECT id FROM users WHERE role = ? OR ? = 'all'", b.audience || "parent", b.audience || "all");
      for (const u of users) notify(u.id, b.title, b.content || "", "notice");
    }
    ok(ctx.res, get("SELECT * FROM announcements WHERE id = ?", r.id));
  });
  router.put("/api/admin/announcements/:id", (ctx) => {
    adminOnly(ctx);
    const row = get("SELECT * FROM announcements WHERE id = ?", ctx.params.id);
    if (!row) throw Err.notFound("公告不存在");
    const b = ctx.body;
    if (b.title !== undefined && !String(b.title).trim()) throw Err.bad("标题不能为空");
    if (b.status !== undefined && !BANNER_STATUS.includes(b.status)) throw Err.bad("状态只能为 on / off");
    if (b.audience !== undefined && !ANNOUNCE_AUDIENCE.includes(b.audience)) throw Err.bad("公告可见范围不合法");
    run(
      "UPDATE announcements SET title = ?, content = ?, audience = ?, pinned = ?, status = ? WHERE id = ?",
      b.title !== undefined ? String(b.title).trim() : row.title,
      b.content !== undefined ? b.content : row.content,
      b.audience !== undefined ? b.audience : row.audience,
      b.pinned !== undefined ? (b.pinned ? 1 : 0) : row.pinned,
      b.status !== undefined ? b.status : row.status,
      row.id
    );
    audit(ctx, "admin.announcement.update", "announcements:" + row.id, { before: row, after: b });
    if (b.push) {
      const users = all("SELECT id FROM users WHERE role = ? OR ? = 'all'", b.audience || row.audience, b.audience || row.audience);
      for (const u of users) notify(u.id, b.title || row.title, b.content || row.content || "", "notice");
    }
    ok(ctx.res, get("SELECT * FROM announcements WHERE id = ?", row.id));
  });
  router.post("/api/admin/announcements/:id/toggle", (ctx) => {
    adminOnly(ctx);
    const row = get("SELECT * FROM announcements WHERE id = ?", ctx.params.id);
    if (!row) throw Err.notFound("公告不存在");
    const next = row.status === "on" ? "off" : "on";
    run("UPDATE announcements SET status = ? WHERE id = ?", next, row.id);
    audit(ctx, "admin.announcement.toggle", "announcements:" + row.id, { status: next });
    ok(ctx.res, { id: row.id, status: next });
  });
  router.post("/api/admin/announcements/:id/pin", (ctx) => {
    adminOnly(ctx);
    const row = get("SELECT * FROM announcements WHERE id = ?", ctx.params.id);
    if (!row) throw Err.notFound("公告不存在");
    const next = row.pinned ? 0 : 1;
    run("UPDATE announcements SET pinned = ? WHERE id = ?", next, row.id);
    audit(ctx, "admin.announcement.pin", "announcements:" + row.id, { pinned: !!next });
    ok(ctx.res, { id: row.id, pinned: !!next });
  });
  router.del("/api/admin/announcements/:id", (ctx) => {
    adminOnly(ctx);
    const row = get("SELECT * FROM announcements WHERE id = ?", ctx.params.id);
    if (!row) throw Err.notFound("公告不存在");
    run("DELETE FROM announcements WHERE id = ?", row.id);
    audit(ctx, "admin.announcement.delete", "announcements:" + row.id, { title: row.title });
    ok(ctx.res, { ok: true });
  });

  router.get("/api/admin/coupons", (ctx) => { adminOnly(ctx); ok(ctx.res, all("SELECT * FROM coupons ORDER BY id DESC")); });
  router.post("/api/admin/coupons", (ctx) => {
    adminOnly(ctx);
    const b = ctx.body;
    if (!b.name || !(Number(b.amount) > 0)) throw Err.bad("请填写优惠券名称与金额");
    const status = BANNER_STATUS.includes(b.status) ? b.status : "on";
    const r = run("INSERT INTO coupons (name, amount, threshold, total, claimed, valid_from, valid_to, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      b.name, Math.round(Number(b.amount)), Math.round(Number(b.threshold || 0)), Number(b.total || 0), 0,
      b.validFrom || null, b.validTo || null, status, nowIso());
    audit(ctx, "admin.coupon.create", "coupons:" + r.id);
    ok(ctx.res, get("SELECT * FROM coupons WHERE id = ?", r.id));
  });
  router.put("/api/admin/coupons/:id", (ctx) => {
    adminOnly(ctx);
    const row = get("SELECT * FROM coupons WHERE id = ?", ctx.params.id);
    if (!row) throw Err.notFound("优惠券不存在");
    const b = ctx.body;
    if (b.status !== undefined && !BANNER_STATUS.includes(b.status)) throw Err.bad("状态只能为 on / off");
    if (b.name !== undefined && !String(b.name).trim()) throw Err.bad("名称不能为空");
    const amount = b.amount !== undefined ? Math.round(Number(b.amount)) : row.amount;
    const threshold = b.threshold !== undefined ? Math.round(Number(b.threshold)) : row.threshold;
    if (!(amount > 0)) throw Err.bad("优惠金额必须大于 0");
    if (threshold < 0) throw Err.bad("使用门槛不能为负数");
    const total = b.total !== undefined ? Number(b.total) : row.total;
    if (total > 0 && total < row.claimed) throw Err.biz("BAD_TOTAL", "发行总量不可小于已领取数量（" + row.claimed + " 张）");
    run(
      "UPDATE coupons SET name = ?, amount = ?, threshold = ?, total = ?, valid_from = ?, valid_to = ?, status = ? WHERE id = ?",
      b.name !== undefined ? String(b.name).trim() : row.name,
      amount, threshold, total,
      b.validFrom !== undefined ? (b.validFrom || null) : row.valid_from,
      b.validTo !== undefined ? (b.validTo || null) : row.valid_to,
      b.status !== undefined ? b.status : row.status,
      row.id
    );
    audit(ctx, "admin.coupon.update", "coupons:" + row.id, { before: row, after: b });
    ok(ctx.res, get("SELECT * FROM coupons WHERE id = ?", row.id));
  });
  router.post("/api/admin/coupons/:id/toggle", (ctx) => {
    adminOnly(ctx);
    const row = get("SELECT * FROM coupons WHERE id = ?", ctx.params.id);
    if (!row) throw Err.notFound("优惠券不存在");
    const next = row.status === "on" ? "off" : "on";
    run("UPDATE coupons SET status = ? WHERE id = ?", next, row.id);
    audit(ctx, "admin.coupon.toggle", "coupons:" + row.id, { status: next });
    ok(ctx.res, { id: row.id, status: next });
  });

  router.get("/api/admin/agreements", (ctx) => { adminOnly(ctx); ok(ctx.res, all("SELECT * FROM agreements")); });
  router.put("/api/admin/agreements/:key", (ctx) => {
    adminOnly(ctx);
    const a = get("SELECT * FROM agreements WHERE key = ?", ctx.params.key);
    if (!a) throw Err.notFound("协议不存在");
    run("UPDATE agreements SET content = ?, updated_at = ? WHERE key = ?", ctx.body.content || "", nowIso(), a.key);
    audit(ctx, "admin.agreement.update", "agreements:" + a.key);
    ok(ctx.res, { ok: true });
  });

  /* ---------------- 系统设置 ---------------- */
  router.get("/api/admin/audit-logs", (ctx) => {
    adminOnly(ctx);
    const pg = paging(ctx, { defaultSize: 300 });
    const total = get("SELECT COUNT(*) AS c FROM audit_logs").c;
    const list = all(
      `SELECT a.*, u.nickname FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      pg.pageSize, pg.offset
    );
    ok(ctx.res, pagedResult(list, total, pg));
  });

  router.get("/api/admin/admins", (ctx) => {
    adminOnly(ctx);
    ok(ctx.res, all("SELECT id, nickname, phone, status, created_at FROM users WHERE role = 'admin'"));
  });

  router.post("/api/admin/admins", (ctx) => {
    adminOnly(ctx);
    const b = ctx.body;
    if (!b.nickname || !/^1\d{10}$/.test(String(b.phone || ""))) throw Err.bad("请填写姓名与正确手机号");
    if (get("SELECT id FROM users WHERE phone = ?", b.phone)) throw Err.biz("PHONE_EXISTS", "手机号已注册");
    const r = run("INSERT INTO users (phone, password_hash, nickname, role, status, created_at) VALUES (?,?,?,?,?,?)",
      b.phone, hashPassword(b.password || DEMO_PASSWORD), b.nickname, "admin", "active", nowIso());
    audit(ctx, "admin.admin.create", "users:" + r.id);
    ok(ctx.res, { id: r.id });
  });
}