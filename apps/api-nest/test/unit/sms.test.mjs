// 单元测试：integrations/sms（端口契约 / mock 兜底 / 腾讯云 TC3 签名与错误分支）
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksPlaceholder } from "../../dist/integrations/sms/sms.port.js";
import { MockSmsSender } from "../../dist/integrations/sms/sms.mock.js";
import { TencentSmsSender, tc3Authorization, tencentSmsConfigFromEnv } from "../../dist/integrations/sms/sms.tencent.js";
import {
  createSmsSender,
  getSmsSender,
  resetSmsSenderForTest,
  smsProviderName,
} from "../../dist/integrations/sms/sms.service.js";

const CFG = {
  secretId: "AKIDexampleExampleExampleExample",
  secretKey: "secretExampleSecretExampleExample",
  sdkAppId: "1400000001",
  signName: "家教平台",
  templateId: "1234567",
};

const VALID_ENV = {
  SMS_PROVIDER: "tencent",
  TENCENT_SMS_SECRET_ID: CFG.secretId,
  TENCENT_SMS_SECRET_KEY: CFG.secretKey,
  TENCENT_SMS_SDK_APP_ID: CFG.sdkAppId,
  TENCENT_SMS_SIGN_NAME: CFG.signName,
  TENCENT_SMS_TEMPLATE_ID: CFG.templateId,
};

/* ---------------- 占位串判定 ---------------- */

test("looksPlaceholder：空值/占位串视为未配置", () => {
  for (const v of [undefined, "", "   ", "please-change-me", "CHANGEME", "xxx", "your-key", "TODO", "<your-id>"]) {
    assert.equal(looksPlaceholder(v), true, String(v));
  }
});

test("looksPlaceholder：真实值不误判", () => {
  for (const v of ["AKIDabc", "1400000001", "1234567", "家教平台"]) {
    assert.equal(looksPlaceholder(v), false, v);
  }
});

/* ---------------- 工厂与配置校验 ---------------- */

test("createSmsSender：未配置时退回 mock（不联网、不花钱）", () => {
  assert.equal(createSmsSender({}).name, "mock");
  assert.equal(createSmsSender({ SMS_PROVIDER: "" }).name, "mock");
  assert.equal(createSmsSender({ SMS_PROVIDER: "MOCK" }).name, "mock");
});

test("createSmsSender：tencent 缺配置直接抛错并点名缺哪些变量", () => {
  assert.throws(
    () => createSmsSender({ SMS_PROVIDER: "tencent" }),
    (e) => {
      assert.match(e.message, /TENCENT_SMS_SECRET_ID/);
      assert.match(e.message, /TENCENT_SMS_TEMPLATE_ID/);
      return true;
    },
  );
});

test("createSmsSender：占位串不算已配置（防模板值跑成静默失败）", () => {
  const env = { ...VALID_ENV, TENCENT_SMS_SECRET_KEY: "please-change-me" };
  assert.throws(() => createSmsSender(env), /TENCENT_SMS_SECRET_KEY/);
});

test("createSmsSender：未知 provider 直接拒绝（不静默降级）", () => {
  assert.throws(() => createSmsSender({ SMS_PROVIDER: "wechat" }), /只能是 mock \/ tencent/);
});

test("tencentSmsConfigFromEnv：trim 与默认地域", () => {
  const c = tencentSmsConfigFromEnv({ ...VALID_ENV, TENCENT_SMS_SECRET_ID: "  " + CFG.secretId + "  " });
  assert.equal(c.secretId, CFG.secretId);
  assert.equal(c.region, "ap-guangzhou");
  assert.equal(tencentSmsConfigFromEnv({ ...VALID_ENV, TENCENT_SMS_REGION: "ap-shanghai" }).region, "ap-shanghai");
});

/* ---------------- TC3 签名 ---------------- */

test("tc3Authorization：Authorization 头结构正确", () => {
  const a = tc3Authorization(CFG, "{\"a\":1}", 1735000000);
  assert.match(a.header, /^TC3-HMAC-SHA256 Credential=AKID.+?\/\d{4}-\d{2}-\d{2}\/sms\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);
  assert.match(a.signature, /^[0-9a-f]{64}$/);
  assert.equal(a.date, new Date(1735000000 * 1000).toISOString().slice(0, 10));
});

