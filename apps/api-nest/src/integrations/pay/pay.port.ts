/** 支付通道端口：下单预支付 / 回调验签 / 退款。业务层只依赖这个接口，不关心是哪家渠道 */

export interface PrepayInput {
  /** 我方商户单号（本项目用订单号，保证与 payments 表一一对应） */
  outTradeNo: string;
  /** 金额（整数分） */
  amountCents: number;
  /** 商品描述（微信有长度限制，取订单标题前 40 字） */
  description: string;
  /** 微信 JSAPI 必需：付款人 openid */
  openId: string;
  /** 回调地址（必须公网 HTTPS，且不带参数） */
  notifyUrl: string;
  attach?: string;
}

export interface PrepayResult {
  prepayId: string;
  /** 前端直接拿去唤起支付的参数 */
  params: {
    appId: string;
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType: "RSA";
    paySign: string;
  };
}

export interface NotifyResult {
  outTradeNo: string;
  transactionId: string;
  amountCents: number;
  /** 渠道交易状态（微信：SUCCESS / REFUND / NOTPAY / CLOSED …） */
  tradeState: string;
  success: boolean;
  attach?: string;
}

export interface RefundInput {
  outTradeNo: string;
  outRefundNo: string;
  refundCents: number;
  totalCents: number;
  reason?: string;
}

export interface RefundResult {
  refundId: string;
  status: string;
}

export interface PayProvider {
  readonly name: string;
  createPrepay(input: PrepayInput): Promise<PrepayResult>;
  /** 验签失败必须抛错（不得返回 success=false 蒙过去） */
  verifyNotify(bodyText: string, headers: Record<string, string | undefined>): Promise<NotifyResult>;
  refund(input: RefundInput): Promise<RefundResult>;
  /** 关闭未支付的渠道单（超时关单时调用；已支付/已关闭的重复关闭应当幂等，不抛错） */
  close(outTradeNo: string): Promise<void>;
}

/** 环境变量里的 PEM 常用 `\n` 转义写法，这里统一还原，避免密钥解析失败 */
export function unescapePem(v: string | undefined): string {
  if (!v) return "";
  return String(v).replace(/\\n/g, "\n").trim();
}
