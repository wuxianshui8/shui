// 区域代理端：片区大盘、业务员管理、片区订单、收益结算、客诉风控、公告（需求 2.2 / 5.5）
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { Roles } from "../common/access";
import { ok, nowIso } from "../common/reply";
import { bad, biz, forbidden, notFound } from "../common/errors";
import { maskPhone } from "../common/geo";
import { hashPassword } from "../common/password";
import { randomCode, randomPassword } from "../common/codes";
import { audit, notify } from "../common/audit";
import { walletSnapshot } from "../common/ledger";
import { RuleConfigService } from "../rules/rule-config.service";
import { OrdersService } from "../order/orders.service";

@Controller("agent")
@Roles("agent")
export class AgentController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RuleConfigService,
    private readonly orders: OrdersService,
  ) {}

  private async agentOf(uid: number) {
    const a = (await this.ds.query("SELECT * FROM `agent_profiles` WHERE `user_id` = ? LIMIT 1", [uid]))[0];
    if (!a) throw notFound("代理档案不存在");
    return a;
  }

  /** 数据隔离：所有查询强制携带片区 ID */
  private async myRegion(uid: number) {
    const a = await this.agentOf(uid);
    return Number(a.region_id);
  }

  private async me(uid: number) {
    return (await this.ds.query("SELECT `nickname`,`phone` FROM `users` WHERE `id` = ?", [uid]))[0] || {};
  }

  /* ---------------- 片区大盘 ---------------- */
  @Get("dashboard")
  async dashboard(@Req() req: any) {
    const uid = Number(req.user.uid);
    const a = await this.agentOf(uid);
    const regionId = Number(a.region_id);
    const region = (await this.ds.query("SELECT * FROM `regions` WHERE `id` = ? LIMIT 1", [regionId]))[0] || null;
    const month = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);
    const one = async (sql: string, p: any[]) => (await this.ds.query(sql, p))[0] || {};
    const n = (x: any, k = "c") => Number(x?.[k] ?? 0);

    const monthAgg = await one(
      "SELECT COUNT(*) AS c, COALESCE(SUM(`amount`),0) AS gmv FROM `orders` WHERE `region_id` = ? AND `paid_at` LIKE ?",
      [regionId, month + "%"],
    );
    const todayOrders = n(await one("SELECT COUNT(*) AS c FROM `orders` WHERE `region_id` = ? AND `created_at` LIKE ?", [regionId, today + "%"]));
    const salesCount = n(await one("SELECT COUNT(*) AS c FROM `sales_profiles` WHERE `agent_id` = ? AND `status` = 'active'", [uid]));
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
    const activeTeachers = n(await one(
      "SELECT COUNT(DISTINCT `teacher_id`) AS c FROM `orders` WHERE `region_id` = ? AND `created_at` >= ?", [regionId, since30],
    ));
    const activeParents = n(await one(
      "SELECT COUNT(DISTINCT `parent_id`) AS c FROM `orders` WHERE `region_id` = ? AND `created_at` >= ?", [regionId, since30],
    ));
    const pendingSettle = n(await one(
      "SELECT COALESCE(SUM(`agent_share`),0) AS s FROM `orders` WHERE `agent_id` = ? AND `status` = 'completed'", [uid],
    ), "s");

    // 7 天趋势：一次 GROUP BY
    const since7 = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const trendRows = await this.ds.query(
      "SELECT SUBSTR(`paid_at`,1,10) AS d, COUNT(*) AS c, COALESCE(SUM(`amount`),0) AS gmv FROM `orders` WHERE `region_id` = ? AND `paid_at` >= ? GROUP BY d",
      [regionId, since7],
    );
    const trendMap = new Map<string, any>(trendRows.map((r: any) => [r.d, r]));
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const row = trendMap.get(key);
      trend.push({ date: key, orders: row ? Number(row.c) : 0, gmv: row ? Number(row.gmv) : 0 });
    }

    // 供需热力简图（按片区网格聚合）
    const grid = await this.ds.query(
      "SELECT ROUND(`lat`,2) AS lat, ROUND(`lng`,2) AS lng, COUNT(*) AS demandCount FROM `demands` WHERE `region_id` = ? GROUP BY ROUND(`lat`,2), ROUND(`lng`,2) ORDER BY demandCount DESC LIMIT 12",
      [regionId],
    );

    // 考核指标（规则配置中心可调）与实际完成度
    const assess = (await this.rules.get("agent_assessment")) as any;
    const rate = (v: number, t: number) => (t > 0 ? Math.min(999, Math.round((v / t) * 100)) : 0);
    const monthGmv = Number(monthAgg.gmv);
    const monthOrders = Number(monthAgg.c);
    const gmvRate = rate(monthGmv, Number(assess?.monthly_gmv_target ?? 0));
    const orderRate = rate(monthOrders, Number(assess?.monthly_orders_target ?? 0));
    const salesRate = rate(salesCount, Number(assess?.active_sales_target ?? 0));
    const score = Math.round((Math.min(100, gmvRate) + Math.min(100, orderRate) + Math.min(100, salesRate)) / 3);
    const me = await this.me(uid);

    return ok({
      agent: { ...a, userId: Number(a.user_id), name: me.nickname, phone: maskPhone(me.phone) },
      region: region ? { id: Number(region.id), name: region.name } : null,
      assessment: {
        targets: assess,
        monthGmv,
        monthOrders,
        salesCount,
        gmvRate,
        orderRate,
        salesRate,
        score,
        status: score >= Number(assess?.pass_score ?? 80) ? "达标" : "未达标",
      },
      metrics: {
        totalRegistrations: n(await one("SELECT COUNT(*) AS c FROM `bindings` WHERE `region_id` = ?", [regionId])),
        todayOrders,
        monthGmv,
        monthOrders,
        activeTeachers,
        activeParents,
        salesCount,
        pendingSettle,
      },
      trend,
      grid,
      wallet: await walletSnapshot(this.ds, uid),
      notices: await this.ds.query(
        "SELECT * FROM `announcements` WHERE `status` = 'on' AND (`audience` = 'all' OR `audience` = 'agent') ORDER BY `pinned` DESC, `created_at` DESC LIMIT 3",
      ),
      riskSummary: {
        abnormal: n(await one("SELECT COUNT(*) AS c FROM `risk_events` WHERE `region_id` = ? AND `status` <> 'closed'", [regionId])),
        brush: n(await one("SELECT COUNT(*) AS c FROM `risk_events` WHERE `region_id` = ? AND `type` = 'brush' AND `status` <> 'closed'", [regionId])),
        complaints: n(await one("SELECT COUNT(*) AS c FROM `complaints` WHERE `region_id` = ? AND `status` IN ('open','escalated')", [regionId])),
      },
    });
  }

  /* ---------------- 业务员管理 ---------------- */
  @Get("sales")
  async salesList(@Query("keyword") keyword: string, @Query("status") status: string, @Req() req: any) {
    const uid = Number(req.user.uid);
    const regionId = await this.myRegion(uid);
    const monthPrefix = new Date().toISOString().slice(0, 7) + "%";
    let sql = `SELECT sp.*, u.\`nickname\`, u.\`phone\`, u.\`status\` AS userStatus, u.\`created_at\` AS createdAt,
      (SELECT COALESCE(SUM(o.\`amount\`),0) FROM \`orders\` o WHERE o.\`sales_id\` = sp.\`user_id\` AND o.\`paid_at\` LIKE ?) AS monthGmv,
      (SELECT COUNT(*) FROM \`orders\` o WHERE o.\`sales_id\` = sp.\`user_id\` AND o.\`paid_at\` IS NOT NULL) AS dealCount,
      (SELECT COUNT(*) FROM \`bindings\` b WHERE b.\`sales_id\` = sp.\`user_id\`) AS customerCount
      FROM \`sales_profiles\` sp JOIN \`users\` u ON u.id = sp.\`user_id\` WHERE sp.\`region_id\` = ?`;
    const params: any[] = [monthPrefix, regionId];
    if (keyword) {
      sql += " AND (u.`nickname` LIKE ? OR u.`phone` LIKE ? OR sp.`code` LIKE ?)";
      params.push("%" + keyword + "%", "%" + keyword + "%", "%" + keyword + "%");
    }
    if (status) { sql += " AND sp.`status` = ?"; params.push(status); }
    sql += " ORDER BY monthGmv DESC";
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const list = (await this.ds.query(sql, params)).map((s: any) => ({
      userId: Number(s.user_id),
      nickname: s.nickname,
      phone: maskPhone(s.phone), // 敏感信息脱敏
      code: s.code,
      joinedAt: s.joined_at,
      status: s.status,
      monthGmv: Number(s.monthGmv),
      dealCount: Number(s.dealCount),
      customerCount: Number(s.customerCount),
    }));
    return ok({
      list,
      summary: {
        total: list.length,
        active: list.filter((s) => s.status === "active").length,
        monthGmv: list.reduce((a, b) => a + b.monthGmv, 0),
        monthNew: list.filter((s) => s.joinedAt >= monthStart).length,
      },
    });
  }

  @Post("sales")
  @HttpCode(200)
  async createSales(@Body() b: any, @Req() req: any) {
    const uid = Number(req.user.uid);
    const a = await this.agentOf(uid);
    const { nickname, phone } = b || {};
    if (!nickname || !/^1\d{10}$/.test(String(phone || ""))) throw bad("请填写姓名与正确的手机号");
    const exist = (await this.ds.query("SELECT `id` FROM `users` WHERE `phone` = ? LIMIT 1", [phone]))[0];
    if (exist) throw biz("PHONE_EXISTS", "该手机号已被注册");
    // 一次性初始口令：由片区负责人当面/单独告知，账号首登强制改密（不再全站统一 a123456）
    const initialPassword = randomPassword();
    const newId = await this.ds.transaction(async (m) => {
      const r = await m.query(
        "INSERT INTO `users` (`phone`,`password_hash`,`nickname`,`role`,`status`,`region_id`,`must_change_password`,`created_at`) VALUES (?,?,?,?,?,?,?,?)",
        [phone, hashPassword(initialPassword), nickname, "sales", "active", a.region_id, 1, nowIso()],
      );
      const id = Number(r.insertId);
      await m.query(
        "INSERT INTO `sales_profiles` (`user_id`,`agent_id`,`region_id`,`code`,`joined_at`,`status`) VALUES (?,?,?,?,?,?)",
        [id, uid, a.region_id, "S" + randomCode(6), nowIso(), "active"],
      );
      await m.query("INSERT IGNORE INTO `wallets` (`user_id`,`updated_at`) VALUES (?,?)", [id, nowIso()]);
      await notify(m, id, "账号已开通", "您已成为片区内业务员，初始口令请向片区负责人索取，首次登录后需立即修改", "system");
      await audit(m, req, "agent.sales.create", "users:" + id);
      return id;
    });
    return ok({ id: newId, initialPassword, mustChangePassword: true });
  }

  @Post("sales/:id/toggle")
  @HttpCode(200)
  async toggleSales(@Param("id") id: string, @Req() req: any) {
    const uid = Number(req.user.uid);
    const sp = (await this.ds.query("SELECT * FROM `sales_profiles` WHERE `user_id` = ? AND `agent_id` = ?", [Number(id), uid]))[0];
    if (!sp) throw forbidden("仅可管理本片区业务员");
    const next = sp.status === "active" ? "disabled" : "active";
    await this.ds.query("UPDATE `sales_profiles` SET `status` = ? WHERE `user_id` = ?", [next, sp.user_id]);
    await this.ds.query("UPDATE `users` SET `status` = ? WHERE `id` = ?", [next === "active" ? "active" : "disabled", sp.user_id]);
    await audit(this.ds, req, "agent.sales.toggle", "users:" + sp.user_id, { status: next });
    return ok({ status: next });
  }

  @Get("sales/:id")
  async salesDetail(@Param("id") id: string, @Req() req: any) {
    const uid = Number(req.user.uid);
    const sp = (await this.ds.query("SELECT * FROM `sales_profiles` WHERE `user_id` = ? AND `agent_id` = ?", [Number(id), uid]))[0];
    if (!sp) throw forbidden("仅可查看本片区业务员");
    const u = (await this.ds.query("SELECT * FROM `users` WHERE `id` = ?", [sp.user_id]))[0] || {};
    return ok({
      sales: { ...sp, nickname: u.nickname, phone: maskPhone(u.phone) },
      customers: Number((await this.ds.query("SELECT COUNT(*) AS c FROM `bindings` WHERE `sales_id` = ?", [sp.user_id]))[0].c),
      rewards: await this.ds.query(
        "SELECT `type`, COUNT(*) AS c, COALESCE(SUM(`amount`),0) AS total FROM `rewards` WHERE `sales_id` = ? GROUP BY `type`",
        [sp.user_id],
      ),
      orders: await this.ds.query(
        "SELECT `order_no`,`amount`,`status`,`paid_at` FROM `orders` WHERE `sales_id` = ? ORDER BY `id` DESC LIMIT 20", [sp.user_id],
      ),
    });
  }

  /* ---------------- 片区订单 ---------------- */
  @Get("orders")
  async ordersList(@Query("status") status: string, @Query("from") from: string, @Query("to") to: string, @Req() req: any) {
    const regionId = await this.myRegion(Number(req.user.uid));
    let sql = "SELECT * FROM `orders` WHERE `region_id` = ?";
    const params: any[] = [regionId];
    if (status) { sql += " AND `status` = ?"; params.push(status); }
    if (from) { sql += " AND `created_at` >= ?"; params.push(from); }
    if (to) { sql += " AND `created_at` <= ?"; params.push(to + "T23:59:59.999Z"); }
    sql += " ORDER BY `id` DESC LIMIT 200";
    const rows = await this.ds.query(sql, params);
    const list = [];
    for (const o of rows) list.push(await this.orders.view(o, "parent", true));
    return ok({ list, total: list.length });
  }

  @Get("orders/export")
  async ordersExport(@Req() req: any, @Res() res: any) {
    const regionId = await this.myRegion(Number(req.user.uid));
    const rows = await this.ds.query(
      "SELECT `order_no`,`subject`,`stage`,`amount`,`service_fee`,`agent_share`,`status`,`created_at` FROM `orders` WHERE `region_id` = ? ORDER BY `id` DESC LIMIT 1000",
      [regionId],
    );
    const header = "订单号,科目,学段,实付(元),平台服务费(元),片区分成(元),状态,创建时间";
    const body = rows
      .map((r: any) => [
        r.order_no, r.subject, r.stage,
        (Number(r.amount) / 100).toFixed(2),
        (Number(r.service_fee) / 100).toFixed(2),
        (Number(r.agent_share) / 100).toFixed(2),
        r.status, r.created_at,
      ].join(","))
      .join("\n");
    await audit(this.ds, req, "agent.orders.export", null, { count: rows.length });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="region-orders.csv"');
    res.end("\uFEFF" + header + "\n" + body);
  }

  /* ---------------- 收益结算 ---------------- */
  @Get("earnings")
  async earnings(@Req() req: any) {
    const uid = Number(req.user.uid);
    const a = await this.agentOf(uid);
    const month = new Date().toISOString().slice(0, 7);
    const one = async (sql: string, p: any[]) => Number((await this.ds.query(sql, p))[0]?.s ?? 0);

    const settled = await one("SELECT COALESCE(SUM(`amount`),0) AS s FROM `wallet_txns` WHERE `user_id` = ? AND `type` = 'agent_share'", [uid]);
    const pending = await one("SELECT COALESCE(SUM(`agent_share`),0) AS s FROM `orders` WHERE `agent_id` = ? AND `status` = 'completed'", [uid]);
    const monthShare = await one(
      "SELECT COALESCE(SUM(`agent_share`),0) AS s FROM `orders` WHERE `agent_id` = ? AND `status` IN ('completed','settled') AND `updated_at` LIKE ?",
      [uid, month + "%"],
    );
    // 收益构成拆分
    const feeShare = await one(
      "SELECT COALESCE(SUM(ROUND(`service_fee` * ?)),0) AS s FROM `orders` WHERE `agent_id` = ? AND `status` IN ('completed','settled')",
      [Number(a.commission_rate), uid],
    );
    const mgmt = await one(
      "SELECT COALESCE(SUM(ROUND(`amount` * ?)),0) AS s FROM `orders` WHERE `agent_id` = ? AND `status` IN ('completed','settled')",
      [Number(a.mgmt_rate), uid],
    );
    const bonus = await one(
      "SELECT COALESCE(SUM(`amount`),0) AS s FROM `rewards` WHERE `sales_id` IN (SELECT `user_id` FROM `sales_profiles` WHERE `agent_id` = ?) AND `type` IN ('daily_champ','weekly_champ') AND `status` = 'settled'",
      [uid],
    );

    // 月度账单（近 6 期）
    const commission = (await this.rules.get("agent_commission")) as any;
    const bills = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const key = d.toISOString().slice(0, 7);
      const share = await one(
        "SELECT COALESCE(SUM(`agent_share`),0) AS s FROM `orders` WHERE `agent_id` = ? AND `status` IN ('completed','settled') AND `updated_at` LIKE ?",
        [uid, key + "%"],
      );
      const orders = Number((await this.ds.query(
        "SELECT COUNT(*) AS c FROM `orders` WHERE `region_id` = ? AND `paid_at` LIKE ?", [a.region_id, key + "%"],
      ))[0].c);
      bills.push({ month: key, amount: share, orders, status: i === 0 ? "结算中" : "已结算", billDay: commission?.bill_day });
    }

    return ok({
      agent: a,
      wallet: await walletSnapshot(this.ds, uid),
      totalIncome: settled + pending,
      pending,
      settled,
      monthShare,
      composition: { feeShare, mgmt, bonus },
      bills,
      rule: commission,
      withdrawals: await this.ds.query("SELECT * FROM `withdrawals` WHERE `user_id` = ? ORDER BY `id` DESC LIMIT 20", [uid]),
    });
  }

  /* ---------------- 客诉与风控 ---------------- */
  @Get("complaints")
  async complaints(@Req() req: any) {
    const regionId = await this.myRegion(Number(req.user.uid));
    const list = await this.ds.query(
      `SELECT c.*, u.\`nickname\` AS fromName, o.\`order_no\` FROM \`complaints\` c
       LEFT JOIN \`users\` u ON u.id = c.from_user LEFT JOIN \`orders\` o ON o.id = c.order_id
       WHERE c.\`region_id\` = ? ORDER BY c.\`status\` = 'closed' ASC, c.\`id\` DESC LIMIT 100`,
      [regionId],
    );
    return ok({ list, total: list.length });
  }

  @Post("complaints/:id/handle")
  @HttpCode(200)
  async handleComplaint(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    const uid = Number(req.user.uid);
    const regionId = await this.myRegion(uid);
    const c = (await this.ds.query("SELECT * FROM `complaints` WHERE `id` = ? AND `region_id` = ?", [Number(id), regionId]))[0];
    if (!c) throw forbidden("仅可处理本片区工单");
    const map: Record<string, string> = { handled: "agent_handled", escalate: "escalated", close: "closed" };
    const next = map[body?.action];
    if (!next) throw bad("不支持的操作");
    await this.ds.query(
      "UPDATE `complaints` SET `status` = ?, `handler_id` = ?, `handle_note` = ?, `resolved_at` = ? WHERE `id` = ?",
      [next, uid, body?.note || "", body.action === "close" ? nowIso() : null, c.id],
    );
    if (body.action === "escalate") {
      const admin = (await this.ds.query("SELECT `id` FROM `users` WHERE `role` = 'admin' LIMIT 1"))[0];
      await notify(this.ds, Number(admin?.id), "片区上报重大问题", "工单 #" + c.id + " " + c.title, "risk");
    }
    await audit(this.ds, req, "agent.complaint." + body.action, "complaints:" + c.id);
    return ok({ status: next });
  }

  /** 片区风控事件与风险指数（强制按片区隔离） */
  @Get("risks")
  async risks(@Req() req: any) {
    const regionId = await this.myRegion(Number(req.user.uid));
    const rows = await this.ds.query(
      `SELECT e.*, o.\`order_no\`, u.\`nickname\` FROM \`risk_events\` e
       LEFT JOIN \`orders\` o ON o.id = e.order_id LEFT JOIN \`users\` u ON u.id = e.user_id
       WHERE e.\`region_id\` = ? ORDER BY e.\`status\` = 'closed' ASC, e.\`id\` DESC LIMIT 100`,
      [regionId],
    );
    const events = rows.map((e: any) => ({
      ...e,
      id: Number(e.id),
      order_id: e.order_id == null ? null : Number(e.order_id),
      user_id: e.user_id == null ? null : Number(e.user_id),
      region_id: e.region_id == null ? null : Number(e.region_id),
      settlement_hold: Number(e.settlement_hold),
    }));
    const stats = {
      abnormal: events.filter((e: any) => e.status !== "closed").length,
      brush: events.filter((e: any) => e.type === "brush").length,
      complaints: Number((await this.ds.query(
        "SELECT COUNT(*) AS c FROM `complaints` WHERE `region_id` = ? AND `status` <> 'closed'", [regionId],
      ))[0].c),
      highRisk: events.filter((e: any) => e.level === "high").length,
    };
    const penalty = Math.min(100, stats.abnormal * 8 + stats.highRisk * 15 + stats.complaints * 5);
    const score = Math.max(0, penalty ? 100 - penalty : 100);
    return ok({
      events,
      stats,
      score,
      level: score >= 85 ? "低风险" : score >= 60 ? "中风险" : "高风险",
      highCancel: await this.ds.query(
        "SELECT u.`nickname`, COUNT(*) AS c FROM `orders` o JOIN `users` u ON u.id = o.parent_id WHERE o.`region_id` = ? AND o.`cancel_by` = 'parent' GROUP BY o.`parent_id` HAVING c >= ?",
        [regionId, Number(((await this.rules.get("risk")) as any).high_cancel_count ?? 3)],
      ),
    });
  }

  @Post("risks/:id/escalate")
  @HttpCode(200)
  async escalateRisk(@Param("id") id: string, @Req() req: any) {
    const uid = Number(req.user.uid);
    const regionId = await this.myRegion(uid);
    const e = (await this.ds.query("SELECT * FROM `risk_events` WHERE `id` = ? AND `region_id` = ?", [Number(id), regionId]))[0];
    if (!e) throw forbidden("仅可上报本片区事件");
    await this.ds.query("UPDATE `risk_events` SET `status` = 'reviewing', `settlement_hold` = 1 WHERE `id` = ?", [e.id]);
    const admin = (await this.ds.query("SELECT `id` FROM `users` WHERE `role` = 'admin' LIMIT 1"))[0];
    await notify(this.ds, Number(admin?.id), "片区上报风险事件", "事件 #" + e.id + "：" + e.reason, "risk");
    await audit(this.ds, req, "agent.risk.escalate", "risk_events:" + e.id);
    return ok({ ok: true });
  }

  /* ---------------- 公告与账号 ---------------- */
  @Get("announcements")
  async announcements() {
    return ok(await this.ds.query(
      "SELECT * FROM `announcements` WHERE `status` = 'on' AND (`audience` = 'all' OR `audience` = 'agent') ORDER BY `pinned` DESC, `created_at` DESC",
    ));
  }

  @Get("profile")
  async profile(@Req() req: any) {
    const uid = Number(req.user.uid);
    const a = await this.agentOf(uid);
    const region = (await this.ds.query("SELECT * FROM `regions` WHERE `id` = ?", [a.region_id]))[0];
    const me = await this.me(uid);
    return ok({
      agent: { ...a, userId: Number(a.user_id), name: me.nickname, phone: maskPhone(me.phone) },
      region: region ? { id: Number(region.id), name: region.name } : null,
      wallet: await walletSnapshot(this.ds, uid),
    });
  }
}
