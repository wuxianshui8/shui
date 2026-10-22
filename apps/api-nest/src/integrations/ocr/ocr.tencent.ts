/**
 * 腾讯云证件识别（IDCardOCR）真实通道。
 *
 * 与 SMS 的 TC3-HMAC-SHA256 同一套签名算法，但服务名/主机不同（ocr.tencentcloudapi.com / ocr）。
 * 签名、payload 拼装、响应解析都写成纯函数，这样没有云账号也能单测（构造签名后自校验字节一致性）。
 */
import { createHash, createHmac } from "node:crypto";
import { IdCardOcrResult, OcrProvider, looksPlaceholder } from "./ocr.port";

const HOST = "ocr.tencentcloudapi.com";
const SERVICE = "ocr";
const ACTION = "IDCardOCR";
const VERSION = "2018-11-19";
const REGION = "ap-guangzhou";
const ALGORITHM = "TC3-HMAC-SHA256";

export interface TencentOcrConfig {
  secretId: string;
  secretKey: string;
  region: string;
}

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/** 从环境变量读取并校验；缺项/占位串返回带原因的对象，由调用方决定是否拒绝启动 */
export function tencentOcrConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { ok: boolean; config?: TencentOcrConfig; reason?: string } {
  const secretId = String(env.TENCENT_SECRET_ID || "").trim();
  const secretKey = String(env.TENCENT_SECRET_KEY || "").trim();
  if (looksPlaceholder(secretId) || looksPlaceholder(secretKey)) {
    return { ok: false, reason: "OCR_PROVIDER=tencent 需要配置 TENCENT_SECRET_ID / TENCENT_SECRET_KEY" };
  }
  return { ok: true, config: { secretId, secretKey, region: String(env.TENCENT_OCR_REGION || REGION).trim() || REGION } };
}

/** 请求体：证件人像面 + 是否返回切边图（不回传，减少流量） */
export function idCardOcrPayload(image: Buffer): string {
  return JSON.stringify({ ImageBase64: image.toString("base64"), CardSide: "FRONT", Config: JSON.stringify({ CropIdCard: "false" }) });
}

/** TC3-HMAC-SHA256 签名（与腾讯云文档逐字对应） */
export function tc3Authorization(cfg: TencentOcrConfig, payload: string, timestampSec: number) {
  const date = new Date(timestampSec * 1000).toISOString().slice(0, 10);
  const contentType = "application/json; charset=utf-8";
  const signedHeaders = "content-type;host";
  const canonicalHeaders = "content-type:" + contentType + "\n" + "host:" + HOST + "\n";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256hex(payload)].join("\n");
  const scope = date + "/" + SERVICE + "/tc3_request";
  const stringToSign = [ALGORITHM, String(timestampSec), scope, sha256hex(canonicalRequest)].join("\n");
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
    header: `${ALGORITHM} Credential=${cfg.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** 把 OCR 返回体归一化成统一结果；错误码只进 reason，不透给终端用户 */
export function parseIdCardOcrResponse(json: any, provider = "tencent"): IdCardOcrResult {
  const resp = json && json.Response;
  if (!resp) return { ok: false, reason: "响应体缺少 Response", provider };
  if (resp.Error) {
    return { ok: false, reason: `${resp.Error.Code || "Error"}: ${resp.Error.Message || ""}`.trim(), provider };
  }
  const name = typeof resp.Name === "string" ? resp.Name.trim() : "";
  const idCard = typeof resp.IdNum === "string" ? resp.IdNum.trim().toUpperCase() : "";
  if (!name || !/^\d{17}[\dX]$/.test(idCard)) {
    // 泰半是图片模糊/翻拍/不是身份证：明确记为「未识别到」，绝不编造
    return { ok: false, reason: "未能从图片识别出姓名与身份证号", provider };
  }
  return { ok: true, name, idCard, provider };
}

export class TencentOcrProvider implements OcrProvider {
  readonly name = "tencent";

  constructor(private readonly cfg: TencentOcrConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async idCardFront(image: Buffer, _meta: { filename?: string } = {}): Promise<IdCardOcrResult> {
    const payload = idCardOcrPayload(image);
    const ts = Math.floor(Date.now() / 1000);
    const auth = tc3Authorization(this.cfg, payload, ts);
    let res: Response;
    try {
      res = await this.fetchImpl(`https://${HOST}`, {
        method: "POST",
        headers: {
          Authorization: auth.header,
          "Content-Type": auth.contentType,
          Host: HOST,
          "X-TC-Action": ACTION,
          "X-TC-Version": VERSION,
          "X-TC-Timestamp": String(ts),
          "X-TC-Region": this.cfg.region,
        },
        body: payload,
      });
    } catch (err: any) {
      return { ok: false, reason: "OCR 请求失败：" + (err?.message || "network"), provider: this.name };
    }
    if (!res.ok) return { ok: false, reason: "OCR HTTP " + res.status, provider: this.name };
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      return { ok: false, reason: "OCR 返回非 JSON", provider: this.name };
    }
    return parseIdCardOcrResponse(json, this.name);
  }
}
