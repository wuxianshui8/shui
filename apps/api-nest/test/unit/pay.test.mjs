// 单元测试：integrations/pay（端口契约 / mock / 微信支付 v3 签名·验签·解密·下单·退款）
// 用本地生成的 RSA 密钥对与 AES-256-GCM 自加密来验证——不需要真实商户号与证书
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync } from "node:crypto";
import { unescapePem } from "../../dist/integrations/pay/pay.port.js";
import { MockPayProvider } from "../../dist/integrations/pay/pay.mock.js";
import {
  WechatPayProvider,
  decryptNotificationResource,
  jsapiPayParams,
  signMessage,
  verifyNotification,
  verifySignature,
  wechatAuthorization,
  wechatConfigFromEnv,
} from "../../dist/integrations/pay/pay.wechat.js";
import {
  createPayProvider,
  getPayProvider,
  resetPayProviderForTest,
  payProviderName,
} from "../../dist/integrations/pay/pay.service.js";

const kp = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

const merchant = kp(); // 商户 API 证书（我方签名）
const platform = kp(); // 微信支付平台证书（回调验签）
const API_V3_KEY = "0123456789abcdef0123456789abcdef"; // 32 字节

const CFG = {
  appId: "wxdemo1234567890",
  mchId: "1900000001",
  serialNo: "SERIAL0001",
  privateKey: merchant.privateKey,
  apiV3Key: API_V3_KEY,
  platformPublicKey: platform.publicKey,
  notifyUrl: "https://jiajiao.example.com/api/pay/wechat/notify",
};

const VALID_ENV = {
  PAY_PROVIDER: "wechat",
  WECHAT_PAY_APP_ID: CFG.appId,
  WECHAT_PAY_MCH_ID: CFG.mchId,
  WECHAT_PAY_SERIAL_NO: CFG.serialNo,
  WECHAT_PAY_PRIVATE_KEY: merchant.privateKey,
  WECHAT_PAY_APIV3_KEY: API_V3_KEY,
  WECHAT_PAY_PLATFORM_PUBLIC_KEY: platform.publicKey,
  WECHAT_PAY_NOTIFY_URL: CFG.notifyUrl,
};

/** 按微信规则加密：authTag 拼在密文尾部，整体 base64 */
function encryptResource(plain, { nonce, aad = "" }) {
  const c = createCipheriv("aes-256-gcm", Buffer.from(API_V3_KEY, "utf8"), Buffer.from(nonce, "utf8"));
  c.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([c.update(JSON.stringify(plain), "utf8"), c.final(), c.getAuthTag()]);
  return body.toString("base64");
}

/* ---------------- 配置校验 ---------------- */

test("wechatConfigFromEnv：缺配置直接抛错并点名缺哪些变量", () => {
  assert.throws(() => wechatConfigFromEnv({}), (e) => {
    assert.match(e.message, /WECHAT_PAY_APP_ID/);
    assert.match(e.message, /WECHAT_PAY_PLATFORM_PUBLIC_KEY/);
    return true;
  });
});

test("wechatConfigFromEnv：APIv3 密钥必须 32 字节", () => {
  assert.throws(() => wechatConfigFromEnv({ ...VALID_ENV, WECHAT_PAY_APIV3_KEY: "short" }), /必须是 32 字节/);
});

test("wechatConfigFromEnv：回调地址必须 HTTPS（公网）", () => {
  assert.throws(() => wechatConfigFromEnv({ ...VALID_ENV, WECHAT_PAY_NOTIFY_URL: "http://127.0.0.1/x" }), /公网 HTTPS/);
});

test("wechatConfigFromEnv：占位串视为未配置，PEM 的 \\n 转义会被还原", () => {
  assert.throws(() => wechatConfigFromEnv({ ...VALID_ENV, WECHAT_PAY_MCH_ID: "please-change-me" }), /WECHAT_PAY_MCH_ID/);
  const c = wechatConfigFromEnv({ ...VALID_ENV, WECHAT_PAY_PRIVATE_KEY: merchant.privateKey.replace(/\n/g, "\\n") });
  assert.match(c.privateKey, /-----BEGIN PRIVATE KEY-----/);
  assert.ok(c.privateKey.includes("\n"), "转义必须还原为真实换行，否则签名会失败");
  assert.equal(c.maxSkewSeconds, 300);
  assert.equal(unescapePem("a\\nb"), "a\nb");
});

/* ---------------- 签名 / 验签 ---------------- */

