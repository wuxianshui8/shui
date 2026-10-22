/**
 * 证件识别（OCR）端口。
 *
 * 与短信/支付同样的分层：真实通道（腾讯云 IDCardOCR）与 mock 通道实现同一接口，
 * 由 OCR_PROVIDER 选择；mock 不联网、不花钱，仅用于本地联调与自动化门禁。
 */

/** 识别结果：ok=false 表示这次没能识别出可用信息（原因写在 reason 里，不透出给终端用户） */
export interface IdCardOcrResult {
  ok: boolean;
  /** 姓名（ok=true 时必有） */
  name?: string;
  /** 身份证号（18 位，ok=true 时必有） */
  idCard?: string;
  /** 内部原因，仅用于日志与审计，不返回给前端 */
  reason?: string;
  provider: string;
}

export interface OcrProvider {
  readonly name: string;
  /** 识别身份证人像面；image 为图片原始字节 */
  idCardFront(image: Buffer, meta: { filename?: string }): Promise<IdCardOcrResult>;
}

/** 身份证号脱敏：330106********1234 */
export function maskIdCard(id: string | null | undefined): string | null {
  const s = String(id || "");
  if (s.length !== 18) return s ? s.slice(0, 4) + "****" : null;
  return s.slice(0, 6) + "********" + s.slice(14);
}

/**
 * 姓名归一化后比较：去空白、全角转半角、去掉「·」这类间隔点。
 * 证件上的少数民族姓名带间隔点是常态，直接字符串比较会误判。
 */
export function normalizeName(name: string | null | undefined): string {
  return String(name || "")
    .replace(/[\s\u3000]/g, "")
    .replace(/[·•・.]/g, "")
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toUpperCase();
}

export interface IdCardMatch {
  ok: boolean;
  nameMatched: boolean;
  idCardMatched: boolean;
  /** 面向用户的中文原因（ok=false 时给出第一条） */
  reason?: string;
}

/**
 * 证件信息与用户填写的资料是否一致。
 * 规则：姓名归一化后必须相同；身份证号（若用户填了）必须大小写不敏感地相同。
 */
export function checkIdCardMatch(
  ocr: { name?: string; idCard?: string },
  form: { realName?: string; idCard?: string },
): IdCardMatch {
  const nameMatched = !!ocr.name && normalizeName(ocr.name) === normalizeName(form.realName);
  const typed = String(form.idCard || "").trim().toUpperCase();
  const idCardMatched = !!ocr.idCard && (!typed || String(ocr.idCard).toUpperCase() === typed);
  if (!nameMatched) {
    return { ok: false, nameMatched, idCardMatched, reason: "身份证上的姓名与填写的真实姓名不一致，请核对证件或填写内容" };
  }
  if (!idCardMatched) {
    return { ok: false, nameMatched, idCardMatched, reason: "身份证号与证件上的号码不一致，请核对后重新提交" };
  }
  return { ok: true, nameMatched, idCardMatched };
}

/** 占位串/空值判定：`.env.example` 里的示例值当作未配置 */
export function looksPlaceholder(v: string | undefined | null): boolean {
  const s = String(v || "").trim();
  if (!s) return true;
  return /^(your|xxx|todo|change|placeholder|test-)/i.test(s) || s === "AKIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
}
