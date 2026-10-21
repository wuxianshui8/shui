// 区域代理端：片区大盘、业务员管理、片区订单、收益结算、客诉风控、公告设置
import { all, get, run } from "../core/db.js";
import { Err, ok } from "../core/http.js";
import { nowIso, randomCode } from "../core/ids.js";
import { audit, notify } from "../core/audit.js";
import { rule } from "../core/config.js";
import { maskAddress, maskPhone } from "../core/geo.js";
import { hashPassword } from "../core/auth.js";
import { walletSnapshot } from "../core/ledger.js";
import { DEMO_PASSWORD } from "../core/defaults.js";
import { orderView, orderViews } from "../core/present.js";

function agentOf(userId) {
  const a = get("SELECT * FROM agent_profiles WHERE user_id = ?", userId);
  if (!a) throw Err.notFound("代理档案不存在");
  return a;
}

/** 数据隔离：所有查询强制携带片区 ID */
function myRegion(ctx) {
  const a = agentOf(ctx.user.id);
  return a.region_id;
}

export function register(router) {
  router.get("/api/agent/dashboard", (ctx) => {
    const a = agentOf(ctx.user.id);
    const region = get("SELECT * FROM regions WHERE id = ?", a.region_id);
    const month = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);

    const monthOrders = get("SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS gmv FROM orders WHERE region_id = ? AND paid_at LIKE ?", a.region_id, month + "%");
    const todayOrders = get("SELECT COUNT(*) AS c FROM orders WHERE region_id = ? AND created_at LIKE ?", a.region_id, today + "%");
    const salesCount = get("SELECT COUNT(*) AS c FROM sales_profiles WHERE agent_id = ? AND status = 'active'", ctx.user.id).c;
    const activeTeachers = get(
      "SELECT COUNT(DISTINCT o.teacher_id) AS c FROM orders o WHERE o.region_id = ? AND o.created_at >= ?",
      a.region_id, new Date(Date.now() - 30 * 86400000).toISOString()
    ).c;
    const activeParents = get(
      "SELECT COUNT(DISTINCT o.parent_id) AS c FROM orders o WHERE o.region_id = ? AND o.created_at >= ?",
      a.region_id, new Date(Date.now() - 30 * 86400000).toISOString()
    ).c;
    const pendingSettle = get(
      "SELECT COALESCE(SUM(agent_share),0) AS s FROM orders WHERE agent_id = ? AND status = 'completed'",
      ctx.user.id
    ).s;

    // 7 天趋势：一次 GROUP BY，避免 7 次循环查询
    const since7 = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const trendRows = all(
      "SELECT substr(paid_at,1,10) AS d, COUNT(*) AS c, COALESCE(SUM(amount),0) AS gmv FROM orders WHERE region_id = ? AND paid_at >= ? GROUP BY d",
      a.region_id, since7
    );
    const trendMap = new Map(trendRows.map((r) => [r.d, r]));
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const row = trendMap.get(key);
      trend.push({ date: key, orders: row ? row.c : 0, gmv: row ? row.gmv : 0 });
    }

    // 供需热力简图（按片区网格聚合）
    const grid = all(
      `SELECT ROUND(lat, 2) AS lat, ROUND(lng, 2) AS lng, COUNT(*) AS demandCount FROM demands WHERE region_id = ? GROUP BY ROUND(lat,2), ROUND(lng,2) ORDER BY demandCount DESC LIMIT 12`,
      a.region_id
    );

    // 考核指标（规则配置中心可调）与实际完成度
    const assess = rule("agent_assessment");
    const rate = (v, t) => (t > 0 ? Math.min(999, Math.round((v / t) * 100)) : 0);
    const gmvRate = rate(monthOrders.gmv, assess.monthly_gmv_target);
    const orderRate = rate(monthOrders.c, assess.monthly_orders_target);
    const salesRate = rate(salesCount, assess.active_sales_target);
    const score = Math.round((Math.min(100, gmvRate) + Math.min(100, orderRate) + Math.min(100, salesRate)) / 3);

    ok(ctx.res, {
      agent: { ...a, name: ctx.user.nickname, phone: maskPhone(ctx.user.phone) },
      region,
      assessment: {
        targets: assess,
        monthGmv: monthOrders.gmv,
        monthOrders: monthOrders.c,
        salesCount,
        gmvRate,
        orderRate,
        salesRate,
        score,
        status: score >= (assess.pass_score ?? 80) ? "达标" : "未达标",
      },
      metrics: {
        totalRegistrations: get("SELECT COUNT(*) AS c FROM bindings WHERE region_id = ?", a.region_id).c,
        todayOrders: todayOrders.c,
        monthGmv: monthOrders.gmv,
        monthOrders: monthOrders.c,
        activeTeachers,
        activeParents,
        salesCount,
        pendingSettle,
      },
      trend,
      grid,
      wallet: walletSnapshot(ctx.user.id),
      notices: all("SELECT * FROM announcements WHERE status = 'on' AND (audience = 'all' OR audience = 'agent') ORDER BY pinned DESC, created_at DESC LIMIT 3"),
      riskSummary: {
        abnormal: get("SELECT COUNT(*) AS c FROM risk_events WHERE region_id = ? AND status <> 'closed'", a.region_id).c,
        brush: get("SELECT COUNT(*) AS c FROM risk_events WHERE region_id = ? AND type = 'brush' AND status <> 'closed'", a.region_id).c,
        complaints: get("SELECT COUNT(*) AS c FROM complaints WHERE region_id = ? AND status IN ('open','escalated')", a.region_id).c,
      },
    });
  }, { roles: ["agent"] });

  /* ---------------- 业务员管理 ---------------- */
  router.get("/api/agent/sales", (ctx) => {
    const regionId = myRegion(ctx);
    const kw = ctx.query.keyword || "";
    const status = ctx.query.status || "";
    let sql = `SELECT sp.*, u.nickname, u.phone, u.status AS userStatus, u.created_at AS createdAt,
      (SELECT COALESCE(SUM(o.amount),0) FROM orders o WHERE o.sales_id = sp.user_id AND o.paid_at LIKE ?) AS monthGmv,
      (SELECT COUNT(*) FROM orders o WHERE o.sales_id = sp.user_id AND o.paid_at IS NOT NULL) AS dealCount,
      (SELECT COUNT(*) FROM bindings b WHERE b.sales_id = sp.user_id) AS customerCount
      FROM sales_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.region_id = ?`;
    const params = [new Date().toISOString().slice(0, 7) + "%", regionId];
    if (kw) {
      sql += " AND (u.nickname LIKE ? OR u.phone LIKE ? OR sp.code LIKE ?)";
      params.push("%" + kw + "%", "%" + kw + "%", "%" + kw + "%");
    }
    if (status) { sql += " AND sp.status = ?"; params.push(status); }
    sql += " ORDER BY monthGmv DESC";
    const list = all(sql, ...params).map((s) => ({
      userId: s.user_id,
      nickname: s.nickname,
      phone: maskPhone(s.phone),         // 敏感信息脱敏
      code: s.code,
      joinedAt: s.joined_at,
      status: s.status,
      monthGmv: s.monthGmv,
      dealCount: s.dealCount,
      customerCount: s.customerCount,
    }));
    const summary = {
      total: list.length,
      active: list.filter((s) => s.status === "active").length,
      monthGmv: list.reduce((a, b) => a + b.monthGmv, 0),
      monthNew: list.filter((s) => s.joinedAt >= new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()).length,
    };
    ok(ctx.res, { list, summary });
  }, { roles: ["agent"] });

  router.post("/api/agent/sales", (ctx) => {
    const a = agentOf(ctx.user.id);
    const { nickname, phone } = ctx.body;
    if (!nickname || !/^1\d{10}$/.test(String(phone || ""))) throw Err.bad("请填写姓名与正确的手机号");
    const exist = get("SELECT id FROM users WHERE phone = ?", phone);
    if (exist) throw Err.biz("PHONE_EXISTS", "该手机号已被注册");
    const r = run(
      "INSERT INTO users (phone, password_hash, nickname, role, status, region_id, created_at) VALUES (?,?,?,?,?,?,?)",
      phone, hashPassword(DEMO_PASSWORD), nickname, "sales", "active", a.region_id, nowIso()
    );
    run(
      "INSERT INTO sales_profiles (user_id, agent_id, region_id, code, joined_at, status) VALUES (?,?,?,?,?,?)",
      r.id, ctx.user.id, a.region_id, "S" + randomCode(6), nowIso(), "active"
    );
    run("INSERT OR IGNORE INTO wallets (user_id, updated_at) VALUES (?,?)", r.id, nowIso());
    notify(r.id, "账号已开通", "您已成为片区内业务员，初始密码 " + DEMO_PASSWORD, "system");
    audit(ctx, "agent.sales.create", "users:" + r.id);
    ok(ctx.res, { id: r.id, initialPassword: DEMO_PASSWORD });
  }, { roles: ["agent"] });

  router.post("/api/agent/sales/:id/toggle", (ctx) => {
    const a = agentOf(ctx.user.id);
    const sp = get("SELECT * FROM sales_profiles WHERE user_id = ? AND agent_id = ?", ctx.params.id, ctx.user.id);
    if (!sp) throw Err.forbidden("仅可管理本片区业务员");
    const next = sp.status === "active" ? "disabled" : "active";
    run("UPDATE sales_profiles SET status = ? WHERE user_id = ?", next, sp.user_id);
    run("UPDATE users SET status = ? WHERE id = ?", next === "active" ? "active" : "disabled", sp.user_id);
    audit(ctx, "agent.sales.toggle", "users:" + sp.user_id, { status: next });
    ok(ctx.res, { status: next });
  }, { roles: ["agent"] });

  router.get("/api/agent/sales/:id", (ctx) => {
    const sp = get("SELECT * FROM sales_profiles WHERE user_id = ? AND agent_id = ?", ctx.params.id, ctx.user.id);
    if (!sp) throw Err.forbidden("仅可查看本片区业务员");
    const u = get("SELECT * FROM users WHERE id = ?", sp.user_id);
    ok(ctx.res, {
      sales: { ...sp, nickname: u.nickname, phone: maskPhone(u.phone) },
      customers: all("SELECT COUNT(*) AS c FROM bindings WHERE sales_id = ?", sp.user_id)[0].c,
      rewards: all("SELECT type, COUNT(*) AS c, COALESCE(SUM(amount),0) AS total FROM rewards WHERE sales_id = ? GROUP BY type", sp.user_id),
      orders: all("SELECT order_no, amount, status, paid_at FROM orders WHERE sales_id = ? ORDER BY id DESC LIMIT 20", sp.user_id),
    });
  }, { roles: ["agent"] });

  /* ---------------- 片区订单 ---------------- */
  router.get("/api/agent/orders", (ctx) => {
    const regionId = myRegion(ctx);
    let sql = "SELECT * FROM orders WHERE region_id = ?";
    const params = [regionId];
    if (ctx.query.status) { sql += " AND status = ?"; params.push(ctx.query.status); }
    if (ctx.query.from) { sql += " AND created_at >= ?"; params.push(ctx.query.from); }
    if (ctx.query.to) { sql += " AND created_at <= ?"; params.push(ctx.query.to + "T23:59:59.999Z"); }
    sql += " ORDER BY id DESC LIMIT 200";
    const list = orderViews(all(sql, ...params), "parent", { mask: true });
    ok(ctx.res, { list, total: list.length });
  }, { roles: ["agent"] });

  router.get("/api/agent/orders/export", (ctx) => {
    const regionId = myRegion(ctx);
    const rows = all("SELECT order_no, subject, stage, amount, service_fee, agent_share, status, created_at FROM orders WHERE region_id = ? ORDER BY id DESC LIMIT 1000", regionId);
    const header = "订单号,科目,学段,实付(元),平台服务费(元),片区分成(元),状态,创建时间";
    const body = rows.map((r) => [r.order_no, r.subject, r.stage, (r.amount / 100).toFixed(2), (r.service_fee / 100).toFixed(2), (r.agent_share / 100).toFixed(2), r.status, r.created_at].join(",")).join("\n");
    audit(ctx, "agent.orders.export", null, { count: rows.length });
    ctx.res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="region-orders.csv"' });
    ctx.res.end("\uFEFF" + header + "\n" + body);
  }, { roles: ["agent"] });

  /* ---------------- 收益结算 ---------------- */
  router.get("/api/agent/earnings", (ctx) => {
    const a = agentOf(ctx.user.id);
    const month = new Date().toISOString().slice(0, 7);
    const settled = get("SELECT COALESCE(SUM(amount),0) AS s FROM wallet_txns WHERE user_id = ? AND type = 'agent_share'", ctx.user.id).s;
    const pending = get("SELECT COALESCE(SUM(agent_share),0) AS s FROM orders WHERE agent_id = ? AND status = 'completed'", ctx.user.id).s;
    const monthShare = get("SELECT COALESCE(SUM(agent_share),0) AS s FROM orders WHERE agent_id = ? AND status IN ('completed','settled') AND updated_at LIKE ?", ctx.user.id, month + "%").s;

    // 收益构成拆分
    const feeShare = get(
      "SELECT COALESCE(SUM(ROUND(service_fee * ?)),0) AS s FROM orders WHERE agent_id = ? AND status IN ('completed','settled')",
      a.commission_rate, ctx.user.id
    ).s;
    const mgmt = get(
      "SELECT COALESCE(SUM(ROUND(amount * ?)),0) AS s FROM orders WHERE agent_id = ? AND status IN ('completed','settled')",
      a.mgmt_rate, ctx.user.id
    ).s;
    const bonus = get("SELECT COALESCE(SUM(amount),0) AS s FROM rewards WHERE sales_id IN (SELECT user_id FROM sales_profiles WHERE agent_id = ?) AND type IN ('daily_champ','weekly_champ') AND status = 'settled'", ctx.user.id).s;

    // 月度账单
    const bills = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const key = d.toISOString().slice(0, 7);
      const share = get("SELECT COALESCE(SUM(agent_share),0) AS s FROM orders WHERE agent_id = ? AND status IN ('completed','settled') AND updated_at LIKE ?", ctx.user.id, key + "%").s;
      const orders = get("SELECT COUNT(*) AS c FROM orders WHERE region_id = ? AND paid_at LIKE ?", a.region_id, key + "%").c;
      bills.push({ month: key, amount: share, orders, status: i === 0 ? "结算中" : "已结算", billDay: rule("agent_commission").bill_day });
    }

    ok(ctx.res, {
      agent: a,
      wallet: walletSnapshot(ctx.user.id),
      totalIncome: settled + pending,
      pending,
      settled,
      monthShare,
      composition: { feeShare, mgmt: mgmt, bonus },
      bills,
      rule: rule("agent_commission"),
      withdrawals: all("SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 20", ctx.user.id),
    });
  }, { roles: ["agent"] });

  /* ---------------- 客诉与风控 ---------------- */
  router.get("/api/agent/complaints", (ctx) => {
    const regionId = myRegion(ctx);
    const list = all(
      `SELECT c.*, u.nickname AS fromName, o.order_no FROM complaints c
       LEFT JOIN users u ON u.id = c.from_user LEFT JOIN orders o ON o.id = c.order_id
       WHERE c.region_id = ? ORDER BY c.status = 'closed' ASC, c.id DESC LIMIT 100`,
      regionId
    ).map((c) => ({ ...c, fromName: c.fromName, orderNo: c.order_no }));
    ok(ctx.res, { list, total: list.length });
  }, { roles: ["agent"] });

  router.post("/api/agent/complaints/:id/handle", (ctx) => {
    const regionId = myRegion(ctx);
    const c = get("SELECT * FROM complaints WHERE id = ? AND region_id = ?", ctx.params.id, regionId);
    if (!c) throw Err.forbidden("仅可处理本片区工单");
    const action = ctx.body.action; // handled | escalate | close
    const map = { handled: "agent_handled", escalate: "escalated", close: "closed" };
    if (!map[action]) throw Err.bad("不支持的操作");
    run(
      "UPDATE complaints SET status = ?, handler_id = ?, handle_note = ?, resolved_at = ? WHERE id = ?",
      map[action], ctx.user.id, ctx.body.note || "", action === "close" ? nowIso() : null, c.id
    );
    if (action === "escalate") notify(get("SELECT id FROM users WHERE role = 'admin' LIMIT 1")?.id, "片区上报重大问题", "工单 #" + c.id + " " + c.title, "risk");
    audit(ctx, "agent.complaint." + action, "complaints:" + c.id);
    ok(ctx.res, { status: map[action] });
  }, { roles: ["agent"] });

  router.get("/api/agent/risks", (ctx) => {
    const regionId = myRegion(ctx);
    const events = all(
      `SELECT e.*, o.order_no, u.nickname FROM risk_events e LEFT JOIN orders o ON o.id = e.order_id
       LEFT JOIN users u ON u.id = e.user_id WHERE e.region_id = ? ORDER BY e.status = 'closed' ASC, e.id DESC LIMIT 100`,
      regionId
    );
    const stats = {
      abnormal: events.filter((e) => e.status !== "closed").length,
      brush: events.filter((e) => e.type === "brush").length,
      complaints: get("SELECT COUNT(*) AS c FROM complaints WHERE region_id = ? AND status <> 'closed'", regionId).c,
      highRisk: events.filter((e) => e.level === "high").length,
    };
    // 风险指数 0-100（越高越安全）
    const penalty = Math.min(100, stats.abnormal * 8 + stats.highRisk * 15 + stats.complaints * 5);
    const score = Math.max(0, 100 - penalty);
    ok(ctx.res, {
      events,
      stats,
      score,
      level: score >= 85 ? "低风险" : score >= 60 ? "中风险" : "高风险",
      highCancel: all(
        "SELECT u.nickname, COUNT(*) AS c FROM orders o JOIN users u ON u.id = o.parent_id WHERE o.region_id = ? AND o.cancel_by = 'parent' GROUP BY o.parent_id HAVING c >= ?",
        regionId, rule("risk").high_cancel_count
      ),
    });
  }, { roles: ["agent"] });

  router.post("/api/agent/risks/:id/escalate", (ctx) => {
    const regionId = myRegion(ctx);
    const e = get("SELECT * FROM risk_events WHERE id = ? AND region_id = ?", ctx.params.id, regionId);
    if (!e) throw Err.forbidden("仅可上报本片区事件");
    run("UPDATE risk_events SET status = 'reviewing', settlement_hold = 1 WHERE id = ?", e.id);
    const admin = get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    notify(admin?.id, "片区上报风险事件", "事件 #" + e.id + "：" + e.reason, "risk");
    audit(ctx, "agent.risk.escalate", "risk_events:" + e.id);
    ok(ctx.res, { ok: true });
  }, { roles: ["agent"] });

  /* ---------------- 公告与设置 ---------------- */
  router.get("/api/agent/announcements", (ctx) => {
    ok(ctx.res, all("SELECT * FROM announcements WHERE status = 'on' AND (audience = 'all' OR audience = 'agent') ORDER BY pinned DESC, created_at DESC"));
  }, { roles: ["agent"] });

  router.get("/api/agent/profile", (ctx) => {
    const a = agentOf(ctx.user.id);
    const region = get("SELECT * FROM regions WHERE id = ?", a.region_id);
    ok(ctx.res, {
      agent: { ...a, name: ctx.user.nickname, phone: maskPhone(ctx.user.phone) },
      region,
      wallet: walletSnapshot(ctx.user.id),
    });
  }, { roles: ["agent"] });
}
