// 单元测试：integrations/ocr（证件识别端口 / mock 解析 / 腾讯云签名与响应解析）
// 不联网、不需要云账号：签名与解析都是纯函数，mock 只做文件名解析。
process.env.AUTH_SECRET = "unit-test-secret-0123456789abcdef";

import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIdCardMatch, maskIdCard, normalizeName, looksPlaceholder } from "../../dist/integrations/ocr/ocr.port.js";
import { MockOcrProvider, parseMockFilename } from "../../dist/integrations/ocr/ocr.mock.js";
import {
  idCardOcrPayload,
  parseIdCardOcrResponse,
  tc3Authorization,
  tencentOcrConfigFromEnv,
  TencentOcrProvider,
} from "../../dist/integrations/ocr/ocr.tencent.js";
import { ocrProviderFromEnv, resetOcrProviderForTest } from "../../dist/integrations/ocr/ocr.service.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const CFG = { secretId: "AKIDtest", secretKey: "secret-key-for-test", region: "ap-guangzhou" };

/* ---------------- 脱敏 / 归一化 ---------------- */

test("maskIdCard：保留前 6 后 4，中间打码；非 18 位只留前 4", () => {
  assert.equal(maskIdCard("330106199001011234"), "330106********1234");
  assert.equal(maskIdCard("33010619900101123X"), "330106********123X");
  assert.equal(maskIdCard("123"), "123****");
  assert.equal(maskIdCard(""), null);
  assert.equal(maskIdCard(null), null);
});

test("normalizeName：去空白/间隔点、全角转半角、大小写不敏感", () => {
  assert.equal(normalizeName("  张 三 "), "张三");
  assert.equal(normalizeName("买买提·艾力"), "买买提艾力");
  assert.equal(normalizeName("ＺＨＡＮＧ ｓａｎ"), "ZHANG SAN".replace(/\s/g, ""));
  assert.equal(normalizeName("abc"), normalizeName("ABC"));
  assert.equal(normalizeName(null), "");
});

