import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { Roles } from "../common/access";
import { ok, nowIso } from "../common/reply";
import { bad, biz, notFound } from "../common/errors";
import { audit, notify } from "../common/audit";
import { escrowBalance, escrowMove, walletAdd } from "../common/ledger";
import { OrdersService } from "../order/orders.service";
import { WalletService } from "../wallet/wallet.service";
import { RuleConfigService } from "../rules/rule-config.service";

const tradeNo = (p = "RF") => p + Date.now() + Math.floor(Math.random() * 1e6);

/** 平台后台（P6 阶段扩展为完整 9 个模块；此处覆盖总览 / 财务 / 结算 / 退款审核） */
@Controller("admin")
@Roles("admin")
export class AdminController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly orders: OrdersService,
    private readonly wallet: WalletService,
    private readonly rules: RuleConfigService,
  ) {}

  private async num(sql: string, p: any[] = []) {
    return Number((await this.ds.query(sql, p))[0]?.s ?? 0);
  }

  @Get("overview")
  async overview() {
    const today = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);
    return ok({
      metrics: {
        totalUsers: await this.num("SELECT COUNT(*) AS s FROM `users`"),
        todayOrders: await this.num("SELECT COUNT(*) AS s FROM `orders` WHERE `created_at` LIKE ?", [today + "%"]),
        monthGmv: await this.num("SELECT COALESCE(SUM(`amount`),0) AS s FROM `orders` WHERE `paid_at` IS NOT NULL AND `paid_at` LIKE ?", [month + "%"]),
        revenue: await this.num("SELECT COALESCE(SUM(`platform_revenue`),0) AS s FROM `orders` WHERE `status` IN ('completed','settled')"),
        escrow: await escrowBalance(this.ds),
        totalOrders: await this.num("SELECT COUNT(*) AS s FROM `orders`"),
      },
      roleCount: await this.ds.query("SELECT `role`, COUNT(*) AS c FROM `users` GROUP BY `role`"),
      pending: {
        teachers: await this.num("SELECT COUNT(*) AS s FROM `teacher_profiles` WHERE `audit_status` = 'pending'"),
        refunds: await this.num("SELECT COUNT(*) AS s FROM `orders` WHERE `status` = 'refunding'"),
        withdrawals: await this.num("SELECT COUNT(*) AS s FROM `withdrawals` WHERE `status` = 'pending'"),
        riskEvents: await this.num("SELECT COUNT(*) AS s FROM `risk_events` WHERE `status` <> 'closed'"),
      },
      engine: "MySQL",
    });
  }

  /* ---------------- 财务资金（需求 5.4，可对账）---------------- */
  @Get("finance")
  async finance() {
    return ok(await this.orders.financeSummary());
  }

  /* ---------------- 到期结算批处理 ---------------- */
  @Post("settlement/run")
  @HttpCode(200)
  async settlementRun(@Body() body: any, @Req() req: any) {
    const settled = await this.orders.runSettlement(!!body?.force);
    await audit(this.ds, req, "settlement.run", null, { count: settled });
    return ok({ settled, escrowBalance: await escrowBalance(this.ds) });
  }

  /* ---------------- 退款工单 ---------------- */
  @Get("refunds")
  async refunds() {
    const rows = await this.ds.query("SELECT `id` FROM `orders` WHERE `status` IN ('refunding','refunded') ORDER BY `id` DESC LIMIT 100");
    const list = [];
    for (const r of rows) list.push(await this.orders.view((await this.ds.query("SELECT * FROM `orders` WHERE `id` = ?", [r.id]))[0], "parent"));
    return ok(list);
  }

  @Post("refunds/:id/review")
  @HttpCode(200)
  async refundReview(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    const approve = !!body?.approve;
    const status = await this.ds.transaction(async (m) => {
      // 行锁 + 事务内状态复查：并发/重试审批只出账一次
      const o = (await m.query("SELECT * FROM `orders` WHERE `id` = ? FOR UPDATE", [Number(id)]))[0];
      if (!o) throw notFound("订单不存在");
      if (o.status !== "refunding") throw biz("BAD_STATUS", "该订单不在退款审核中");
      if (approve) {
        const paid = Number(o.amount) + Number(o.urgent_fee);
        // 先做状态迁移（带守卫），再出账，避免重复审批导致担保资金二次出账
        const upd = await m.query(
          "UPDATE `orders` SET `status` = 'refunded', `refund_amount` = ?, `cancel_by` = 'admin', `updated_at` = ? WHERE `id` = ? AND `status` = 'refunding'",
          [paid, nowIso(), o.id],
        );
        if (!Number(upd?.affectedRows ?? 1)) throw biz("BAD_STATUS", "该订单不在退款审核中");
        await m.query(
          "INSERT INTO `payments` (`order_id`,`user_id`,`type`,`amount`,`channel`,`trade_no`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?,?)",
          [o.id, o.parent_id, "refund", paid, "wechat_jsapi", tradeNo("RF"), "success", nowIso()],
        );
        await escrowMove(m, Number(o.id), "out", paid, "平台批准退款，担保资金原路退回 " + o.order_no);
        await notify(m, Number(o.parent_id), "退款已通过", "订单 " + o.order_no + " 退款 ¥" + (paid / 100).toFixed(2) + " 已原路退回", "payment");
        await notify(m, Number(o.teacher_id), "订单已退款", "订单 " + o.order_no + " 平台已批准家长退款", "order");
      } else {
        const upd = await m.query("UPDATE `orders` SET `status` = 'pending_class', `updated_at` = ? WHERE `id` = ? AND `status` = 'refunding'", [nowIso(), o.id]);
        if (!Number(upd?.affectedRows ?? 1)) throw biz("BAD_STATUS", "该订单不在退款审核中");
        await notify(m, Number(o.parent_id), "退款未通过", "订单 " + o.order_no + " 退款申请被驳回：" + (body?.reason || "不符合退款条件"), "payment");
      }
      await m.query("UPDATE `complaints` SET `status` = 'closed', `handler_id` = ?, `resolved_at` = ? WHERE `order_id` = ? AND `type` = 'complaint'",
        [Number(req.user.uid), nowIso(), o.id]);
      await audit(m, req, "admin.refund.review", "orders:" + o.id, { approve });
      return approve ? "refunded" : "pending_class";
    });
    return ok({ status });
  }

  /* ---------------- 提现审核 ---------------- */
  @Post("withdrawals/:id/review")
  @HttpCode(200)
  async withdrawalReview(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.wallet.reviewWithdrawal(req, Number(id), !!body?.approve, body?.reason));
  }

  /* ---------------- 发票受理（需求 4.1.6）---------------- */
  @Post("invoices/:id/review")
  @HttpCode(200)
  async invoiceReview(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.wallet.reviewInvoice(req, Number(id), !!body?.approve, body));
  }

  /* ---------------- 上课提醒手动触发（需求 4.1.5）---------------- */
  @Post("reminders/run")
  @HttpCode(200)
  async remindersRun(@Req() req: any) {
    const reminded = await this.orders.runLessonReminders();
    await audit(this.ds, req, "reminder.run", null, { count: reminded });
    return ok({ reminded, remindMinutes: Number((await this.rules.get("notify") as any).lesson_remind_minutes ?? 60) });
  }

  /* ---------------- 业务员奖励批量结算（周结）---------------- */
  @Post("rewards/settle")
  @HttpCode(200)
  async rewardsSettle(@Req() req: any) {
    const pending = await this.ds.query("SELECT * FROM `rewards` WHERE `status` = 'pending'");
    let settled = 0;
    for (const r of pending) {
      await this.ds.transaction(async (m) => {
        const claim = await m.query("UPDATE `rewards` SET `status` = 'settled', `settle_at` = ? WHERE `id` = ? AND `status` = 'pending'", [nowIso(), r.id]);
        if (!claim.affectedRows) return;
        await walletAdd(m, Number(r.sales_id), Number(r.amount), {
          orderId: r.ref_order_id == null ? undefined : Number(r.ref_order_id),
          type: "reward",
          remark: "奖励结算：" + r.type,
        });
        await notify(m, Number(r.sales_id), "奖励已结算", "「" + r.type + "」奖励 ¥" + (Number(r.amount) / 100).toFixed(2) + " 已入账", "payment", "/wallet");
        settled++;
      });
    }
    await audit(this.ds, req, "admin.reward.settle", null, { count: settled });
    return ok({ settled });
  }
}
