import { createDecipheriv, createSign, createVerify, randomBytes } from "node:crypto";
import { looksPlaceholder } from "../sms/sms.port"; // 复用同一套「占位串视为未配置」判定
import {
  unescapePem,
  type NotifyResult,
  type PayProvider,
  type PrepayInput,
  type PrepayResult,
  type RefundInput,
  type RefundResult,
} from "./pay.port";

const API_BASE = "https://api.mch.weixin.qq.com";

export interface WechatPayConfig {
  appId: string;
  mchId: string;
  /** 商户 API 证书序列号 */
  serialNo: string;
  /** 商户 API 私钥（PEM） */
  privateKey: string;
  /** APIv3 密钥（32 字符，用于回调 resource 解密） */
  apiV3Key: string;
  /** 微信支付平台证书公钥（PEM，用于回调验签） */
  platformPublicKey: string;
  notifyUrl: string;
  /** 回调时间戳容忍秒数，默认 300 */
  maxSkewSeconds?: number;
}

const REQUIRED: [keyof WechatPayConfig, string][] = [
  ["appId", "WECHAT_PAY_APP_ID"],
  ["mchId", "WECHAT_PAY_MCH_ID"],
  ["serialNo", "WECHAT_PAY_SERIAL_NO"],
  ["privateKey", "WECHAT_PAY_PRIVATE_KEY"],
  ["apiV3Key", "WECHAT_PAY_APIV3_KEY"],
  ["platformPublicKey", "WECHAT_PAY_PLATFORM_PUBLIC_KEY"],
  ["notifyUrl", "WECHAT_PAY_NOTIFY_URL"],
];

export function wechatConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WechatPayConfig {
  const raw: Record<string, string | undefined> = {};
  const missing: string[] = [];
  for (const [key, envName] of REQUIRED) {
    const v = env[envName];
    if (looksPlaceholder(v)) missing.push(envName);
    raw[key] = v;
  }
  if (missing.length) {
    throw new Error("微信支付缺少有效配置：" + missing.join("、") + "（占位串视为未配置）");
  }
  const cfg: WechatPayConfig = {
    appId: String(raw.appId).trim(),
    mchId: String(raw.mchId).trim(),
    serialNo: String(raw.serialNo).trim(),
    privateKey: unescapePem(raw.privateKey),
    apiV3Key: String(raw.apiV3Key).trim(),
    platformPublicKey: unescapePem(raw.platformPublicKey),
    notifyUrl: String(raw.notifyUrl).trim(),
    maxSkewSeconds: Number(env.WECHAT_PAY_MAX_SKEW_SECONDS || 300),
  };
  if (Buffer.byteLength(cfg.apiV3Key, "utf8") !== 32) {
    throw new Error("WECHAT_PAY_APIV3_KEY 必须是 32 字节（当前 " + Buffer.byteLength(cfg.apiV3Key, "utf8") + "）");
  }
  if (!/^https:\/\//.test(cfg.notifyUrl)) {
    throw new Error("WECHAT_PAY_NOTIFY_URL 必须是公网 HTTPS 地址（当前 " + cfg.notifyUrl + "）");
  }
  return cfg;
}

/* ---------------- 签名 / 验签 / 解密（纯函数，便于单测） ---------------- */

/** 商户私钥签名：base64(RSA-SHA256(message)) */
export function signMessage(privateKey: string, message: string): string {
  const s = createSign("RSA-SHA256");
  s.update(message, "utf8");
  s.end();
  return s.sign(privateKey, "base64");
}

export function verifySignature(publicKey: string, message: string, signature: string): boolean {
  try {
    const v = createVerify("RSA-SHA256");
    v.update(message, "utf8");
    v.end();
    return v.verify(publicKey, String(signature || ""), "base64");
  } catch {
    return false;
  }
}

/** Authorization 头：签名串 = METHOD\nURL_PATH\ntimestamp\nnonce\nbody\n */
export function wechatAuthorization(
  cfg: Pick<WechatPayConfig, "mchId" | "serialNo" | "privateKey">,
  p: { method: string; urlPath: string; body: string; timestamp: number; nonce: string },
): string {
  const message = [p.method.toUpperCase(), p.urlPath, String(p.timestamp), p.nonce, p.body, ""].join("\n");
  const signature = signMessage(cfg.privateKey, message);
  return (
    'WECHATPAY2-SHA256-RSA2048 mchid="' +
    cfg.mchId +
    '",nonce_str="' +
    p.nonce +
    '",signature="' +
    signature +
    '",timestamp="' +
    p.timestamp +
    '",serial_no="' +
    cfg.serialNo +
    '"'
  );
}

/** JSAPI 唤起参数：paySign 的签名串 = appId\ntimeStamp\nnonceStr\npackage\n */
export function jsapiPayParams(p: {
  appId: string;
  prepayId: string;
  privateKey: string;
  timeStamp?: number;
  nonceStr?: string;
}): PrepayResult["params"] {
  const timeStamp = String(p.timeStamp ?? Math.floor(Date.now() / 1000));
  const nonceStr = p.nonceStr || randomBytes(16).toString("hex");
  const packageStr = "prepay_id=" + p.prepayId;
  const paySign = signMessage(p.privateKey, [p.appId, timeStamp, nonceStr, packageStr, ""].join("\n"));
  return { appId: p.appId, timeStamp, nonceStr, package: packageStr, signType: "RSA", paySign };
}