test("signMessage + verifySignature：RSA-SHA256 往返", () => {
  const sig = signMessage(merchant.privateKey, "hello");
  assert.match(sig, /^[A-Za-z0-9+/=]+$/);
  assert.equal(verifySignature(merchant.publicKey, "hello", sig), true);
  assert.equal(verifySignature(merchant.publicKey, "hello!", sig), false, "内容变化必须验签失败");
  assert.equal(verifySignature(platform.publicKey, "hello", sig), false, "换公钥必须验签失败");
  assert.equal(verifySignature(merchant.publicKey, "hello", "not-base64"), false);
  assert.equal(verifySignature("bad-pem", "hello", sig), false, "非法公钥不抛异常，返回 false");
});

test("wechatAuthorization：头结构与签名串符合 v3 规范", () => {
  const p = { method: "POST", urlPath: "/v3/pay/transactions/jsapi", body: "{\"a\":1}", timestamp: 1735000000, nonce: "abc123" };
  const header = wechatAuthorization(CFG, p);
  assert.match(header, /^WECHATPAY2-SHA256-RSA2048 mchid="1900000001",nonce_str="abc123",signature="[^"]+",timestamp="1735000000",serial_no="SERIAL0001"$/);
  const sig = /signature="([^"]+)"/.exec(header)[1];
  const message = ["POST", p.urlPath, "1735000000", "abc123", p.body, ""].join("\n");
  assert.equal(verifySignature(merchant.publicKey, message, sig), true, "签名串必须是 METHOD\\nURL\\nts\\nnonce\\nbody\\n");
});

test("jsapiPayParams：paySign 可验证且 package 带 prepay_id", () => {
  const params = jsapiPayParams({ appId: CFG.appId, prepayId: "wx_prepay_1", privateKey: merchant.privateKey, timeStamp: 1735000000, nonceStr: "n1" });
  assert.equal(params.package, "prepay_id=wx_prepay_1");
  assert.equal(params.signType, "RSA");
  assert.equal(params.timeStamp, "1735000000");
  assert.equal(params.nonceStr, "n1");
  const message = [CFG.appId, "1735000000", "n1", "prepay_id=wx_prepay_1", ""].join("\n");
  assert.equal(verifySignature(merchant.publicKey, message, params.paySign), true);
});

/* ---------------- 回调解密与验签 ---------------- */

const PLAIN = { out_trade_no: "JJ202610220001", transaction_id: "4200000000202610220001", amount: { total: 16400 }, trade_state: "SUCCESS", attach: "order:12" };
const NONCE = "abcdef123456";
const AAD = "transaction";

function envelope(plain = PLAIN, opts = {}) {
  const nonce = opts.nonce || NONCE;
  const aad = opts.aad === undefined ? AAD : opts.aad;
  return {
    id: "evt-1",
    event_type: "TRANSACTION.SUCCESS",
    resource: { algorithm: "AEAD_AES_256_GCM", ciphertext: encryptResource(plain, { nonce, aad }), nonce, associated_data: aad },
  };
}

function signedHeaders(bodyText, ts = Math.floor(Date.now() / 1000), nonce = "hdrnonce") {
  const signature = signMessage(platform.privateKey, ts + "\n" + nonce + "\n" + bodyText + "\n");
  return { "Wechatpay-Timestamp": String(ts), "Wechatpay-Nonce": nonce, "Wechatpay-Signature": signature, "Wechatpay-Serial": "PLATFORM_SERIAL" };
}

test("decryptNotificationResource：AES-256-GCM 往返（authTag 在密文尾部）", () => {
  const enc = encryptResource(PLAIN, { nonce: NONCE, aad: AAD });
  assert.deepEqual(JSON.parse(decryptNotificationResource(API_V3_KEY, { ciphertext: enc, nonce: NONCE, associated_data: AAD })), PLAIN);
  assert.throws(() => decryptNotificationResource(API_V3_KEY, { ciphertext: "AAAA", nonce: NONCE }), /长度不足/);
  const bad = Buffer.from(enc, "base64");
  bad[bad.length - 1] ^= 0xff;
  assert.throws(() => decryptNotificationResource(API_V3_KEY, { ciphertext: bad.toString("base64"), nonce: NONCE, associated_data: AAD }));
});

test("verifyNotification：正常签名通过", () => {
  const body = JSON.stringify(envelope());
  assert.doesNotThrow(() => verifyNotification(CFG, body, signedHeaders(body)));
});

test("verifyNotification：内容被篡改 / 时间戳过期 / 缺字段 全部拒绝", () => {
  const body = JSON.stringify(envelope());
  const headers = signedHeaders(body);
  const tampered = body.replace("\"evt-1\"", "\"evt-2\"");
  assert.notEqual(tampered, body, "篡改必须真的改动报文，否则等于没测");
  assert.throws(() => verifyNotification(CFG, tampered, headers), /验签失败/);

  const oldTs = Math.floor(Date.now() / 1000) - 3600;
  assert.throws(() => verifyNotification(CFG, body, signedHeaders(body, oldTs)), /时间戳超出容忍范围/);

  assert.throws(() => verifyNotification(CFG, body, {}), /缺少 Wechatpay/);
  assert.throws(
    () => verifyNotification(CFG, body, { "Wechatpay-Timestamp": "not-a-number", "Wechatpay-Nonce": "n", "Wechatpay-Signature": "s" }),
    /时间戳超出容忍范围/,
  );
});

