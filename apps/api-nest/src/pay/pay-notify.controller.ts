import { Controller, HttpCode, HttpException, HttpStatus, Logger, Post, Req } from "@nestjs/common";
import { Public } from "../public.decorator";
import { OrdersService } from "../order/orders.service";

/**
 * 支付渠道回调（微信支付 v3）。
 *
 * 安全模型：**免令牌，只靠验签**——
 *   - 报文必须与签名逐个字节一致，所以从 `req.rawBody` 取原文（main.ts 里做了 rawBody 采集）；
 *   - 验签/解密/金额校验由 PayProvider 完成，失败一律返回非 2xx，让渠道重试；
 *   - 成功后只回 `{code:"SUCCESS"}`，不回显任何订单信息（避免把内部数据交给回调发起方）。
 */
@Controller("pay")
export class PayNotifyController {
  private readonly log = new Logger("PayNotify");
  constructor(private readonly orders: OrdersService) {}

  @Public()
  @Post("wechat/notify")
  @HttpCode(200)
  async wechatNotify(@Req() req: any) {
    const rawBody: string = req.rawBody
      ? req.rawBody.toString("utf8")
      : typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body ?? {});
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      const key = k.toLowerCase();
      if (key.startsWith("wechatpay-")) headers[key] = Array.isArray(v) ? String(v[0]) : String(v);
    }

    try {
      const r: any = await this.orders.settlePayNotify(rawBody, headers);
      if (r?.idempotent) this.log.log("回调重复投递，已幂等忽略：" + r.orderId);
      else if (r?.ignored) this.log.log("回调非成功状态（" + r.tradeState + "），不入账：" + r.outTradeNo);
      else if (r?.settled) this.log.log("回调入账成功：订单 " + r.orderId);
      return { code: "SUCCESS", message: "成功" };
    } catch (e: any) {
      this.log.error("支付回调处理失败：" + (e?.message || e));
      throw new HttpException({ code: "FAIL", message: String(e?.message || "回调处理失败").slice(0, 200) }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
