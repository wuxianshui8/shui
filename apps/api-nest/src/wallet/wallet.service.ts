// 钱包提现（需求 5.4）与发票申请（需求 4.1.6）
import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { bad, biz, forbidden, notFound } from "../common/errors";
import { nowIso } from "../common/reply";
import { maskPhone } from "../common/geo";
import { audit, notify } from "../common/audit";
import { applyRate, walletAdd, walletSnapshot } from "../common/ledger";
import { RuleConfigService } from "../rules/rule-config.service";

function rand(n: number) {
  const A = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
const invoiceNo = () => "FP" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + rand(8);

@Injectable()
export class WalletService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RuleConfigService,
  ) {}

  /* ---------------- 提现 ---------------- */
  async withdrawals(uid: number) {
    return {
      list: await this.ds.query("SELECT * FROM `withdrawals` WHERE `user_id` = ? ORDER BY `id` DESC LIMIT 50", [uid]),
      wallet: await walletSnapshot(this.ds, uid),
      rule: await this.rules.get("settlement"),
    };
  }

  async applyWithdrawal(ctx: any, b: any, idemKey?: string) {
    const uid = Number(ctx.user.uid);
    const cfg = (await this.rules.get("settlement")) as any;
    const amount = Math.round(Number(b?.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw bad("请输入提现金额");
    if (amount < Number(cfg.min_withdraw ?? 10000)) {
      throw biz("BELOW_MIN", "最低提现金额 ¥" + (Number(cfg.min_withdraw ?? 10000) / 100).toFixed(2));
    }
    const w = await walletSnapshot(this.ds, uid);
    if (amount > w.balance) throw biz("INSUFFICIENT_BALANCE", "可提现余额不足");
    if (!b?.account) throw bad("请填写收款账号");

    const fee = applyRate(amount, Number(cfg.withdraw_fee_rate ?? 0));
    const actual = amount - fee;

    return this.ds.transaction(async (m) => {
      // 幂等重放：同一 X-Idem-Key 的重复请求返回首次结果，而不是因唯一索引报 400
      if (idemKey) {
        const replay = (await m.query("SELECT * FROM `withdrawals` WHERE `idem_key` = ? LIMIT 1", [idemKey]))[0];
        if (replay) return replay;
      }
      const r = await m.query(
        "INSERT INTO `withdrawals` (`user_id`,`role`,`amount`,`fee`,`actual`,`channel`,`account`,`status`,`idem_key`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [uid, ctx.user.role, amount, fee, actual, b.channel || "wechat", maskPhone(b.account), "pending", idemKey ?? null, nowIso()],
      );
      await walletAdd(m, uid, -amount, {
        type: "withdraw",
        remark: "提现申请 ¥" + (amount / 100).toFixed(2) + "（手续费 ¥" + (fee / 100).toFixed(2) + "）",
      });
      await notify(m, uid, "提现申请已提交", "提现 ¥" + (actual / 100).toFixed(2) + " 待平台审核打款", "payment", "/wallet");
      await audit(m, ctx, "withdraw.apply", "withdrawals:" + r.insertId, { amount, fee });
      return (await m.query("SELECT * FROM `withdrawals` WHERE `id` = ?", [r.insertId]))[0];
    });
  }

  /** 后台审核：通过则累计 total_withdraw；驳回则原路退回可用余额 */
  async reviewWithdrawal(ctx: any, id: number, approve: boolean, reason?: string) {
    return this.ds.transaction(async (m) => {
      // 行锁 + 事务内状态复查：连点/重试/批准与驳回并发时只允许一次生效，驳回退回余额不会重复执行
      const w = (await m.query("SELECT * FROM `withdrawals` WHERE `id` = ? FOR UPDATE", [id]))[0];
      if (!w) throw notFound("提现申请不存在");
      if (w.status !== "pending") throw biz("BAD_STATUS", "该申请已处理");
      if (approve) {
        const upd = await m.query("UPDATE `withdrawals` SET `status` = 'paid', `reviewed_by` = ?, `reviewed_at` = ? WHERE `id` = ? AND `status` = 'pending'",
          [Number(ctx.user.uid), nowIso(), w.id]);
        if (!Number(upd?.affectedRows ?? 1)) throw biz("BAD_STATUS", "该申请已处理");
        await m.query("UPDATE `wallets` SET `total_withdraw` = `total_withdraw` + ?, `updated_at` = ? WHERE `user_id` = ?",
          [Number(w.amount), nowIso(), w.user_id]);
        await notify(m, Number(w.user_id), "提现已打款", "¥" + (Number(w.actual) / 100).toFixed(2) + " 已打款至您的账户", "payment", "/wallet");
      } else {
        const why = reason || "不符合提现条件";
        const upd = await m.query("UPDATE `withdrawals` SET `status` = 'rejected', `reject_reason` = ?, `reviewed_by` = ?, `reviewed_at` = ? WHERE `id` = ? AND `status` = 'pending'",
          [why, Number(ctx.user.uid), nowIso(), w.id]);
        if (!Number(upd?.affectedRows ?? 1)) throw biz("BAD_STATUS", "该申请已处理");
        await walletAdd(m, Number(w.user_id), Number(w.amount), {
          type: "withdraw_refund", remark: "提现驳回退回 ¥" + (Number(w.amount) / 100).toFixed(2),
        });
        await notify(m, Number(w.user_id), "提现被驳回", "原因：" + why + "，金额已退回余额", "payment", "/wallet");
      }
      await audit(m, ctx, "admin.withdraw.review", "withdrawals:" + w.id, { approve });
      return { status: approve ? "paid" : "rejected" };
    });
  }

  /* ---------------- 发票（需求 4.1.6）---------------- */
  async applyInvoice(ctx: any, b: any) {
    const uid = Number(ctx.user.uid);
    const orderId = Number(b?.orderId);
    if (!orderId) throw bad("请选择需要开票的订单");
    const order = (await this.ds.query("SELECT * FROM `orders` WHERE `id` = ? LIMIT 1", [orderId]))[0];
    if (!order) throw notFound("订单不存在");
    if (Number(order.parent_id) !== uid) throw forbidden("只能为本人订单申请开票");
    if (!order.paid_at) throw biz("NOT_PAID", "该订单尚未支付，无法开票");
    if (["cancelled", "refunded", "refunding", "awaiting_payment"].includes(order.status)) {
      throw biz("NOT_INVOICEABLE", "该订单状态不支持开票");
    }
    const exist = (await this.ds.query("SELECT * FROM `invoices` WHERE `order_id` = ? AND `status` <> 'rejected' LIMIT 1", [order.id]))[0];
    if (exist) throw biz("ALREADY_INVOICED", "该订单已提交过开票申请（" + exist.invoice_no + "），请勿重复提交");

    const titleType = b?.titleType === "company" ? "company" : "personal";
    const title = String(b?.title || "").trim();
    if (!title) throw bad("请填写发票抬头");
    const taxNo = String(b?.taxNo || "").trim();
    if (titleType === "company" && !/^[0-9A-Z]{15,20}$/.test(taxNo)) {
      throw bad("企业抬头需填写 15-20 位纳税人识别号");
    }
    const email = String(b?.email || "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("邮箱格式不正确");

    const amount = Number(order.amount) + Number(order.urgent_fee);
    return this.ds.transaction(async (m) => {
      const r = await m.query(
        "INSERT INTO `invoices` (`invoice_no`,`order_id`,`user_id`,`title_type`,`title`,`tax_no`,`email`,`amount`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [invoiceNo(), order.id, uid, titleType, title, titleType === "company" ? taxNo : null, email || null, amount, "pending", nowIso()],
      );
      for (const a of await m.query("SELECT `id` FROM `users` WHERE `role` = 'admin'")) {
        await notify(m, Number(a.id), "收到发票申请",
          "订单 " + order.order_no + " 申请开票 ¥" + (amount / 100).toFixed(2) + "（" + title + "）", "payment");
      }
      await audit(m, ctx, "invoice.apply", "invoices:" + r.insertId, { orderId: order.id, amount });
      return (await m.query("SELECT * FROM `invoices` WHERE `id` = ?", [r.insertId]))[0];
    });
  }

  async reviewInvoice(ctx: any, id: number, approve: boolean, b: any) {
    const inv = (await this.ds.query("SELECT * FROM `invoices` WHERE `id` = ? LIMIT 1", [id]))[0];
    if (!inv) throw notFound("发票申请不存在");
    if (inv.status !== "pending") throw biz("BAD_STATUS", "该申请已受理（" + inv.status + "）");
    return this.ds.transaction(async (m) => {
      if (approve) {
        const url = String(b?.invoiceUrl || "").trim();
        await m.query(
          "UPDATE `invoices` SET `status` = 'issued', `invoice_url` = ?, `handled_by` = ?, `handled_at` = ?, `reject_reason` = NULL WHERE `id` = ?",
          [url || null, Number(ctx.user.uid), nowIso(), inv.id],
        );
        await notify(m, Number(inv.user_id), "发票已开具",
          "申请单 " + inv.invoice_no + " 已开票成功（¥" + (Number(inv.amount) / 100).toFixed(2) + "）" +
          (url ? "，下载地址：" + url : "，电子发票请留意邮箱"), "payment", "/wallet");
      } else {
        const reason = String(b?.rejectReason || "").trim();
        if (!reason) throw bad("驳回需填写原因");
        await m.query("UPDATE `invoices` SET `status` = 'rejected', `reject_reason` = ?, `handled_by` = ?, `handled_at` = ? WHERE `id` = ?",
          [reason, Number(ctx.user.uid), nowIso(), inv.id]);
        await notify(m, Number(inv.user_id), "发票申请被驳回",
          "申请单 " + inv.invoice_no + " 驳回原因：" + reason + "，可修改后重新申请", "payment", "/wallet");
      }
      await audit(m, ctx, "admin.invoice.review", "invoices:" + inv.id, { approve, invoiceUrl: b?.invoiceUrl || null });
      return (await m.query("SELECT * FROM `invoices` WHERE `id` = ?", [inv.id]))[0];
    });
  }
}