/* ---------------- 微信 v3 请求 ---------------- */

function fakeFetch(responses, calls) {
  let i = 0;
  return async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok !== false, status: r.status || 200, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
}

test("WechatPayProvider.createPrepay：请求体与路径符合 JSAPI 下单契约", async () => {
  const calls = [];
  const p = new WechatPayProvider(CFG, fakeFetch([{ body: { prepay_id: "wx_prepay_9" } }], calls));
  const r = await p.createPrepay({
    outTradeNo: "JJ202610220001",
    amountCents: 16400,
    description: "高一数学 · 2 小时",
    openId: "openid-abc",
    notifyUrl: CFG.notifyUrl,
    attach: "order:12",
  });
  assert.equal(calls[0].url, "https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.appid, CFG.appId);
  assert.equal(body.mchid, CFG.mchId);
  assert.equal(body.out_trade_no, "JJ202610220001");
  assert.deepEqual(body.amount, { total: 16400, currency: "CNY" });
  assert.deepEqual(body.payer, { openid: "openid-abc" });
  assert.equal(body.notify_url, CFG.notifyUrl);
  assert.equal(body.attach, "order:12");
  assert.match(calls[0].init.headers.Authorization, /^WECHATPAY2-SHA256-RSA2048 /);

  assert.equal(r.prepayId, "wx_prepay_9");
  assert.equal(r.params.package, "prepay_id=wx_prepay_9");
  const msg = [CFG.appId, r.params.timeStamp, r.params.nonceStr, r.params.package, ""].join("\n");
  assert.equal(verifySignature(merchant.publicKey, msg, r.params.paySign), true);
});

test("WechatPayProvider.createPrepay：缺 prepay_id / 非 2xx 都抛错", async () => {
  await assert.rejects(
    () => new WechatPayProvider(CFG, fakeFetch([{ body: {} }], [])).createPrepay({ outTradeNo: "X", amountCents: 1, description: "d", openId: "o", notifyUrl: CFG.notifyUrl }),
    /未返回 prepay_id/,
  );
  await assert.rejects(
    () =>
      new WechatPayProvider(CFG, fakeFetch([{ ok: false, status: 401, body: { code: "SIGN_ERROR", message: "签名错误" } }], [])).createPrepay({
        outTradeNo: "X",
        amountCents: 1,
        description: "d",
        openId: "o",
        notifyUrl: CFG.notifyUrl,
      }),
    /SIGN_ERROR 签名错误/,
  );
});

test("WechatPayProvider.verifyNotify：验签 + 解密后返回业务字段", async () => {
  const env = envelope();
  const body = JSON.stringify(env);
  const headers = signedHeaders(body);
  const p = new WechatPayProvider(CFG, fakeFetch([{ body: {} }], []));
  const r = await p.verifyNotify(body, headers);
  assert.deepEqual(r, {
    outTradeNo: "JJ202610220001",
    transactionId: "4200000000202610220001",
    amountCents: 16400,
    tradeState: "SUCCESS",
    success: true,
    attach: "order:12",
  });
});

test("WechatPayProvider.verifyNotify：未签名/改包/缺 resource 全部抛错", async () => {
  const body = JSON.stringify(envelope());
  const p = new WechatPayProvider(CFG, fakeFetch([{ body: {} }], []));
  await assert.rejects(() => p.verifyNotify(body, {}), /缺少 Wechatpay/);
  const tampered = body.replace("\"evt-1\"", "\"evt-2\"");
  assert.notEqual(tampered, body);
  await assert.rejects(() => p.verifyNotify(tampered, signedHeaders(body)), /验签失败/);

  const noResource = JSON.stringify({ id: "e", event_type: "X" });
  await assert.rejects(() => p.verifyNotify(noResource, signedHeaders(noResource)), /resource\.ciphertext/);

  const notJson = "not-json";
  await assert.rejects(() => p.verifyNotify(notJson, signedHeaders(notJson)), /不是合法 JSON/);
});

test("WechatPayProvider.refund：路径与金额正确", async () => {
  const calls = [];
  const p = new WechatPayProvider(CFG, fakeFetch([{ body: { refund_id: "5030000001", status: "PROCESSING" } }], calls));
  const r = await p.refund({ outTradeNo: "JJ202610220001", outRefundNo: "RF1", refundCents: 5000, totalCents: 16400, reason: "课程取消" });
  assert.equal(calls[0].url, "https://api.mch.weixin.qq.com/v3/refund/domestic/refunds");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.out_refund_no, "RF1");
  assert.deepEqual(body.amount, { refund: 5000, total: 16400, currency: "CNY" });
  assert.equal(r.refundId, "5030000001");
  assert.equal(r.status, "PROCESSING");
});