/** 回调 resource 解密：AEAD_AES_256_GCM，密文尾部 16 字节为 authTag */
export function decryptNotificationResource(
  apiV3Key: string,
  resource: { ciphertext: string; nonce: string; associated_data?: string },
): string {
  const buf = Buffer.from(resource.ciphertext, "base64");
  if (buf.length <= 16) throw new Error("回调密文长度不足");
  const data = buf.subarray(0, buf.length - 16);
  const authTag = buf.subarray(buf.length - 16);
  const d = createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key, "utf8"), Buffer.from(resource.nonce, "utf8"));
  d.setAuthTag(authTag);
  if (resource.associated_data) d.setAAD(Buffer.from(resource.associated_data, "utf8"));
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

/** 回调验签：签名串 = timestamp\nnonce\nbody\n，并做时间戳偏移检查（防重放） */
export function verifyNotification(
  cfg: WechatPayConfig,
  bodyText: string,
  headers: Record<string, string | undefined>,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  const get = (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? headers[k.toUpperCase()];
  const ts = get("Wechatpay-Timestamp");
  const nonce = get("Wechatpay-Nonce");
  const signature = get("Wechatpay-Signature");
  if (!ts || !nonce || !signature) throw new Error("回调缺少 Wechatpay-* 签名字段");
  const skew = Math.abs(nowSec - Number(ts));
  const maxSkew = cfg.maxSkewSeconds ?? 300;
  if (!Number.isFinite(skew) || skew > maxSkew) throw new Error("回调时间戳超出容忍范围（" + skew + "s > " + maxSkew + "s）");
  const message = ts + "\n" + nonce + "\n" + bodyText + "\n";
  if (!verifySignature(cfg.platformPublicKey, message, signature)) throw new Error("回调验签失败");
}

/* ---------------- 微信支付 v3 实现 ---------------- */

export class WechatPayProvider implements PayProvider {
  readonly name = "wechat";
  private readonly cfg: WechatPayConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: WechatPayConfig, fetchImpl: typeof fetch = globalThis.fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  private async request(method: string, urlPath: string, payload?: any): Promise<any> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString("hex");
    const authorization = wechatAuthorization(this.cfg, { method, urlPath, body, timestamp, nonce });
    const res = await this.fetchImpl(API_BASE + urlPath, {
      method,
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "jiajiao-api-nest/1.0",
      },
      body: body === "" ? undefined : body,
    });
    const text = await res.text();
    if (!res.ok) {
      let code = "";
      let message = "";
      try {
        const j = JSON.parse(text);
        code = j?.code || "";
        message = j?.message || "";
      } catch {
        message = text.slice(0, 200);
      }
      throw new Error("微信支付 " + urlPath + " 失败（HTTP " + res.status + "）" + (code ? " " + code : "") + (message ? " " + message : ""));
    }
    return text ? JSON.parse(text) : {};
  }

  async createPrepay(input: PrepayInput): Promise<PrepayResult> {
    const payload: any = {
      appid: this.cfg.appId,
      mchid: this.cfg.mchId,
      description: String(input.description || "家教服务").slice(0, 40),
      out_trade_no: input.outTradeNo,
      notify_url: input.notifyUrl || this.cfg.notifyUrl,
      amount: { total: Math.round(input.amountCents), currency: "CNY" },
      payer: { openid: input.openId },
    };
    if (input.attach) payload.attach = String(input.attach).slice(0, 128);
    const r = await this.request("POST", "/v3/pay/transactions/jsapi", payload);
    if (!r?.prepay_id) throw new Error("微信支付下单未返回 prepay_id");
    return { prepayId: String(r.prepay_id), params: jsapiPayParams({ appId: this.cfg.appId, prepayId: String(r.prepay_id), privateKey: this.cfg.privateKey }) };
  }

  async verifyNotify(bodyText: string, headers: Record<string, string | undefined>): Promise<NotifyResult> {
    verifyNotification(this.cfg, bodyText, headers);
    let json: any;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new Error("回调体不是合法 JSON");
    }
    const res = json?.resource;
    if (!res?.ciphertext) throw new Error("回调缺少 resource.ciphertext");
    const plain = decryptNotificationResource(this.cfg.apiV3Key, res);
    const data = JSON.parse(plain);
    const amountCents = Number(data?.amount?.total);
    if (!data?.out_trade_no || !Number.isInteger(amountCents)) throw new Error("解密后的回调缺少 out_trade_no / amount.total");
    const tradeState = String(data.trade_state || "UNKNOWN");
    return {
      outTradeNo: String(data.out_trade_no),
      transactionId: String(data.transaction_id || ""),
      amountCents,
      tradeState,
      success: tradeState === "SUCCESS",
      attach: data.attach ? String(data.attach) : undefined,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const payload: any = {
      out_trade_no: input.outTradeNo,
      out_refund_no: input.outRefundNo,
      reason: String(input.reason || "协商退款").slice(0, 80),
      amount: { refund: Math.round(input.refundCents), total: Math.round(input.totalCents), currency: "CNY" },
    };
    const r = await this.request("POST", "/v3/refund/domestic/refunds", payload);
    return { refundId: String(r?.refund_id || ""), status: String(r?.status || "PROCESSING") };
  }
}
