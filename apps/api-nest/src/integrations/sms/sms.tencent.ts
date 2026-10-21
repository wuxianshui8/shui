import { createHash, createHmac } from "node:crypto";
import { looksPlaceholder, type SmsSender } from "./sms.port";

const HOST = "sms.tencentcloudapi.com";
const SERVICE = "sms";
const ACTION = "SendSms";
const VERSION = "2021-01-11";

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: string | Buffer, msg: string) => createHmac("sha256", key).update(msg, "utf8").digest();

export interface TencentSmsConfig {
  secretId: string;
  secretKey: string;
  sdkAppId: string;
  signName: string;
  templateId: string;
  region?: string;
}

const REQUIRED: [keyof TencentSmsConfig, string][] = [
  ["secretId", "TENCENT_SMS_SECRET_ID"],
  ["secretKey", "TENCENT_SMS_SECRET_KEY"],
  ["sdkAppId", "TENCENT_SMS_SDK_APP_ID"],
  ["signName", "TENCENT_SMS_SIGN_NAME"],
  ["templateId", "TENCENT_SMS_TEMPLATE_ID"],
];

/** 从环境变量取配置；缺项或仍是占位串时直接抛错（绝不带着半套配置上线） */
export function tencentSmsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TencentSmsConfig {
  const missing: string[] = [];
  for (const [key, envName] of REQUIRED) {
    const v = env[envName];
    if (looksPlaceholder(v)) missing.push(envName);
  }
  if (missing.length) {
    throw new Error("腾讯云短信缺少有效配置：" + missing.join("、") + "（占位串视为未配置）");
  }
  return {
    secretId: String(env.TENCENT_SMS_SECRET_ID).trim(),
    secretKey: String(env.TENCENT_SMS_SECRET_KEY).trim(),
    sdkAppId: String(env.TENCENT_SMS_SDK_APP_ID).trim(),
    signName: String(env.TENCENT_SMS_SIGN_NAME).trim(),
    templateId: String(env.TENCENT_SMS_TEMPLATE_ID).trim(),
    region: (env.TENCENT_SMS_REGION || "ap-guangzhou").trim(),
  };
}

/**
 * TC3-HMAC-SHA256 签名（纯函数，便于单测与人工核对）：
 * canonicalRequest 里的签名头块本身以 \n 结尾，因此与 SignedHeaders 之间会出现空行，这是协议要求。
 */
export function tc3Authorization(cfg: TencentSmsConfig, payload: string, timestampSec: number) {
  const date = new Date(timestampSec * 1000).toISOString().slice(0, 10);
  const contentType = "application/json; charset=utf-8";
  const signedHeaders = "content-type;host";
  const canonicalHeaders = "content-type:" + contentType + "\n" + "host:" + HOST + "\n";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256hex(payload)].join("\n");
  const scope = date + "/" + SERVICE + "/tc3_request";
  const stringToSign = ["TC3-HMAC-SHA256", String(timestampSec), scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac("TC3" + cfg.secretKey, date);
  const kService = hmac(kDate, SERVICE);
  const kSigning = hmac(kService, "tc3_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    date,
    contentType,
    canonicalRequest,
    stringToSign,
    signature,
    header:
      "TC3-HMAC-SHA256 Credential=" + cfg.secretId + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
  };
}

export class TencentSmsSender implements SmsSender {
  readonly name = "tencent";
  private readonly cfg: TencentSmsConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: TencentSmsConfig, fetchImpl: typeof fetch = globalThis.fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  async sendCode(phone: string, code: string, ttlSec: number): Promise<void> {
    const payload = JSON.stringify({
      PhoneNumberSet: ["+86" + phone],
      SmsSdkAppId: this.cfg.sdkAppId,
      SignName: this.cfg.signName,
      TemplateId: this.cfg.templateId,
      // 模板变量：1=验证码，2=有效期（分钟），须与腾讯云控制台模板一致
      TemplateParamSet: [code, String(Math.max(1, Math.round(ttlSec / 60)))],
    });
    const ts = Math.floor(Date.now() / 1000);
    const auth = tc3Authorization(this.cfg, payload, ts);

    const res = await this.fetchImpl("https://" + HOST, {
      method: "POST",
      headers: {
        Authorization: auth.header,
        "Content-Type": auth.contentType,
        "X-TC-Action": ACTION,
        "X-TC-Timestamp": String(ts),
        "X-TC-Version": VERSION,
        "X-TC-Region": this.cfg.region || "ap-guangzhou",
      },
      body: payload,
    });

    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("腾讯云短信返回非 JSON（HTTP " + res.status + "）");
    }
    const r = json?.Response ?? {};
    if (r.Error) throw new Error("腾讯云短信失败：" + (r.Error.Code || "UNKNOWN") + " " + (r.Error.Message || ""));
    const st = (r.SendStatusSet || [])[0];
    if (!st || st.Code !== "Ok") {
      throw new Error("腾讯云短信下发失败：" + (st?.Code || "EMPTY") + " " + (st?.Message || ""));
    }
  }
}