test("looksPlaceholder：空值/示例串视为未配置，真实密钥不算", () => {
  assert.equal(looksPlaceholder(""), true);
  assert.equal(looksPlaceholder("   "), true);
  assert.equal(looksPlaceholder("your-secret-id"), true);
  assert.equal(looksPlaceholder("AKIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), true);
  assert.equal(looksPlaceholder("AKIDrealLooking1234567890abcdef"), false);
});

/* ---------------- 一致性判定 ---------------- */

test("checkIdCardMatch：姓名与号码都对才通过", () => {
  const ocr = { name: "张三", idCard: "330106199001011234" };
  assert.equal(checkIdCardMatch(ocr, { realName: "张三", idCard: "330106199001011234" }).ok, true);
  assert.equal(checkIdCardMatch(ocr, { realName: " 张 三 ", idCard: "330106199001011234" }).ok, true, "空白不影响");
  assert.equal(checkIdCardMatch(ocr, { realName: "李四", idCard: "330106199001011234" }).ok, false);
  assert.equal(checkIdCardMatch(ocr, { realName: "张三", idCard: "330106199002022345" }).ok, false);
});

test("checkIdCardMatch：小写 x 的身份证号等价；未填号码时只校验姓名", () => {
  const ocr = { name: "张三", idCard: "33010619900101123X" };
  assert.equal(checkIdCardMatch(ocr, { realName: "张三", idCard: "33010619900101123x" }).ok, true);
  assert.equal(checkIdCardMatch(ocr, { realName: "张三", idCard: "" }).ok, true, "未填号码只比姓名");
});

test("checkIdCardMatch：未识别出姓名时一律不通过，并给出中文原因", () => {
  const r = checkIdCardMatch({ name: "", idCard: "330106199001011234" }, { realName: "张三", idCard: "330106199001011234" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /姓名/);
  const r2 = checkIdCardMatch({ name: "张三", idCard: "330106199001011234" }, { realName: "张三", idCard: "330106199002022345" });
  assert.match(r2.reason, /身份证号/);
});

/* ---------------- mock 通道 ---------------- */

test("parseMockFilename：解析「姓名_身份证号」，解析不出返回 null", () => {
  assert.deepEqual(parseMockFilename("张三_330106199001011234.png"), { name: "张三", idCard: "330106199001011234" });
  assert.deepEqual(parseMockFilename("李四-33010619900101123x.jpg"), { name: "李四", idCard: "33010619900101123X" });
  assert.equal(parseMockFilename("身份证正面.png"), null);
  assert.equal(parseMockFilename(""), null);
  assert.equal(parseMockFilename(undefined), null);
});

test("MockOcrProvider：文件名带信息则成功，否则明确失败（不编造）", async () => {
  const p = new MockOcrProvider();
  const good = await p.idCardFront(PNG, { filename: "王五_110101199003071234.png" });
  assert.equal(good.ok, true);
  assert.equal(good.name, "王五");
  assert.equal(good.provider, "mock");
  const bad = await p.idCardFront(PNG, { filename: "随便一张图.png" });
  assert.equal(bad.ok, false);
  assert.equal(bad.name, undefined);
  assert.ok(bad.reason);
});

/* ---------------- 腾讯云通道（纯函数 + 假 fetch） ---------------- */

test("tencentOcrConfigFromEnv：缺密钥/占位串不通过，齐全则通过", () => {
  assert.equal(tencentOcrConfigFromEnv({}).ok, false);
  assert.equal(tencentOcrConfigFromEnv({ TENCENT_SECRET_ID: "AKIDx", TENCENT_SECRET_KEY: "your-key" }).ok, false);
  const ok = tencentOcrConfigFromEnv({ TENCENT_SECRET_ID: "AKIDreal", TENCENT_SECRET_KEY: "realkey" });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.region, "ap-guangzhou", "默认地域");
  assert.equal(tencentOcrConfigFromEnv({ TENCENT_SECRET_ID: "AKIDreal", TENCENT_SECRET_KEY: "realkey", TENCENT_OCR_REGION: "ap-shanghai" }).config.region, "ap-shanghai");
});

test("idCardOcrPayload：带 ImageBase64 与人像面", () => {
  const payload = JSON.parse(idCardOcrPayload(PNG));
  assert.equal(payload.ImageBase64, PNG.toString("base64"));
  assert.equal(payload.CardSide, "FRONT");
});

test("tc3Authorization：同输入同输出；换时间/换密钥都会变", () => {
  const payload = JSON.stringify({ ImageBase64: "abc" });
  const a = tc3Authorization(CFG, payload, 1700000000);
  const b = tc3Authorization(CFG, payload, 1700000000);
  assert.equal(a.signature, b.signature);
  assert.match(a.header, /^TC3-HMAC-SHA256 Credential=AKIDtest\/\d{4}-\d{2}-\d{2}\/ocr\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);
  assert.notEqual(a.signature, tc3Authorization(CFG, payload, 1700000001).signature, "时间参与签名");
  assert.notEqual(a.signature, tc3Authorization({ ...CFG, secretKey: "other" }, payload, 1700000000).signature, "密钥参与签名");
  assert.notEqual(a.signature, tc3Authorization(CFG, payload + "x", 1700000000).signature, "请求体参与签名");
});

test("parseIdCardOcrResponse：正常/错误码/缺字段/非 JSON 结构", () => {
  const ok = parseIdCardOcrResponse({ Response: { Name: " 张三 ", IdNum: "33010619900101123x", RequestId: "r1" } });
  assert.deepEqual([ok.ok, ok.name, ok.idCard], [true, "张三", "33010619900101123X"]);

  const err = parseIdCardOcrResponse({ Response: { Error: { Code: "FailedOperation.ImageDecodeFailed", Message: "decode fail" } } });
  assert.equal(err.ok, false);
  assert.match(err.reason, /ImageDecodeFailed/);

  assert.equal(parseIdCardOcrResponse({}).ok, false);
  assert.equal(parseIdCardOcrResponse(null).ok, false);
  assert.equal(parseIdCardOcrResponse({ Response: { Name: "张三" } }).ok, false, "缺身份证号不算识别成功");
  assert.equal(parseIdCardOcrResponse({ Response: { Name: "张三", IdNum: "123" } }).ok, false, "号码格式不对不算成功");
});

test("TencentOcrProvider：签名请求头齐全；HTTP 失败/非 JSON 都折叠成 ok=false", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ Response: { Name: "张三", IdNum: "330106199001011234" } }) };
  };
  const p = new TencentOcrProvider(CFG, fakeFetch);
  const r = await p.idCardFront(PNG);
  assert.equal(r.ok, true);
  assert.equal(r.provider, "tencent");
  const { url, init } = calls[0];
  assert.equal(url, "https://ocr.tencentcloudapi.com");
  assert.equal(init.headers["X-TC-Action"], "IDCardOCR");
  assert.equal(init.headers["X-TC-Version"], "2018-11-19");
  assert.match(init.headers.Authorization, /^TC3-HMAC-SHA256 /);
  assert.equal(JSON.parse(init.body).CardSide, "FRONT");

  const http500 = new TencentOcrProvider(CFG, async () => ({ ok: false, status: 500 }));
  assert.equal((await http500.idCardFront(PNG)).ok, false);

  const notJson = new TencentOcrProvider(CFG, async () => ({ ok: true, json: async () => { throw new Error("bad"); } }));
  assert.equal((await notJson.idCardFront(PNG)).ok, false);

  const netErr = new TencentOcrProvider(CFG, async () => { throw new Error("ECONNRESET"); });
  const netRes = await netErr.idCardFront(PNG);
  assert.equal(netRes.ok, false);
  assert.match(netRes.reason, /ECONNRESET/);
});

