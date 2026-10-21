import { Body, Controller, Get, Headers, HttpCode, Post, Query, Req } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { ok } from "../common/reply";
import { Roles } from "../common/access";
import { walletSnapshot } from "../common/ledger";
import { RuleConfigService } from "../rules/rule-config.service";
import { WalletService } from "./wallet.service";

/** 钱包、提现与发票（教员 / 业务员 / 代理 / 家长共用，需求 4.1.6 / 5.4） */
@Controller()
export class WalletController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RuleConfigService,
    private readonly svc: WalletService,
  ) {}

  private ctx(req: any) {
    return { user: req.user, ip: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString() };
  }

  @Get("wallet")
  async wallet(@Req() req: any) {
    const uid = Number(req.user.uid);
    return ok({
      wallet: await walletSnapshot(this.ds, uid),
      rule: await this.rules.get("settlement"),
      txns: await this.ds.query(
        "SELECT t.*, o.`order_no` FROM `wallet_txns` t LEFT JOIN `orders` o ON o.id = t.order_id WHERE t.`user_id` = ? ORDER BY t.`id` DESC LIMIT 50",
        [uid],
      ),
      // 发票：我的申请单 + 可开票订单（需求 4.1.6）
      invoices: await this.ds.query(
        `SELECT i.*, o.\`order_no\`, o.\`subject\`, o.\`stage\` FROM \`invoices\` i
         LEFT JOIN \`orders\` o ON o.id = i.order_id
         WHERE i.\`user_id\` = ? ORDER BY i.\`id\` DESC LIMIT 50`,
        [uid],
      ),
      invoiceable: await this.ds.query(
        `SELECT o.\`id\`, o.\`order_no\`, o.\`subject\`, o.\`stage\`, o.\`lesson_time\`, o.\`status\`,
                (o.\`amount\` + o.\`urgent_fee\`) AS \`payable\`, o.\`paid_at\`
         FROM \`orders\` o
         WHERE o.\`parent_id\` = ? AND o.\`paid_at\` IS NOT NULL
           AND o.\`status\` NOT IN ('refunded','refunding','cancelled','awaiting_payment')
           AND NOT EXISTS (SELECT 1 FROM \`invoices\` i WHERE i.\`order_id\` = o.\`id\` AND i.\`status\` <> 'rejected')
         ORDER BY o.\`id\` DESC LIMIT 50`,
        [uid],
      ),
    });
  }

  @Get("wallet/txns")
  async txns(@Query("type") type: string, @Req() req: any) {
    const uid = Number(req.user.uid);
    return ok(
      type
        ? await this.ds.query("SELECT * FROM `wallet_txns` WHERE `user_id` = ? AND `type` = ? ORDER BY `id` DESC LIMIT 200", [uid, type])
        : await this.ds.query("SELECT * FROM `wallet_txns` WHERE `user_id` = ? ORDER BY `id` DESC LIMIT 200", [uid]),
    );
  }

  /* ---------------- 提现（幂等：X-Idem-Key）---------------- */
  @Get("withdrawals")
  async withdrawals(@Req() req: any) {
    return ok(await this.svc.withdrawals(Number(req.user.uid)));
  }

  @Post("withdrawals")
  @HttpCode(200)
  @Roles("teacher", "sales", "agent")
  async applyWithdrawal(@Body() body: any, @Headers("x-idem-key") idem: string, @Req() req: any) {
    return ok(await this.svc.applyWithdrawal(this.ctx(req), body, idem));
  }

  /* ---------------- 发票申请（仅家长为自己订单申请）---------------- */
  @Post("invoices")
  @HttpCode(200)
  @Roles("parent")
  async applyInvoice(@Body() body: any, @Req() req: any) {
    return ok(await this.svc.applyInvoice(this.ctx(req), body));
  }
}
