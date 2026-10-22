/**
 * 证件识别入口（单例）：按 OCR_PROVIDER 选择 mock / tencent。
 *
 * 与短信、支付同一套约定：
 * - 默认 mock，不联网不花钱；
 * - 显式配 tencent 却缺密钥 → **拒绝启动**，绝不静默降级；
 * - 识别失败只返回 ok=false，reason 只进服务端日志，不回显给用户（避免泄露网关细节）。
 */
import { Logger } from "@nestjs/common";
import { IdCardOcrResult, OcrProvider } from "./ocr.port";
import { MockOcrProvider } from "./ocr.mock";
import { TencentOcrProvider, tencentOcrConfigFromEnv } from "./ocr.tencent";

const logger = new Logger("OcrService");
let cached: OcrProvider | null = null;

export function ocrProviderFromEnv(env: NodeJS.ProcessEnv = process.env): OcrProvider {
  const provider = String(env.OCR_PROVIDER || "mock").trim().toLowerCase();
  if (provider === "tencent") {
    const c = tencentOcrConfigFromEnv(env);
    if (!c.ok || !c.config) throw new Error(c.reason || "腾讯云 OCR 配置不完整");
    return new TencentOcrProvider(c.config);
  }
  if (provider !== "mock") throw new Error("OCR_PROVIDER 只支持 mock / tencent，当前：" + provider);
  return new MockOcrProvider();
}

export function ocrProvider(): OcrProvider {
  if (!cached) cached = ocrProviderFromEnv();
  return cached;
}

/** 供单测重置单例 */
export function resetOcrProviderForTest() {
  cached = null;
}

/**
 * 识别身份证人像面。任何异常都折叠成 ok=false，绝不让 OCR 故障把入驻流程整体打挂。
 */
export async function recognizeIdCardFront(image: Buffer, meta: { filename?: string } = {}): Promise<IdCardOcrResult> {
  try {
    return await ocrProvider().idCardFront(image, meta);
  } catch (err: any) {
    logger.error("证件识别失败：" + (err?.message || err));
    return { ok: false, reason: "识别通道异常", provider: ocrProvider().name };
  }
}