/* ---------------- 通道选择 ---------------- */

test("ocrProviderFromEnv：默认 mock；未知通道/缺密钥直接抛错（不静默降级）", () => {
  resetOcrProviderForTest();
  assert.equal(ocrProviderFromEnv({}).name, "mock");
  assert.equal(ocrProviderFromEnv({ OCR_PROVIDER: "MOCK" }).name, "mock");
  assert.throws(() => ocrProviderFromEnv({ OCR_PROVIDER: "aliyun" }), /只支持 mock \/ tencent/);
  assert.throws(() => ocrProviderFromEnv({ OCR_PROVIDER: "tencent" }), /TENCENT_SECRET_ID/);
  resetOcrProviderForTest();
});

test("recognizeIdCardFront：走单例通道；通道抛异常时折叠成 ok=false（不打挂入驻流程）", async () => {
  const svc = await import("../../dist/integrations/ocr/ocr.service.js");
  svc.resetOcrProviderForTest();
  const prev = process.env.OCR_PROVIDER;
  process.env.OCR_PROVIDER = "mock";
  const good = await svc.recognizeIdCardFront(PNG, { filename: "赵六_110101199003071234.png" });
  assert.equal(good.ok, true);
  assert.equal(good.name, "赵六");
  assert.equal(svc.ocrProvider().name, "mock", "单例生效");

  // 通道内部抛错：必须被折叠成 ok=false，而不是把异常抛给业务
  const broken = svc.ocrProvider();
  const origin = broken.idCardFront.bind(broken);
  broken.idCardFront = async () => {
    throw new Error("gateway down");
  };
  const bad = await svc.recognizeIdCardFront(PNG, { filename: "x.png" });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /识别通道异常/);
  broken.idCardFront = origin;

  process.env.OCR_PROVIDER = prev;
  svc.resetOcrProviderForTest();
});

test("ocrProviderFromEnv：tencent 分支在密钥齐全时返回 tencent 通道", () => {
  const svc = ocrProviderFromEnv({
    OCR_PROVIDER: "tencent",
    TENCENT_SECRET_ID: "AKIDreal",
    TENCENT_SECRET_KEY: "realkey",
  });
  assert.equal(svc.name, "tencent");
});
