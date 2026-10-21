// 平台后台服务（需求 4.5）：用户 / 教员审核 / 订单 / 代理 / 规则 / 风控仲裁 / 运营工具 / 审计日志
import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { bad, biz, forbidden, notFound } from "../common/errors";
import { nowIso } from "../common/reply";
import { maskPhone } from "../common/geo";
import { pagedResult, paging } from "../common/paging";
import { hashPassword } from "../common/password";
import { randomCode, randomPassword } from "../common/codes";
import { audit, notify } from "../common/audit";
import { escrowMove, walletAdd, walletUnfreezeIncoming } from "../common/ledger";
import { RuleConfigService } from "../rules/rule-config.service";
import { OrdersService } from "../order/orders.service";

const tradeNo = (p = "RF") => p + Date.now() + Math.floor(Math.random() * 1e6);
const BANNER_STATUS = ["on", "off"];
const ANNOUNCE_AUDIENCE = ["all", "parent", "teacher", "sales", "agent"];
const STATUS_TEXT: Record<string, string> = {
  awaiting_payment: "待付款",
  pending_class: "待上课",
  in_class: "进行中",
  awaiting_parent_confirm: "待家长确认",
  completed: "已完成",
  settled: "已结算",
  cancelled: "已取消",
  refunding: "退款中",
  refunded: "已退款",
};