test("tc3Authorization：canonicalRequest / stringToSign 符合协议拼装（签名头块以换行结尾）", () => {
  const a = tc3Authorization(CFG, "{\"a\":1}", 1735000000);
  const lines = a.canonicalRequest.split("\n");
  assert.equal(lines[0], "POST");
  assert.equal(lines[1], "/");
  assert.equal(lines[2], "", "query string 为空");
  assert.equal(lines[3], "content-type:application/json; charset=utf-8");
  assert.equal(lines[4], "host:sms.tencentcloudapi.com");
  assert.equal(lines[5], "", "签名头块结尾换行产生的空行是协议要求");
  assert.equal(lines[6], "content-type;host");
  assert.match(lines[7], /^[0-9a-f]{64}$/, "末行为 payload 的 sha256");
  assert.ok(a.stringToSign.startsWith("TC3-HMAC-SHA256\n1735000000\n" + a.date + "/sms/tc3_request\n"));
});

test("tc3Authorization：同输入同时间戳可复现，时间戳/密钥变化则签名变化", () => {
  const a = tc3Authorization(CFG, "{\"a\":1}", 1735000000);
  const b = tc3Authorization(CFG, "{\"a\":1}", 1735000000);
  assert.equal(a.signature, b.signature);
  assert.notEqual(a.signature, tc3Authorization(CFG, "{\"a\":1}", 1735000001).signature);
  assert.notEqual(a.signature, tc3Authorization({ ...CFG, secretKey: "other" }, "{\"a\":1}", 1735000000).signature);
  assert.notEqual(a.signature, tc3Authorization(CFG, "{\"a\":2}", 1735000000).signature);
});

/* ---------------- 腾讯云发送 ---------------- */

function fakeFetch(response, capture) {
  return async (url, init) => {
    if (capture) capture.push({ url, init });
    const text = typeof response === "string" ? response : JSON.stringify(response);
    return { status: 200, text: async () => text };
  };
}

test("TencentSmsSender：请求体与头部符合 SendSms 契约", async () => {
  const calls = [];
  const s = new TencentSmsSender(CFG, fakeFetch({ Response: { SendStatusSet: [{ Code: "Ok" }], RequestId: "r1" } }, calls));
  await s.sendCode("13900000001", "123456", 300);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://sms.tencentcloudapi.com");
  const { init } = calls[0];
  assert.equal(init.method, "POST");
  assert.equal(init.headers["X-TC-Action"], "SendSms");
  assert.equal(init.headers["X-TC-Version"], "2021-01-11");
  assert.equal(init.headers["X-TC-Region"], "ap-guangzhou");
  assert.match(init.headers.Authorization, /^TC3-HMAC-SHA256 Credential=/);

  const body = JSON.parse(init.body);
  assert.deepEqual(body.PhoneNumberSet, ["+8613900000001"]);
  assert.equal(body.SmsSdkAppId, CFG.sdkAppId);
  assert.equal(body.SignName, CFG.signName);
  assert.equal(body.TemplateId, CFG.templateId);
  assert.deepEqual(body.TemplateParamSet, ["123456", "5"], "第二个变量是有效期（分钟）");
});

test("TencentSmsSender：响应 Ok 视为成功", async () => {
  const s = new TencentSmsSender(CFG, fakeFetch({ Response: { SendStatusSet: [{ Code: "Ok", Message: "send success" }] } }));
  await assert.doesNotReject(() => s.sendCode("13900000001", "123456", 300));
});

test("TencentSmsSender：Response.Error 抛错（含错误码，便于定位）", async () => {
  const s = new TencentSmsSender(CFG, fakeFetch({ Response: { Error: { Code: "AuthFailure.SecretIdNotFound", Message: "secret id not found" } } }));
  await assert.rejects(() => s.sendCode("13900000001", "123456", 300), /AuthFailure\.SecretIdNotFound/);
});

test("TencentSmsSender：下发失败状态码（欠费/频控）抛错", async () => {
  const s = new TencentSmsSender(
    CFG,
    fakeFetch({ Response: { SendStatusSet: [{ Code: "LimitExceeded.PhoneNumberDailyLimit", Message: "daily limit" }] } }),
  );
  await assert.rejects(() => s.sendCode("13900000001", "123456", 300), /LimitExceeded\.PhoneNumberDailyLimit/);
});

test("TencentSmsSender：空 SendStatusSet 与非法 JSON 都抛错", async () => {
  await assert.rejects(
    () => new TencentSmsSender(CFG, fakeFetch({ Response: {} })).sendCode("13900000001", "123456", 300),
    /EMPTY/,
  );
  await assert.rejects(
    () => new TencentSmsSender(CFG, fakeFetch("<html>502</html>")).sendCode("13900000001", "123456", 300),
    /非 JSON/,
  );
});

