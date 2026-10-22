import type { NotifyResult, PayProvider, PrepayInput, PrepayResult, RefundInput, RefundNotifyResult, RefundResult } from "./pay.port";

/**
 * 未接入真实支付渠道时的实现：**只用于本地/自动化**。
 * 语义刻意与「真实通道成功」对齐，方便后续切换时业务代码不改：
 * - createPrepay 立即给出一个假 prepay_id 与假唤起参数（signType 仍标 RSA，但签名是 MOCK）；
 * - verifyNotify 只做 JSON 解析，不做验签（真实通道必须验签，见 pay.wechat.ts）；
 * - refund 立即成功。
 * 提醒：真实环境禁止使用本实现，`pay.service` 会记录当前通道名，门禁/日志可直接看出来。
 */
export class MockPayProvider implements PayProvider {
  readonly name = "mock";
  readonly prepays: PrepayInput[] = [];
  readonly refunds: RefundInput[] = [];
  readonly closed: string[] = [];

  async createPrepay(input: PrepayInput): Promise<PrepayResult> {
    this.prepays.push(input);
    return {
      prepayId: "mock_prepay_" + input.outTradeNo,
      params: {
        appId: "mock_appid",
        timeStamp: String(Math.floor(Date.now() / 1000)),
        nonceStr: "mocknonce" + input.outTradeNo.slice(-6),
        package: "prepay_id=mock_prepay_" + input.outTradeNo,
        signType: "RSA",
        paySign: "MOCK",
      },
    };
  }

  /** 仅解析 `{ out_trade_no, transaction_id, amount:{total}, trade_state }`，无验签 */
  async verifyNotify(bodyText: string): Promise<NotifyResult> {
    let json: any;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new Error("mock 支付回调不是合法 JSON");
    }
    const amountCents = Number(json?.amount?.total);
    if (!json?.out_trade_no || !Number.isInteger(amountCents)) {
      throw new Error("mock 支付回调缺少 out_trade_no / amount.total");
    }
    const tradeState = String(json.trade_state || json.event_type || "SUCCESS");
    return {
      outTradeNo: String(json.out_trade_no),
      transactionId: String(json.transaction_id || "mock_" + json.out_trade_no),
      amountCents,
      tradeState,
      success: tradeState === "SUCCESS",
      attach: json.attach ? String(json.attach) : undefined,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    this.refunds.push(input);
    return { refundId: "mock_refund_" + input.outRefundNo, status: "SUCCESS" };
  }

  /** mock 没有真实渠道单，关单是空操作（但要记录，便于门禁断言） */
  async close(outTradeNo: string): Promise<void> {
    this.closed.push(String(outTradeNo));
  }

  /** 仅解析 `{ out_refund_no, out_trade_no, refund_id, refund_status, amount:{refund,total} }`，无验签 */
  async verifyRefundNotify(bodyText: string): Promise<RefundNotifyResult> {
    let json: any;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new Error("mock 退款回调不是合法 JSON");
    }
    const refundCents = Number(json?.amount?.refund);
    if (!json?.out_refund_no || !json?.out_trade_no || !Number.isInteger(refundCents)) {
      throw new Error("mock 退款回调缺少 out_refund_no / out_trade_no / amount.refund");
    }
    const refundStatus = String(json.refund_status || "SUCCESS");
    return {
      outTradeNo: String(json.out_trade_no),
      outRefundNo: String(json.out_refund_no),
      refundId: String(json.refund_id || "mock_" + json.out_refund_no),
      refundStatus,
      refundCents,
      success: refundStatus === "SUCCESS",
    };
  }
}