@Injectable()
export class AdminOpsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RuleConfigService,
    private readonly orders: OrdersService,
  ) {}

  private async one(sql: string, p: any[] = []) {
    return (await this.ds.query(sql, p))[0] || null;
  }
  private async cnt(sql: string, p: any[] = []) {
    return Number((await this.ds.query(sql, p))[0]?.c ?? 0);
  }

  /* ---------------- 规则配置中心 ---------------- */
  async rulesList() {
    const rows = await this.ds.query("SELECT * FROM `rule_configs` ORDER BY `grp`, `key`");
    const list = rows.map((r: any) => ({
      key: r.key,
      grp: r.grp,
      label: r.label,
      value: JSON.parse(r.value),
      editable: Number(r.editable),
      updated_at: r.updated_at,
    }));
    const groups: Record<string, any[]> = {};
    for (const r of list) {
      groups[r.grp] = groups[r.grp] || [];
      groups[r.grp].push(r);
    }
    return { rules: list, groups };
  }

  async updateRule(ctx: any, key: string, value: any) {
    const exist = await this.one("SELECT * FROM `rule_configs` WHERE `key` = ?", [key]);
    if (!exist) throw notFound("规则不存在");
    if (!Number(exist.editable)) throw forbidden("该规则不可修改");
    if (value === undefined) throw bad("请填写规则值");
    const before = JSON.parse(exist.value);
    await this.rules.set(key, value, Number(ctx.user.uid));
    await audit(this.ds, ctx, "admin.rule.update", "rule_configs:" + key, { before, after: value });
    const agent = await this.one("SELECT `id` FROM `users` WHERE `role` = 'agent' LIMIT 1");
    if (agent) await notify(this.ds, Number(agent.id), "平台规则变更", "规则「" + exist.label + "」已更新", "notice");
    return { key, value };
  }

  /* ---------------- 用户 ---------------- */
  async users(query: any) {
    let where = " WHERE 1=1";
    const params: any[] = [];
    if (query.role) { where += " AND `role` = ?"; params.push(query.role); }
    if (query.status) { where += " AND `status` = ?"; params.push(query.status); }
    if (query.keyword) { where += " AND (`nickname` LIKE ? OR `phone` LIKE ?)"; params.push("%" + query.keyword + "%", "%" + query.keyword + "%"); }
    const pg = paging(query, { defaultSize: 300 });
    const total = await this.cnt("SELECT COUNT(*) AS c FROM `users`" + where, params);
    const rows = await this.ds.query(
      "SELECT * FROM `users`" + where + " ORDER BY `id` DESC LIMIT ? OFFSET ?",
      [...params, pg.pageSize, pg.offset],
    );
    if (!rows.length) return pagedResult([], total, pg);
    const ids = rows.map((u: any) => Number(u.id));
    const ph = ids.map(() => "?").join(",");
    const tpMap = new Map((await this.ds.query("SELECT * FROM `teacher_profiles` WHERE `user_id` IN (" + ph + ")", ids)).map((t: any) => [Number(t.user_id), t]));
    const ppMap = new Map((await this.ds.query(
      "SELECT `user_id`,`credit_score`,`credit_level`,`completed_orders`,`restricted` FROM `parent_profiles` WHERE `user_id` IN (" + ph + ")", ids,
    )).map((p: any) => [Number(p.user_id), p]));
    const apMap = new Map((await this.ds.query("SELECT * FROM `agent_profiles` WHERE `user_id` IN (" + ph + ")", ids)).map((a: any) => [Number(a.user_id), a]));
    const spMap = new Map((await this.ds.query("SELECT * FROM `sales_profiles` WHERE `user_id` IN (" + ph + ")", ids)).map((s: any) => [Number(s.user_id), s]));
    const list = rows.map((u: any) => {
      const id = Number(u.id);
      const row: any = {
        id, nickname: u.nickname, phone: u.phone, role: u.role, status: u.status,
        regionId: u.region_id == null ? null : Number(u.region_id), createdAt: u.created_at, realName: u.real_name,
      };
      if (u.role === "teacher") {
        const tp: any = tpMap.get(id);
        row.teacher = tp ? {
          auditStatus: tp.audit_status, level: tp.level, growthScore: Number(tp.growth_score),
          ratingAvg: Number(Number(tp.rating_avg).toFixed(2)), identityType: tp.identity_type,
          hourlyPrice: Number(tp.hourly_price), online: !!tp.online, subjects: tp.subjects,
          rejectReason: tp.reject_reason,
        } : null;
      }
      if (u.role === "parent") row.parent = ppMap.get(id) || null;
      if (u.role === "agent") row.agent = apMap.get(id) || null;
      if (u.role === "sales") row.sales = spMap.get(id) || null;
      return row;
    });
    return pagedResult(list, total, pg);
  }

  async toggleUser(ctx: any, id: number) {
    const u = await this.one("SELECT * FROM `users` WHERE `id` = ?", [id]);
    if (!u) throw notFound("用户不存在");
    if (u.role === "admin") throw forbidden("不可禁用管理员账号");
    const next = u.status === "active" ? "disabled" : "active";
    await this.ds.query("UPDATE `users` SET `status` = ? WHERE `id` = ?", [next, u.id]);
    await audit(this.ds, ctx, "admin.user.toggle", "users:" + u.id, { status: next, reason: ctx.body?.reason || "" });
    return { status: next };
  }

  /* ---------------- 教员入驻审核 ---------------- */
  async pendingTeachers() {
    const rows = await this.ds.query(
      `SELECT tp.*, u.\`nickname\`, u.\`phone\`, u.\`region_id\` FROM \`teacher_profiles\` tp
       JOIN \`users\` u ON u.id = tp.user_id WHERE tp.\`audit_status\` = 'pending' ORDER BY tp.\`updated_at\` DESC`,
    );
    return rows.map((r: any) => ({
      id: Number(r.user_id), nickname: r.nickname, phone: maskPhone(r.phone),
      realName: r.real_name, identityType: r.identity_type, subjects: r.subjects, stages: r.stages,
      hourlyPrice: Number(r.hourly_price), intro: r.intro, auditStatus: r.audit_status,
      eduCertUrl: r.edu_cert_url, teacherCertUrl: r.teacher_cert_url, skillCertUrl: r.skill_cert_url,
      updatedAt: r.updated_at,
    }));
  }

  async auditTeacher(ctx: any, id: number, approve: boolean, reason?: string) {
    const tp = await this.one("SELECT * FROM `teacher_profiles` WHERE `user_id` = ?", [id]);
    if (!tp) throw notFound("教员资料不存在");
    if (tp.audit_status === "approved" && approve) throw biz("ALREADY_APPROVED", "该教员已通过审核");
    if (approve) {
      await this.ds.query("UPDATE `teacher_profiles` SET `audit_status` = 'approved', `reject_reason` = NULL, `updated_at` = ? WHERE `user_id` = ?", [nowIso(), id]);
      await this.ds.query("UPDATE `users` SET `role` = 'teacher' WHERE `id` = ?", [id]);
      await notify(this.ds, id, "资质审核通过", "您的入驻资料已通过审核，可上线接单", "system");
    } else {
      const why = String(reason || "").trim();
      if (!why) throw bad("驳回需填写原因");
      await this.ds.query("UPDATE `teacher_profiles` SET `audit_status` = 'rejected', `reject_reason` = ?, `updated_at` = ? WHERE `user_id` = ?", [why, nowIso(), id]);
      await notify(this.ds, id, "资质审核未通过", "驳回原因：" + why + "，请修改后重新提交", "system");
    }
    await audit(this.ds, ctx, "admin.teacher.audit", "users:" + id, { approve, reason: reason || null });
    return { auditStatus: approve ? "approved" : "rejected" };
  }

  async setTeacherLevel(ctx: any, id: number, level: string) {
    const tp = await this.one("SELECT * FROM `teacher_profiles` WHERE `user_id` = ?", [id]);
    if (!tp) throw notFound("教员资料不存在");
    const levels = (await this.rules.get("teacher_levels")) as any[];
    if (!levels.some((l) => l.level === level)) throw bad("等级不存在");
    await this.ds.query("UPDATE `teacher_profiles` SET `level` = ?, `updated_at` = ? WHERE `user_id` = ?", [level, nowIso(), id]);
    await this.ds.query("INSERT INTO `level_logs` (`teacher_id`,`from_level`,`to_level`,`reason`,`created_at`) VALUES (?,?,?,?,?)",
      [id, tp.level, level, "平台手动调整等级", nowIso()]);
    await audit(this.ds, ctx, "admin.teacher.level", "users:" + id, { from: tp.level, to: level });
    return { level };
  }

  /* ---------------- 订单 ---------------- */
  async ordersList(query: any) {
    let where = " WHERE 1=1";
    const params: any[] = [];
    if (query.status) { where += " AND `status` = ?"; params.push(query.status); }
    if (query.regionId) { where += " AND `region_id` = ?"; params.push(Number(query.regionId)); }
    if (query.keyword) { where += " AND `order_no` LIKE ?"; params.push("%" + query.keyword + "%"); }
    const pg = paging(query, { defaultSize: 300 });
    const total = await this.cnt("SELECT COUNT(*) AS c FROM `orders`" + where, params);
    const rows = await this.ds.query(
      "SELECT * FROM `orders`" + where + " ORDER BY `id` DESC LIMIT ? OFFSET ?",
      [...params, pg.pageSize, pg.offset],
    );
    const list = [];
    for (const o of rows) list.push(await this.orders.view(o, "parent"));
    return { ...pagedResult(list, total, pg), statuses: await this.rules.get("settlement") };
  }

  async ordersExportCsv(ctx: any, query: any) {
    let sql = "SELECT * FROM `orders` WHERE 1=1";
    const params: any[] = [];
    if (query.status) { sql += " AND `status` = ?"; params.push(query.status); }
    if (query.regionId) { sql += " AND `region_id` = ?"; params.push(Number(query.regionId)); }
    if (query.keyword) { sql += " AND `order_no` LIKE ?"; params.push("%" + query.keyword + "%"); }
    sql += " ORDER BY `id` DESC LIMIT 5000";
    const rows = await this.ds.query(sql, params);

    const regions = new Map((await this.ds.query("SELECT `id`,`name` FROM `regions`")).map((r: any) => [Number(r.id), r.name]));
    const users = new Map((await this.ds.query("SELECT `id`,`nickname` FROM `users`")).map((u: any) => [Number(u.id), u.nickname]));
    const esc = (v: any) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    const header = [
      "订单号", "片区", "家长", "教员", "科目", "学段", "实付(元)", "平台服务费(元)", "教员实收(元)",
      "代理分成(元)", "业务员提成(元)", "平台净收入(元)", "状态", "上课时间", "创建时间",
    ].join(",");
    const body = rows
      .map((o: any) => [
        o.order_no,
        esc(regions.get(Number(o.region_id)) || ""),
        esc(users.get(Number(o.parent_id)) || o.parent_id),
        esc(users.get(Number(o.teacher_id)) || o.teacher_id),
        esc(o.subject), esc(o.stage),
        (Number(o.amount) / 100).toFixed(2), (Number(o.service_fee) / 100).toFixed(2), (Number(o.teacher_income) / 100).toFixed(2),
        (Number(o.agent_share) / 100).toFixed(2), (Number(o.sales_commission) / 100).toFixed(2), (Number(o.platform_revenue) / 100).toFixed(2),
        esc(STATUS_TEXT[o.status] || o.status), esc(o.lesson_time), esc(o.created_at),
      ].join(","))
      .join("\n");
    await audit(this.ds, ctx, "admin.orders.export", null, { count: rows.length });
    return { csv: "\uFEFF" + header + "\n" + body, count: rows.length };
  }

  async priceOrder(ctx: any, id: number, body: any) {
    const o = await this.one("SELECT * FROM `orders` WHERE `id` = ?", [id]);
    if (!o) throw notFound("订单不存在");
    if (o.paid_at) throw biz("BAD_STATUS", "已支付订单不可改价，请走退款流程");
    const amount = Math.round(Number(body?.amount));
    if (!(amount > 0)) throw bad("金额不合法");
    await this.ds.query("UPDATE `orders` SET `amount` = ?, `remark` = ?, `updated_at` = ? WHERE `id` = ?",
      [amount, (o.remark || "") + " [平台改价 " + (Number(o.amount) / 100).toFixed(2) + "→" + (amount / 100).toFixed(2) + "]", nowIso(), o.id]);
    await audit(this.ds, ctx, "admin.order.price", "orders:" + o.id, { from: Number(o.amount), to: amount, note: body?.note });
    return this.one("SELECT * FROM `orders` WHERE `id` = ?", [o.id]);
  }

  /** 平台强制关闭：已支付订单必须退回担保资金，保证台账闭合 */
  async closeOrder(ctx: any, id: number, reason: string) {
    return this.ds.transaction(async (m) => {
      // 行锁 + 事务内状态复查：与「到期结算」并发时不会出现「既结算又退款」
      const o = (await m.query("SELECT * FROM `orders` WHERE `id` = ? FOR UPDATE", [id]))[0];
      if (!o) throw notFound("订单不存在");
      if (["settled", "refunded", "cancelled"].includes(o.status)) throw biz("BAD_STATUS", "订单已终结");
      const refunded = o.paid_at ? Number(o.amount) + Number(o.urgent_fee) : 0;
      const upd = await m.query(
        "UPDATE `orders` SET `status` = 'cancelled', `cancel_by` = 'admin', `cancel_reason` = ?, `refund_amount` = ?, `updated_at` = ? WHERE `id` = ? AND `status` = ?",
        [reason || "平台关闭", refunded, nowIso(), o.id, o.status],
      );
      if (!Number(upd?.affectedRows ?? 1)) throw biz("BAD_STATUS", "订单状态已变更，请刷新后重试");
      if (o.paid_at) {
        await escrowMove(m, Number(o.id), "out", refunded, "平台强制关闭订单，担保资金退回 " + o.order_no);
        await m.query(
          "INSERT INTO `payments` (`order_id`,`user_id`,`type`,`amount`,`channel`,`trade_no`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?,?)",
          [o.id, o.parent_id, "refund", refunded, "wechat_jsapi", tradeNo("RF"), "success", nowIso()],
        );
        await notify(m, Number(o.parent_id), "订单已关闭并退款", "订单 " + o.order_no + " 已被平台关闭，退款 ¥" + (refunded / 100).toFixed(2) + " 原路退回", "order");
        await notify(m, Number(o.teacher_id), "订单已关闭", "订单 " + o.order_no + " 已被平台关闭", "order");
      }
      // 已确认完成（课时费已计入教员冻结池）的订单被关闭时必须冲销冻结额，
      // 否则该笔 frozen 永久悬挂、教员可用余额永久少一笔（恒等式 4 破裂）
      let unfrozen = 0;
      if (o.status === "completed" && Number(o.teacher_income) > 0) {
        unfrozen = Number(o.teacher_income);
        await walletUnfreezeIncoming(m, Number(o.teacher_id), unfrozen, {
          orderId: Number(o.id),
          remark: "平台关闭已完成订单，课时费冻结冲销（订单 " + o.order_no + "）",
        });
      }
      await audit(m, ctx, "admin.order.close", "orders:" + o.id, { refunded, unfrozen });
      return { ok: true, refunded, unfrozen };
    });
  }

  /* ---------------- 代理管理 ---------------- */
  async agents() {
    const rows = await this.ds.query(
      `SELECT ap.*, u.\`nickname\`, u.\`phone\`, u.\`status\` AS userStatus, r.\`name\` AS regionName,
        (SELECT COUNT(*) FROM \`sales_profiles\` sp WHERE sp.\`agent_id\` = ap.\`user_id\`) AS salesCount,
        (SELECT COALESCE(SUM(\`agent_share\`),0) FROM \`orders\` o WHERE o.\`agent_id\` = ap.\`user_id\` AND o.\`status\` IN ('completed','settled')) AS totalShare
       FROM \`agent_profiles\` ap JOIN \`users\` u ON u.id = ap.\`user_id\` LEFT JOIN \`regions\` r ON r.id = ap.\`region_id\` ORDER BY ap.\`user_id\``,
    );
    return rows.map((a: any) => ({
      ...a,
      user_id: Number(a.user_id),
      region_id: Number(a.region_id),
      deposit: Number(a.deposit),
      commission_rate: Number(a.commission_rate),
      mgmt_rate: Number(a.mgmt_rate),
      salesCount: Number(a.salesCount),
      totalShare: Number(a.totalShare),
      phone: maskPhone(a.phone),
    }));
  }

  async createAgent(ctx: any, b: any) {
    if (!b?.nickname || !/^1\d{10}$/.test(String(b.phone || ""))) throw bad("请填写姓名与正确手机号");
    if (!b.regionId) throw bad("请选择代理片区");
    if (await this.one("SELECT `id` FROM `users` WHERE `phone` = ?", [b.phone])) throw biz("PHONE_EXISTS", "手机号已注册");
    const cfg = (await this.rules.get("agent_commission")) as any;
    // 一次性初始口令：不再使用全站统一的演示口令，账号首登强制改密
    const initialPassword = randomPassword();
    return this.ds.transaction(async (m) => {
      const r = await m.query(
        "INSERT INTO `users` (`phone`,`password_hash`,`nickname`,`role`,`status`,`region_id`,`must_change_password`,`created_at`) VALUES (?,?,?,?,?,?,?,?)",
        [b.phone, hashPassword(initialPassword), b.nickname, "agent", "active", Number(b.regionId), 1, nowIso()],
      );
      const id = Number(r.insertId);
      await m.query(
        "INSERT INTO `agent_profiles` (`user_id`,`region_id`,`level`,`signed_at`,`deposit`,`status`,`commission_rate`,`mgmt_rate`) VALUES (?,?,?,?,?,?,?,?)",
        [id, Number(b.regionId), b.level || "A", nowIso(), Math.round(Number(b.deposit || 0)), "active",
          Number(b.commissionRate || cfg.fee_share_rate), Number(b.mgmtRate || cfg.mgmt_rate)],
      );
      await m.query("INSERT IGNORE INTO `wallets` (`user_id`,`updated_at`) VALUES (?,?)", [id, nowIso()]);
      await audit(m, ctx, "admin.agent.create", "users:" + id);
      return { id, initialPassword, mustChangePassword: true };
    });
  }

  async agentDetail(id: number) {
    const ap = await this.one("SELECT * FROM `agent_profiles` WHERE `user_id` = ?", [id]);
    if (!ap) throw notFound("代理不存在");
    const u = (await this.one("SELECT * FROM `users` WHERE `id` = ?", [ap.user_id])) || {};
    const deposits = await this.ds.query("SELECT * FROM `agent_deposits` WHERE `agent_id` = ? ORDER BY `id` DESC", [ap.user_id]);
    const month = new Date().toISOString().slice(0, 7);
    const m = (await this.one(
      "SELECT COUNT(*) AS c, COALESCE(SUM(`amount`),0) AS gmv FROM `orders` WHERE `agent_id` = ? AND `paid_at` LIKE ?",
      [ap.user_id, month + "%"],
    )) || { c: 0, gmv: 0 };
    const salesCount = await this.cnt("SELECT COUNT(*) AS c FROM `sales_profiles` WHERE `agent_id` = ? AND `status` = 'active'", [ap.user_id]);
    const assess = (await this.rules.get("agent_assessment")) as any;
    const rate = (v: number, t: number) => (t > 0 ? Math.min(999, Math.round((v / t) * 100)) : 0);
    return {
      agent: {
        userId: Number(ap.user_id), nickname: u.nickname, phone: maskPhone(u.phone), userStatus: u.status,
        regionId: Number(ap.region_id), level: ap.level, signedAt: ap.signed_at, deposit: Number(ap.deposit),
        status: ap.status, commissionRate: Number(ap.commission_rate), mgmtRate: Number(ap.mgmt_rate),
      },
      deposits,
      assessment: {
        targets: assess,
        monthGmv: Number(m.gmv), monthOrders: Number(m.c), salesCount,
        gmvRate: rate(Number(m.gmv), Number(assess?.monthly_gmv_target ?? 0)),
        orderRate: rate(Number(m.c), Number(assess?.monthly_orders_target ?? 0)),
        salesRate: rate(salesCount, Number(assess?.active_sales_target ?? 0)),
      },
    };
  }

  async updateAgent(ctx: any, id: number, b: any) {
    const ap = await this.one("SELECT * FROM `agent_profiles` WHERE `user_id` = ?", [id]);
    if (!ap) throw notFound("代理不存在");
    if (b?.regionId !== undefined && !(await this.one("SELECT `id` FROM `regions` WHERE `id` = ?", [Number(b.regionId)]))) {
      throw bad("片区不存在");
    }
    const cr = b?.commissionRate !== undefined ? Number(b.commissionRate) : Number(ap.commission_rate);
    const mr = b?.mgmtRate !== undefined ? Number(b.mgmtRate) : Number(ap.mgmt_rate);
    if (!(cr >= 0 && cr <= 1) || !(mr >= 0 && mr <= 1)) throw bad("分成比例需在 0 ~ 1 之间");
    await this.ds.transaction(async (m) => {
      await m.query(
        "UPDATE `agent_profiles` SET `region_id` = ?, `level` = ?, `commission_rate` = ?, `mgmt_rate` = ? WHERE `user_id` = ?",
        [b?.regionId !== undefined ? Number(b.regionId) : Number(ap.region_id),
          b?.level !== undefined ? b.level : ap.level, cr, mr, ap.user_id],
      );
      if (b?.regionId !== undefined) {
        await m.query("UPDATE `users` SET `region_id` = ? WHERE `id` = ?", [Number(b.regionId), ap.user_id]);
        await m.query("UPDATE `sales_profiles` SET `region_id` = ? WHERE `agent_id` = ?", [Number(b.regionId), ap.user_id]);
        await m.query("UPDATE `bindings` SET `region_id` = ? WHERE `agent_id` = ?", [Number(b.regionId), ap.user_id]);
      }
      await audit(m, ctx, "admin.agent.update", "users:" + ap.user_id, { before: ap, after: b });
    });
    return this.one("SELECT * FROM `agent_profiles` WHERE `user_id` = ?", [ap.user_id]);
  }

  async toggleAgent(ctx: any, id: number) {
    const ap = await this.one("SELECT * FROM `agent_profiles` WHERE `user_id` = ?", [id]);
    if (!ap) throw notFound("代理不存在");
    const next = ap.status === "active" ? "disabled" : "active";
    await this.ds.query("UPDATE `agent_profiles` SET `status` = ? WHERE `user_id` = ?", [next, ap.user_id]);
    await this.ds.query("UPDATE `users` SET `status` = ? WHERE `id` = ?", [next === "active" ? "active" : "disabled", ap.user_id]);
    await audit(this.ds, ctx, "admin.agent.toggle", "users:" + ap.user_id, { status: next });
    return { status: next };
  }

  /** 保证金缴纳 / 退还（不可退超过余额） */
  async agentDeposit(ctx: any, id: number, b: any) {
    const ap = await this.one("SELECT * FROM `agent_profiles` WHERE `user_id` = ?", [id]);
    if (!ap) throw notFound("代理不存在");
    const direction = b?.direction === "out" ? "out" : "in";
    const amount = Math.round(Number(b?.amount));
    if (!(amount > 0)) throw bad("保证金金额必须大于 0");
    if (direction === "out" && amount > Number(ap.deposit)) {
      throw biz("DEPOSIT_INSUFFICIENT", "可退保证金不足，当前保证金余额 ¥" + (Number(ap.deposit) / 100).toFixed(2));
    }
    return this.ds.transaction(async (m) => {
      const next = direction === "in" ? Number(ap.deposit) + amount : Number(ap.deposit) - amount;
      await m.query("UPDATE `agent_profiles` SET `deposit` = ? WHERE `user_id` = ?", [next, ap.user_id]);
      const r = await m.query(
        "INSERT INTO `agent_deposits` (`agent_id`,`direction`,`amount`,`balance`,`remark`,`operator`,`created_at`) VALUES (?,?,?,?,?,?,?)",
        [ap.user_id, direction, amount, next, b?.remark || (direction === "in" ? "缴纳保证金" : "退还保证金"), Number(ctx.user.uid), nowIso()],
      );
      await audit(m, ctx, "admin.agent.deposit", "agents:" + ap.user_id, { direction, amount, balance: next });
      return (await m.query("SELECT * FROM `agent_deposits` WHERE `id` = ?", [r.insertId]))[0];
    });
  }

  /* ---------------- 风控与仲裁 ---------------- */
  async risks() {
    const events = (await this.ds.query(
      `SELECT e.*, o.\`order_no\`, u.\`nickname\`, u.\`role\` AS userRole FROM \`risk_events\` e
       LEFT JOIN \`orders\` o ON o.id = e.order_id LEFT JOIN \`users\` u ON u.id = e.user_id
       ORDER BY e.\`status\` = 'closed' ASC, e.\`id\` DESC LIMIT 200`,
    )).map((e: any) => ({
      ...e,
      id: Number(e.id),
      order_id: e.order_id == null ? null : Number(e.order_id),
      user_id: e.user_id == null ? null : Number(e.user_id),
      region_id: e.region_id == null ? null : Number(e.region_id),
      settlement_hold: Number(e.settlement_hold),
    }));
    const appeals = (await this.ds.query(
      `SELECT r.*, t.\`nickname\` AS teacherName, p.\`nickname\` AS parentName, o.\`order_no\` FROM \`reviews\` r
       LEFT JOIN \`users\` t ON t.id = r.teacher_id LEFT JOIN \`users\` p ON p.id = r.parent_id
       LEFT JOIN \`orders\` o ON o.id = r.order_id WHERE r.\`appeal_status\` <> 'none' ORDER BY r.\`id\` DESC LIMIT 100`,
    )).map((r: any) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));
    const complaints = await this.ds.query(
      `SELECT c.*, u.\`nickname\` AS fromName, o.\`order_no\` FROM \`complaints\` c LEFT JOIN \`users\` u ON u.id = c.from_user
       LEFT JOIN \`orders\` o ON o.id = c.order_id ORDER BY c.\`status\` = 'closed' ASC, c.\`id\` DESC LIMIT 100`,
    );
    return { events, appeals, complaints };
  }

  async handleRisk(ctx: any, id: number, action: string, note?: string) {
    const e = await this.one("SELECT * FROM `risk_events` WHERE `id` = ?", [id]);
    if (!e) throw notFound("事件不存在");
    const uid = Number(ctx.user.uid);
    if (action === "close") {
      await this.ds.query("UPDATE `risk_events` SET `status` = 'closed', `settlement_hold` = 0, `handled_by` = ? WHERE `id` = ?", [uid, e.id]);
    } else if (action === "hold") {
      await this.ds.query("UPDATE `risk_events` SET `status` = 'reviewing', `settlement_hold` = 1, `handled_by` = ? WHERE `id` = ?", [uid, e.id]);
    } else if (action === "release") {
      await this.ds.query("UPDATE `risk_events` SET `settlement_hold` = 0, `handled_by` = ? WHERE `id` = ?", [uid, e.id]);
    } else if (action === "punish") {
      if (e.user_id && e.type === "fake_checkin") {
        await this.orders.applyGrowth(this.ds as any, Number(e.user_id), -100, "虚假打卡扣分：" + (note || ""), e.order_id == null ? undefined : Number(e.order_id));
      }
      if (e.user_id && e.type === "brush") {
        await this.ds.query("UPDATE `users` SET `status` = 'disabled' WHERE `id` = ?", [e.user_id]);
      }
      await this.ds.query("UPDATE `risk_events` SET `status` = 'closed', `settlement_hold` = 0, `handled_by` = ? WHERE `id` = ?", [uid, e.id]);
      await notify(this.ds, Number(e.user_id), "违规处理通知", "平台检测到异常行为并已处理：" + (note || e.type), "risk");
    } else {
      throw bad("不支持的处理动作");
    }
    await audit(this.ds, ctx, "admin.risk." + action, "risk_events:" + e.id);
    return { ok: true };
  }

  /** 差评申诉仲裁（需求 5.3）：撤销评价并回滚成长分 */
  async arbitrateAppeal(ctx: any, reviewId: number, accept: boolean, reason?: string) {
    const r = await this.one("SELECT * FROM `reviews` WHERE `id` = ?", [reviewId]);
    if (!r) throw notFound("评价不存在");
    if (r.appeal_status !== "pending") throw biz("BAD_STATUS", "该评价无待处理申诉");
    return this.ds.transaction(async (m) => {
      if (accept) {
        await m.query("UPDATE `reviews` SET `appeal_status` = 'accepted', `status` = 'hidden', `appeal_result` = ? WHERE `id` = ?",
          ["平台仲裁撤销，扣分回滚", r.id]);
        const cfg = (await this.rules.get("review_scoring")) as any;
        const back = Math.round(Number(cfg?.bad_base ?? 5) * Number(r.weight));
        await this.orders.applyGrowth(m, Number(r.teacher_id), back, "差评申诉成功回滚扣分", Number(r.order_id));
        await m.query("UPDATE `teacher_profiles` SET `rating_count` = GREATEST(0, `rating_count` - 1) WHERE `user_id` = ?", [r.teacher_id]);
        await notify(m, Number(r.teacher_id), "申诉成功", "平台已撤销该评价并返还成长分", "system");
      } else {
        await m.query("UPDATE `reviews` SET `appeal_status` = 'rejected', `appeal_result` = ? WHERE `id` = ?",
          [reason || "维持原判", r.id]);
        await notify(m, Number(r.teacher_id), "申诉未通过", "平台维持原评价：" + (reason || ""), "system");
      }
      await m.query("UPDATE `complaints` SET `status` = 'closed', `handler_id` = ?, `resolved_at` = ? WHERE `type` = 'review_appeal' AND `from_user` = ?",
        [Number(ctx.user.uid), nowIso(), r.teacher_id]);
      await audit(m, ctx, "admin.appeal.arbitrate", "reviews:" + r.id, { accept });
      return { status: accept ? "accepted" : "rejected" };
    });
  }

  async closeComplaint(ctx: any, id: number, note?: string) {
    const c = await this.one("SELECT * FROM `complaints` WHERE `id` = ?", [id]);
    if (!c) throw notFound("工单不存在");
    await this.ds.query("UPDATE `complaints` SET `status` = 'closed', `handler_id` = ?, `handle_note` = ?, `resolved_at` = ? WHERE `id` = ?",
      [Number(ctx.user.uid), note || "平台终审结案", nowIso(), c.id]);
    await audit(this.ds, ctx, "admin.complaint.close", "complaints:" + c.id);
    return { ok: true };
  }

  /* ---------------- 运营工具 ---------------- */
  async banners() {
    return this.ds.query("SELECT * FROM `banners` ORDER BY `sort`");
  }

  async createBanner(ctx: any, b: any) {
    if (!String(b?.title || "").trim()) throw bad("请填写标题");
    const status = BANNER_STATUS.includes(b?.status) ? b.status : "on";
    const r = await this.ds.query(
      "INSERT INTO `banners` (`title`,`image`,`link`,`sort`,`status`,`created_at`) VALUES (?,?,?,?,?,?)",
      [String(b.title).trim(), b.image || "", b.link || "", Number(b.sort || 0), status, nowIso()],
    );
    await audit(this.ds, ctx, "admin.banner.create", "banners:" + r.insertId);
    return this.one("SELECT * FROM `banners` WHERE `id` = ?", [r.insertId]);
  }

  async updateBanner(ctx: any, id: number, b: any) {
    const row = await this.one("SELECT * FROM `banners` WHERE `id` = ?", [id]);
    if (!row) throw notFound("Banner 不存在");
    if (b?.title !== undefined && !String(b.title).trim()) throw bad("标题不能为空");
    if (b?.status !== undefined && !BANNER_STATUS.includes(b.status)) throw bad("状态只能为 on / off");
    await this.ds.query(
      "UPDATE `banners` SET `title` = ?, `image` = ?, `link` = ?, `sort` = ?, `status` = ? WHERE `id` = ?",
      [b?.title !== undefined ? String(b.title).trim() : row.title,
        b?.image !== undefined ? b.image : row.image,
        b?.link !== undefined ? b.link : row.link,
        b?.sort !== undefined ? Number(b.sort) : row.sort,
        b?.status !== undefined ? b.status : row.status, row.id],
    );
    await audit(this.ds, ctx, "admin.banner.update", "banners:" + row.id, { before: row, after: b });
    return this.one("SELECT * FROM `banners` WHERE `id` = ?", [row.id]);
  }

  async toggleBanner(ctx: any, id: number) {
    const row = await this.one("SELECT * FROM `banners` WHERE `id` = ?", [id]);
    if (!row) throw notFound("Banner 不存在");
    const next = row.status === "on" ? "off" : "on";
    await this.ds.query("UPDATE `banners` SET `status` = ? WHERE `id` = ?", [next, row.id]);
    await audit(this.ds, ctx, "admin.banner.toggle", "banners:" + row.id, { status: next });
    return { id: Number(row.id), status: next };
  }

  async deleteBanner(ctx: any, id: number) {
    const row = await this.one("SELECT * FROM `banners` WHERE `id` = ?", [id]);
    if (!row) throw notFound("Banner 不存在");
    await this.ds.query("DELETE FROM `banners` WHERE `id` = ?", [row.id]);
    await audit(this.ds, ctx, "admin.banner.delete", "banners:" + row.id, { title: row.title });
    return { ok: true };
  }

  async announcements() {
    return this.ds.query("SELECT * FROM `announcements` ORDER BY `id` DESC");
  }

  async createAnnouncement(ctx: any, b: any) {
    if (!String(b?.title || "").trim()) throw bad("请填写标题");
    if (b?.audience && !ANNOUNCE_AUDIENCE.includes(b.audience)) throw bad("公告可见范围不合法");
    const status = BANNER_STATUS.includes(b?.status) ? b.status : "on";
    const r = await this.ds.query(
      "INSERT INTO `announcements` (`title`,`content`,`audience`,`pinned`,`status`,`created_at`) VALUES (?,?,?,?,?,?)",
      [String(b.title).trim(), b.content || "", b.audience || "all", b.pinned ? 1 : 0, status, nowIso()],
    );
    await audit(this.ds, ctx, "admin.announcement.create", "announcements:" + r.insertId);
    if (b?.push) {
      const users = await this.ds.query("SELECT `id` FROM `users` WHERE `role` = ? OR ? = 'all'", [b.audience || "parent", b.audience || "all"]);
      for (const u of users) await notify(this.ds, Number(u.id), b.title, b.content || "", "notice");
    }
    return this.one("SELECT * FROM `announcements` WHERE `id` = ?", [r.insertId]);
  }

  async updateAnnouncement(ctx: any, id: number, b: any) {
    const row = await this.one("SELECT * FROM `announcements` WHERE `id` = ?", [id]);
    if (!row) throw notFound("公告不存在");
    if (b?.title !== undefined && !String(b.title).trim()) throw bad("标题不能为空");
    if (b?.status !== undefined && !BANNER_STATUS.includes(b.status)) throw bad("状态只能为 on / off");
    if (b?.audience !== undefined && !ANNOUNCE_AUDIENCE.includes(b.audience)) throw bad("公告可见范围不合法");
    await this.ds.query(
      "UPDATE `announcements` SET `title` = ?, `content` = ?, `audience` = ?, `pinned` = ?, `status` = ? WHERE `id` = ?",
      [b?.title !== undefined ? String(b.title).trim() : row.title,
        b?.content !== undefined ? b.content : row.content,
        b?.audience !== undefined ? b.audience : row.audience,
        b?.pinned !== undefined ? (b.pinned ? 1 : 0) : row.pinned,
        b?.status !== undefined ? b.status : row.status, row.id],
    );
    await audit(this.ds, ctx, "admin.announcement.update", "announcements:" + row.id, { before: row, after: b });
    if (b?.push) {
      const audience = b.audience || row.audience;
      const users = await this.ds.query("SELECT `id` FROM `users` WHERE `role` = ? OR ? = 'all'", [audience, audience]);
      for (const u of users) await notify(this.ds, Number(u.id), b.title || row.title, b.content || row.content || "", "notice");
    }
    return this.one("SELECT * FROM `announcements` WHERE `id` = ?", [row.id]);
  }

  async toggleAnnouncement(ctx: any, id: number) {
    const row = await this.one("SELECT * FROM `announcements` WHERE `id` = ?", [id]);
    if (!row) throw notFound("公告不存在");
    const next = row.status === "on" ? "off" : "on";
    await this.ds.query("UPDATE `announcements` SET `status` = ? WHERE `id` = ?", [next, row.id]);
    await audit(this.ds, ctx, "admin.announcement.toggle", "announcements:" + row.id, { status: next });
    return { id: Number(row.id), status: next };
  }

  async pinAnnouncement(ctx: any, id: number) {
    const row = await this.one("SELECT * FROM `announcements` WHERE `id` = ?", [id]);
    if (!row) throw notFound("公告不存在");
    const next = Number(row.pinned) ? 0 : 1;
    await this.ds.query("UPDATE `announcements` SET `pinned` = ? WHERE `id` = ?", [next, row.id]);
    await audit(this.ds, ctx, "admin.announcement.pin", "announcements:" + row.id, { pinned: next });
    return { id: Number(row.id), pinned: !!next };
  }

  async deleteAnnouncement(ctx: any, id: number) {
    const row = await this.one("SELECT * FROM `announcements` WHERE `id` = ?", [id]);
    if (!row) throw notFound("公告不存在");
    await this.ds.query("DELETE FROM `announcements` WHERE `id` = ?", [row.id]);
    await audit(this.ds, ctx, "admin.announcement.delete", "announcements:" + row.id, { title: row.title });
    return { ok: true };
  }

  async coupons() {
    return this.ds.query("SELECT * FROM `coupons` ORDER BY `id` DESC");
  }

  async createCoupon(ctx: any, b: any) {
    if (!b?.name || !(Number(b?.amount) > 0)) throw bad("请填写优惠券名称与金额");
    const status = BANNER_STATUS.includes(b?.status) ? b.status : "on";
    const r = await this.ds.query(
      "INSERT INTO `coupons` (`name`,`amount`,`threshold`,`total`,`claimed`,`valid_from`,`valid_to`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?)",
      [b.name, Math.round(Number(b.amount)), Math.round(Number(b.threshold || 0)), Number(b.total || 0), 0,
        b.validFrom || null, b.validTo || null, status, nowIso()],
    );
    await audit(this.ds, ctx, "admin.coupon.create", "coupons:" + r.insertId);
    return this.one("SELECT * FROM `coupons` WHERE `id` = ?", [r.insertId]);
  }

  async updateCoupon(ctx: any, id: number, b: any) {
    const row = await this.one("SELECT * FROM `coupons` WHERE `id` = ?", [id]);
    if (!row) throw notFound("优惠券不存在");
    if (b?.status !== undefined && !BANNER_STATUS.includes(b.status)) throw bad("状态只能为 on / off");
    if (b?.name !== undefined && !String(b.name).trim()) throw bad("名称不能为空");
    const amount = b?.amount !== undefined ? Math.round(Number(b.amount)) : Number(row.amount);
    const threshold = b?.threshold !== undefined ? Math.round(Number(b.threshold)) : Number(row.threshold);
    if (!(amount > 0)) throw bad("优惠金额必须大于 0");
    if (threshold < 0) throw bad("使用门槛不能为负数");
    const total = b?.total !== undefined ? Number(b.total) : Number(row.total);
    if (total > 0 && total < Number(row.claimed)) throw biz("BAD_TOTAL", "发行总量不可小于已领取数量（" + Number(row.claimed) + " 张）");
    await this.ds.query(
      "UPDATE `coupons` SET `name` = ?, `amount` = ?, `threshold` = ?, `total` = ?, `valid_from` = ?, `valid_to` = ?, `status` = ? WHERE `id` = ?",
      [b?.name !== undefined ? String(b.name).trim() : row.name, amount, threshold, total,
        b?.validFrom !== undefined ? (b.validFrom || null) : row.valid_from,
        b?.validTo !== undefined ? (b.validTo || null) : row.valid_to,
        b?.status !== undefined ? b.status : row.status, row.id],
    );
    await audit(this.ds, ctx, "admin.coupon.update", "coupons:" + row.id, { before: row, after: b });
    return this.one("SELECT * FROM `coupons` WHERE `id` = ?", [row.id]);
  }

  async toggleCoupon(ctx: any, id: number) {
    const row = await this.one("SELECT * FROM `coupons` WHERE `id` = ?", [id]);
    if (!row) throw notFound("优惠券不存在");
    const next = row.status === "on" ? "off" : "on";
    await this.ds.query("UPDATE `coupons` SET `status` = ? WHERE `id` = ?", [next, row.id]);
    await audit(this.ds, ctx, "admin.coupon.toggle", "coupons:" + row.id, { status: next });
    return { id: Number(row.id), status: next };
  }

  /* ---------------- 审计日志 ---------------- */
  async auditLogs(query: any) {
    const pg = paging(query, { defaultSize: 300 });
    const total = await this.cnt("SELECT COUNT(*) AS c FROM `audit_logs`");
    const list = await this.ds.query(
      `SELECT a.*, u.\`nickname\` FROM \`audit_logs\` a LEFT JOIN \`users\` u ON u.id = a.actor_id
       ORDER BY a.\`id\` DESC LIMIT ? OFFSET ?`,
      [pg.pageSize, pg.offset],
    );
    return pagedResult(list, total, pg);
  }

  /* ---------------- 区域 ---------------- */
  async regions() {
    return this.ds.query("SELECT * FROM `regions` ORDER BY `id`");
  }

  async createRegion(ctx: any, b: any) {
    if (!String(b?.name || "").trim()) throw bad("请填写片区名称");
    const code = String(b.code || "").trim() || "R" + Date.now().toString().slice(-6);
    if (await this.one("SELECT `id` FROM `regions` WHERE `code` = ?", [code])) throw biz("CODE_EXISTS", "片区编码已存在");
    const r = await this.ds.query(
      "INSERT INTO `regions` (`name`,`code`,`center_lat`,`center_lng`,`radius_km`,`polygon`,`created_at`) VALUES (?,?,?,?,?,?,?)",
      [String(b.name).trim(), code, Number(b.centerLat ?? b.lat ?? 0), Number(b.centerLng ?? b.lng ?? 0),
        Number(b.radiusKm ?? 5), b.polygon ? JSON.stringify(b.polygon) : null, nowIso()],
    );
    await audit(this.ds, ctx, "admin.region.create", "regions:" + r.insertId, { code });
    return this.one("SELECT * FROM `regions` WHERE `id` = ?", [r.insertId]);
  }
}