test("TencentSmsSender：错误信息不含验证码（避免日志泄露）", async () => {
  const s = new TencentSmsSender(CFG, fakeFetch({ Response: { Error: { Code: "InternalError", Message: "boom" } } }));
  try {
    await s.sendCode("13900000001", "654321", 300);
    assert.fail("应当抛错");
  } catch (e) {
    assert.ok(!String(e.message).includes("654321"), e.message);
  }
});

/* ---------------- mock 与单例 ---------------- */

test("MockSmsSender：记录 outbox 且日志只出现脱敏手机号", async () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const s = new MockSmsSender();
    await s.sendCode("13900000001", "112233", 300);
    assert.equal(s.outbox.length, 1);
    assert.equal(s.outbox[0].code, "112233");
    assert.equal(s.outbox[0].ttlSec, 300);
    assert.ok(warns.some((w) => w.includes("139****0001")), wins(warns));
    assert.ok(!warns.some((w) => w.includes("13900000001")), "日志不得出现完整手机号");
  } finally {
    console.warn = orig;
  }
});

test("MockSmsSender：SMS_MOCK_LOG_CODE=1 才把验证码打进日志（默认不打）", async () => {
  const orig = console.warn;
  const origFlag = process.env.SMS_MOCK_LOG_CODE;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    // 默认（未开开关）：日志里不得出现验证码
    delete process.env.SMS_MOCK_LOG_CODE;
    await new MockSmsSender().sendCode("13900000001", "445566", 300);
    assert.ok(!warningsHasCode(warns, "445566"), "默认不得打印验证码：" + wins(warns));

    // 打开开关：日志里出现验证码，但手机号仍脱敏
    warns.length = 0;
    process.env.SMS_MOCK_LOG_CODE = "1";
    await new MockSmsSender().sendCode("13900000001", "778899", 300);
    assert.ok(warningsHasCode(warns, "778899"), "开了开关应打印验证码：" + wins(warns));
    assert.ok(warns.some((w) => w.includes("139****0001")), "手机号仍要脱敏：" + wins(warns));
    assert.ok(!warns.some((w) => w.includes("13900000001")), "不得出现完整手机号");
    assert.ok(warns.some((w) => w.includes("仅限测试环境")), "日志要标明仅限测试环境：" + wins(warns));
  } finally {
    console.warn = orig;
    if (origFlag === undefined) delete process.env.SMS_MOCK_LOG_CODE;
    else process.env.SMS_MOCK_LOG_CODE = origFlag;
  }
});

const warningsHasCode = (list, code) => list.some((w) => w.includes(code));
const wins = (a) => a.join(" | ");

test("MockSmsSender：outbox 有上限，不会无限增长", async () => {
  const s = new MockSmsSender();
  const orig = console.warn;
  console.warn = () => {};
  try {
    for (let i = 0; i < 250; i++) await s.sendCode("13900000001", String(100000 + i), 300);
  } finally {
    console.warn = orig;
  }
  assert.equal(s.outbox.length, 200);
});

test("getSmsSender：按 provider 缓存单例，reset 后可切换", () => {
  const prev = process.env.SMS_PROVIDER;
  const prevEnv = { ...process.env };
  const orig = console.warn;
  console.warn = () => {};
  try {
    process.env.SMS_PROVIDER = "mock";
    resetSmsSenderForTest();
    const a = getSmsSender();
    assert.equal(a, getSmsSender(), "同 provider 复用同一实例");
    assert.equal(smsProviderName(), "mock");

    // 切到 tencent 必须同时给出完整配置，否则构造即失败（这正是「不静默降级」的意思）
    process.env.SMS_PROVIDER = "tencent";
    assert.throws(() => getSmsSender(), /TENCENT_SMS_SECRET_ID/, "缺密钥时不能悄悄退回 mock");

    Object.assign(process.env, VALID_ENV);
    const b = getSmsSender();
    assert.notEqual(a, b, "provider 变化后换实例");
    assert.equal(b.name, "tencent");

    process.env.SMS_PROVIDER = "nope";
    assert.equal(smsProviderName(), "invalid:nope", "配错时不抛错到日志层，而是标记 invalid");
  } finally {
    for (const k of Object.keys(VALID_ENV)) if (!(k in prevEnv)) delete process.env[k];
    if (prev === undefined) delete process.env.SMS_PROVIDER;
    else process.env.SMS_PROVIDER = prev;
    console.warn = orig;
    resetSmsSenderForTest();
  }
});