/* ---------------- mock 与工厂 ---------------- */

test("MockPayProvider：记录下单/退款，回调解析不验签", async () => {
  const p = new MockPayProvider();
  const pre = await p.createPrepay({ outTradeNo: "JJ1", amountCents: 100, description: "d", openId: "o", notifyUrl: "https://x/y" });
  assert.equal(pre.prepayId, "mock_prepay_JJ1");
  assert.equal(p.prepays.length, 1);

  const okNotify = await p.verifyNotify(JSON.stringify({ out_trade_no: "JJ1", transaction_id: "T1", amount: { total: 100 }, trade_state: "SUCCESS" }));
  assert.equal(okNotify.success, true);
  assert.equal(okNotify.amountCents, 100);
  assert.equal((await p.verifyNotify(JSON.stringify({ out_trade_no: "JJ1", amount: { total: 100 }, trade_state: "NOTPAY" }))).success, false);

  await assert.rejects(() => p.verifyNotify("oops"), /不是合法 JSON/);
  await assert.rejects(() => p.verifyNotify(JSON.stringify({ out_trade_no: "JJ1" })), /缺少 out_trade_no/);

  const rf = await p.refund({ outTradeNo: "JJ1", outRefundNo: "R1", refundCents: 100, totalCents: 100 });
  assert.equal(rf.status, "SUCCESS");
  assert.equal(p.refunds.length, 1);
});

test("pay 工厂：默认 mock；wechat 缺配置拒绝；未知通道拒绝", () => {
  assert.equal(createPayProvider({}).name, "mock");
  assert.throws(() => createPayProvider({ PAY_PROVIDER: "wechat" }), /WECHAT_PAY_APP_ID/);
  assert.throws(() => createPayProvider({ PAY_PROVIDER: "alipay" }), /只能是 mock \/ wechat/);
  assert.equal(createPayProvider(VALID_ENV).name, "wechat");
});

test("getPayProvider：缓存单例，配错时 payProviderName 标记 invalid", () => {
  const prev = process.env.PAY_PROVIDER;
  const prevEnv = { ...process.env };
  try {
    process.env.PAY_PROVIDER = "mock";
    resetPayProviderForTest();
    const a = getPayProvider();
    assert.equal(a, getPayProvider());
    assert.equal(payProviderName(), "mock");

    process.env.PAY_PROVIDER = "wechat";
    assert.throws(() => getPayProvider(), /WECHAT_PAY_APP_ID/, "缺密钥不能静默退回 mock");

    Object.assign(process.env, VALID_ENV);
    const b = getPayProvider();
    assert.notEqual(a, b);
    assert.equal(b.name, "wechat");

    process.env.PAY_PROVIDER = "stripe";
    assert.equal(payProviderName(), "invalid:stripe");
  } finally {
    for (const k of Object.keys(VALID_ENV)) if (!(k in prevEnv)) delete process.env[k];
    if (prev === undefined) delete process.env.PAY_PROVIDER;
    else process.env.PAY_PROVIDER = prev;
    resetPayProviderForTest();
  }
});

/* ---------------- 关单（超时未支付） ---------------- */

test("MockPayProvider.close：记录关单请求（空操作）", async () => {
  const p = new MockPayProvider();
  await p.close("JJ1");
  await p.close("JJ2");
  assert.deepEqual(p.closed, ["JJ1", "JJ2"]);
});

test("WechatPayProvider.close：路径与 mchid 正确", async () => {
  const calls = [];
  const p = new WechatPayProvider(CFG, fakeFetch([{ body: {} }], calls));
  await p.close("JJ202610220001");
  assert.equal(calls[0].url, "https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/JJ202610220001/close");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { mchid: CFG.mchId });
});

test("WechatPayProvider.close：已关闭/已支付/不存在视为幂等成功，其他错误照抛", async () => {
  for (const code of ["ORDER_CLOSED", "ORDERPAID", "ORDER_NOT_EXIST"]) {
    const p = new WechatPayProvider(CFG, fakeFetch([{ ok: false, status: 400, body: { code, message: "x" } }], []));
    await assert.doesNotReject(() => p.close("JJ1"), code + " 应当幂等");
  }
  const p2 = new WechatPayProvider(CFG, fakeFetch([{ ok: false, status: 500, body: { code: "SYSTEM_ERROR", message: "系统异常" } }], []));
  await assert.rejects(() => p2.close("JJ1"), /SYSTEM_ERROR/);
});
