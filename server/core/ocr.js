/**
 * 证件识别（参考实现侧）。
 *
 * 说明：真实通道（腾讯云 IDCardOCR）只在正式实现 `apps/api-nest` 里落地，
 * 这里与短信/支付一样只提供 mock —— 参考实现用来本地跑通链路，不接真实云账号。
 *
 * mock 口径：从上传文件的原文件名解析「姓名_18 位身份证号.后缀」，
 * 例如 `张三_330106199001011234.png`；解析不出就返回 ok=false，绝不编造结果。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const NAME_ID_RE = /^\s*([\u4e00-\u9fa5A-Za-z·•\u3000\s]{2,30}?)[-_ ]?(\d{17}[\dXx])/;

/** 从文件名解析姓名与身份证号（仅 mock 使用） */
export function parseNameFromFilename(filename) {
  const base = String(filename || "").replace(/\.[A-Za-z0-9]+$/, "");
  const m = NAME_ID_RE.exec(base);
  if (!m) return null;
  const name = m[1].replace(/[\s\u3000]/g, "");
  if (!name) return null;
  return { name, idCard: m[2].toUpperCase() };
}

/** 姓名归一化：去空白、去间隔点、全角转半角、转大写（少数民族姓名的「·」不该算不一致） */
export function normalizeName(name) {
  return String(name || "")
    .replace(/[\s\u3000]/g, "")
    .replace(/[·•・.]/g, "")
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toUpperCase();
}

/** 身份证号脱敏：330106********1234 */
export function maskIdCard(id) {
  const s = String(id || "");
  if (s.length !== 18) return s ? s.slice(0, 4) + "****" : null;
  return s.slice(0, 6) + "********" + s.slice(14);
}

/**
 * 证件信息与填写资料是否一致：姓名归一化后必须相同；身份证号（填了就）必须相同。
 * 返回 { ok, nameMatched, idCardMatched, reason }
 */
export function checkIdCardMatch(ocr, form) {
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

/**
 * 识别身份证人像面。file 为落盘文件的绝对路径，filename 为原始文件名（mock 靠它解析）。
 */
export async function recognizeIdCardFront({ file, filename }) {
  const parsed = parseNameFromFilename(filename);
  if (!parsed) {
    return { ok: false, provider: "mock", reason: "mock 无法从文件名解析证件信息" };
  }
  // 真读一次文件，确认图片确实存在且非空（防止「传了个标题党文件名但文件是空的」）
  try {
    const buf = readFileSync(file);
    if (!buf.length) return { ok: false, provider: "mock", reason: "图片内容为空" };
  } catch {
    return { ok: false, provider: "mock", reason: "图片读取失败" };
  }
  return { ok: true, provider: "mock", name: parsed.name, idCard: parsed.idCard };
}

/** /uploads/xxx → 落盘绝对路径（只允许单层文件名，杜绝目录穿越） */
export function uploadPath(uploadDir, url) {
  const s = String(url || "").trim();
  const prefix = "/uploads/";
  if (!s.startsWith(prefix)) return null;
  const rest = s.slice(prefix.length);
  if (!rest || rest.includes("/") || rest.includes("\\") || rest.includes("..")) return null;
  return { file: path.join(uploadDir, rest), filename: rest };
}
