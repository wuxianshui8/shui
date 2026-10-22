/**
 * mock 证件识别：不联网、不花钱，供本地联调与自动化门禁用。
 *
 * 识别口径（**仅 mock，真实通道不会这么干**）：从上传文件的原文件名里解析
 *   「姓名_18 位身份证号.后缀」，例如 `张三_330106199001011234.png`
 * 这样自动化测试与本地演示不用真证件、不用云账号也能跑通整条链路；
 * 文件名不含该模式时返回 ok=false，前端提示「未识别到证件信息」，不会伪造结果。
 */
import { IdCardOcrResult, OcrProvider } from "./ocr.port";

const NAME_ID_RE = /^\s*([\u4e00-\u9fa5A-Za-z·•\u3000\s]{2,30}?)[-_ ]?(\d{17}[\dXx])/;

export function parseMockFilename(filename: string | undefined): { name: string; idCard: string } | null {
  const base = String(filename || "").replace(/\.[A-Za-z0-9]+$/, "");
  const m = NAME_ID_RE.exec(base);
  if (!m) return null;
  const name = m[1].replace(/[\s\u3000]/g, "");
  if (!name) return null;
  return { name, idCard: m[2].toUpperCase() };
}

export class MockOcrProvider implements OcrProvider {
  readonly name = "mock";

  async idCardFront(_image: Buffer, meta: { filename?: string }): Promise<IdCardOcrResult> {
    const parsed = parseMockFilename(meta.filename);
    if (!parsed) {
      return { ok: false, reason: "mock 无法从文件名解析证件信息", provider: this.name };
    }
    return { ok: true, name: parsed.name, idCard: parsed.idCard, provider: this.name };
  }
}
