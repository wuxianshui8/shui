// 单元测试：integrations/wechat（微信登录通道 / 授权 URL / 回跳白名单）
// 不联网：mock 通道与 URL 拼装都是纯函数；真实通道只验证「配置不全拒绝启动」与「URL 形态」。
process.env.AUTH_SECRET = "unit-test-secret-0123456789abcdef";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertRedirectAllowed,
  getWechatProvider,
  mockNicknameOf,
  resetWechatProviderForTest,
  wechatAuthorizeUrl,
  wechatOauthReady,
  wechatProviderFromEnv,
  wechatProviderName,
} from "../../dist/integrations/wechat/wechat.service.js";

const clearEnv = () => {
  delete process.env.WECHAT_APPID;
  delete process.env.WECHAT_SECRET;
  delete process.env.WECHAT_OAUTH;
  delete process.env.WECHAT_USERINFO;
  delete process.env.WECHAT_OAUTH_REDIRECT_ALLOWLIST;
  resetWechatProviderForTest();
};

/* ---------------- 通道选择 ---------------- */

test("未配置 appid/secret → mock 通道", () => {
  clearEnv();
  assert.equal(wechatProviderFromEnv().name, "mock");
  assert.equal(getWechatProvider().name, "mock");
  assert.equal(wechatProviderName(), "mock");
  clearEnv();
});

test("只配一半（只有 appid 或只有 secret）→ 拒绝启动，不静默降级成 mock", () => {
  clearEnv();
  process.env.WECHAT_APPID = "wxonly-appid";
  assert.throws(() => wechatProviderFromEnv(), /配置不完整/);
  clearEnv();
  process.env.WECHAT_SECRET = "only-secret";
  assert.throws(() => wechatProviderFromEnv(), /配置不完整/);
  clearEnv();
  // 单例在配置非法时返回 invalid，而不是抛给调用方
  process.env.WECHAT_APPID = "wxonly-appid";
  assert.equal(wechatProviderName(), "invalid");
  clearEnv();
});

test("appid + secret 都配 → 真实通道（wechat）", () => {
  clearEnv();
  process.env.WECHAT_APPID = "wx1234567890";
  process.env.WECHAT_SECRET = "secret-1234567890";
  assert.equal(wechatProviderFromEnv().name, "wechat");
  assert.equal(wechatProviderName(), "wechat");
  clearEnv();
});

test("单例按配置缓存：改环境变量后重新读取生效", () => {
  clearEnv();
  assert.equal(getWechatProvider().name, "mock");
  process.env.WECHAT_APPID = "wx1234567890";
  process.env.WECHAT_SECRET = "secret-1234567890";
  assert.equal(getWechatProvider().name, "wechat");
  clearEnv();
  assert.equal(getWechatProvider().name, "mock");
});

/* ---------------- mock 通道：同 code 稳定映射 ---------------- */

test("mock：同一 code → 同一 openid 与同一昵称（可复现）", async () => {
  clearEnv();
  const p = wechatProviderFromEnv();
  const a = await p.exchange("gate-code-1");
  const b = await p.exchange("gate-code-1");
  assert.equal(a.channel, "mock");
  assert.match(a.openid, /^mock_wx_[0-9a-f]{24}$/);
  assert.equal(a.openid, b.openid);
  assert.equal(a.profile.nickname, b.profile.nickname);
  assert.match(a.profile.nickname, /^微信用户\d{4}$/);
});

test("mock：不同 code → 不同 openid 与不同昵称（不串号）", async () => {
  clearEnv();
  const p = wechatProviderFromEnv();
  const a = await p.exchange("code-a");
  const b = await p.exchange("code-b");
  assert.notEqual(a.openid, b.openid);
  assert.notEqual(a.profile.nickname, b.profile.nickname);
});

test("mock：空 code 抛 WECHAT_CODE_REQUIRED", async () => {
  clearEnv();
  const p = wechatProviderFromEnv();
  await assert.rejects(() => p.exchange(""), (e) => e.code === "WECHAT_CODE_REQUIRED");
  await assert.rejects(() => p.exchange("   "), (e) => e.code === "WECHAT_CODE_REQUIRED");
});

test("mockNicknameOf：纯函数，稳定且在 4 位区间内", () => {
  assert.equal(mockNicknameOf("abc"), mockNicknameOf("abc"));
  const n = Number(mockNicknameOf("abc").replace("微信用户", ""));
  assert.ok(n >= 1000 && n <= 9999, "昵称尾号应在 1000-9999，实际 " + n);
});

/* ---------------- 公众号授权 URL ---------------- */

test("wechatAuthorizeUrl：含 appid / 编码后的 redirect / scope / state / #wechat_redirect", () => {
  const url = wechatAuthorizeUrl("wx1234567890", "https://jiajiao.example.com/m/cb?next=/pages/parent/index", "st-1");
  assert.ok(url.startsWith("https://open.weixin.qq.com/connect/oauth2/authorize?"), url);
  assert.match(url, /[?&]appid=wx1234567890(&|$)/);
  assert.match(url, /redirect_uri=https%3A%2F%2Fjiajiao\.example\.com%2Fm%2Fcb%3Fnext%3D%2Fpages%2Fparent%2Findex/);
  assert.match(url, /response_type=code/);
  assert.match(url, /scope=snsapi_userinfo/);
  assert.match(url, /state=st-1/);
  assert.ok(url.endsWith("#wechat_redirect"), "必须带 #wechat_redirect 锚点（微信要求）");
});

test("wechatAuthorizeUrl：缺 appid → WECHAT_NOT_CONFIGURED；缺 redirect → WECHAT_REDIRECT_REQUIRED", () => {
  assert.throws(() => wechatAuthorizeUrl("", "https://a.example.com/cb"), (e) => e.code === "WECHAT_NOT_CONFIGURED");
  assert.throws(() => wechatAuthorizeUrl("wx1", "   "), (e) => e.code === "WECHAT_REDIRECT_REQUIRED");
});

test("wechatAuthorizeUrl：scope 可覆盖（snsapi_base 静默授权）", () => {
  const url = wechatAuthorizeUrl("wx1", "https://a.example.com/cb", "", "snsapi_base");
  assert.match(url, /scope=snsapi_base/);
  assert.ok(!url.includes("snsapi_userinfo"));
});

/* ---------------- 回跳白名单（防开放重定向） ---------------- */

test("assertRedirectAllowed：命中白名单（含协议写法）才放行", () => {
  const allow = "https://jiajiao.example.com, miniapp.example.com";
  assert.equal(
    assertRedirectAllowed("https://jiajiao.example.com/m/cb", allow),
    "https://jiajiao.example.com/m/cb",
  );
  // 白名单只写域名时，https/http 都算命中
  assert.equal(assertRedirectAllowed("http://miniapp.example.com/x", allow), "http://miniapp.example.com/x");
});

test("assertRedirectAllowed：未配置白名单 / 域名不在白名单 / 相对地址 全部拒绝", () => {
  assert.throws(() => assertRedirectAllowed("https://a.example.com/cb", ""), (e) => e.code === "WECHAT_REDIRECT_NOT_ALLOWED");
  assert.throws(
    () => assertRedirectAllowed("https://evil.example.net/cb", "https://jiajiao.example.com"),
    (e) => e.code === "WECHAT_REDIRECT_NOT_ALLOWED",
  );
  assert.throws(() => assertRedirectAllowed("/m/cb", "https://jiajiao.example.com"), (e) => e.code === "WECHAT_REDIRECT_INVALID");
  // 子域名不能被父域白名单放过（origin 精确比对）
  assert.throws(
    () => assertRedirectAllowed("https://evil.jiajiao.example.com/cb", "https://jiajiao.example.com"),
    (e) => e.code === "WECHAT_REDIRECT_NOT_ALLOWED",
  );
});

/* ---------------- 公众号授权是否就绪 ---------------- */

test("wechatOauthReady：需要 appid + WECHAT_OAUTH=1 同时成立", () => {
  clearEnv();
  assert.equal(wechatOauthReady(), false);
  process.env.WECHAT_APPID = "wx1234567890";
  assert.equal(wechatOauthReady(), false, "只有 appid 不算就绪");
  process.env.WECHAT_OAUTH = "1";
  assert.equal(wechatOauthReady(), true);
  clearEnv();
  assert.equal(wechatOauthReady(), false);
});

/* ---------------- 真实通道：用假的 fetch 覆盖网络（不联网） ---------------- */

/** 把 globalThis.fetch 换成按顺序返回预设 JSON 的桩，调用完自动还原 */
async function withFetch(responses, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    const next = responses.shift();
    if (typeof next === "function") return next(url, opts);
    return { json: async () => next };
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const realEnv = () => {
  clearEnv();
  process.env.WECHAT_APPID = "wx1234567890";
  process.env.WECHAT_SECRET = "secret-1234567890";
};

test("真实通道（小程序）：jscode2session 返回 openid / unionid，不出资料", async () => {
  realEnv();
  await withFetch([{ openid: "o-mini-1", unionid: "u-1" }], async (calls) => {
    const s = await wechatProviderFromEnv().exchange("js-code-1");
    assert.equal(s.openid, "o-mini-1");
    assert.equal(s.channel, "miniprogram");
    assert.equal(s.unionid, "u-1");
    assert.equal(s.profile, undefined, "小程序渠道微信不给昵称/头像");
    assert.ok(calls[0].includes("/sns/jscode2session"), calls[0]);
    assert.ok(calls[0].includes("js_code=js-code-1"), "小程序用 js_code 参数");
    assert.equal(calls.length, 1, "小程序不该再调 sns/userinfo");
  });
  clearEnv();
});

test("真实通道（公众号）：access_token 后再取 sns/userinfo，昵称/头像落到 profile", async () => {
  realEnv();
  process.env.WECHAT_OAUTH = "1";
  await withFetch(
    [
      { openid: "o-web-1", access_token: "at-1", unionid: "u-2" },
      { nickname: "张女士", headimgurl: "http://thirdwx.qlogo.cn/mmopen/abc/0" },
    ],
    async (calls) => {
      const s = await wechatProviderFromEnv().exchange("web-code-1");
      assert.equal(s.channel, "oauth");
      assert.equal(s.openid, "o-web-1");
      assert.equal(s.profile.nickname, "张女士");
      assert.equal(s.profile.avatarUrl, "http://thirdwx.qlogo.cn/mmopen/abc/132", "头像统一取 132 尺寸");
      assert.ok(calls[0].includes("/sns/oauth2/access_token"), calls[0]);
      assert.ok(calls[1].includes("/sns/userinfo"), calls[1]);
    },
  );
  clearEnv();
});

test("真实通道（公众号）：WECHAT_USERINFO=0 时不取资料（少一次外部调用）", async () => {
  realEnv();
  process.env.WECHAT_OAUTH = "1";
  process.env.WECHAT_USERINFO = "0";
  await withFetch([{ openid: "o-web-2", access_token: "at-2" }], async (calls) => {
    const s = await wechatProviderFromEnv().exchange("web-code-2");
    assert.equal(s.openid, "o-web-2");
    assert.equal(s.profile, undefined);
    assert.equal(calls.length, 1);
  });
  clearEnv();
});

test("真实通道（公众号）：sns/userinfo 报错不影响登录（只当没有资料）", async () => {
  realEnv();
  process.env.WECHAT_OAUTH = "1";
  await withFetch(
    [
      { openid: "o-web-3", access_token: "at-3" },
      () => {
        throw new Error("network down");
      },
    ],
    async () => {
      const s = await wechatProviderFromEnv().exchange("web-code-3");
      assert.equal(s.openid, "o-web-3");
      assert.deepEqual(s.profile, {});
    },
  );
  clearEnv();
});

test("真实通道：微信返回错误码（无 openid）→ WECHAT_EXCHANGE_FAILED 且带 errcode", async () => {
  realEnv();
  await withFetch([{ errcode: 40029, errmsg: "invalid code" }], async () => {
    await assert.rejects(
      () => wechatProviderFromEnv().exchange("bad-code"),
      (e) => e.code === "WECHAT_EXCHANGE_FAILED" && e.errcode === 40029 && /invalid code/.test(e.message),
    );
  });
  clearEnv();
});

test("真实通道：空 code 抛 WECHAT_CODE_REQUIRED（不发起网络请求）", async () => {
  realEnv();
  await withFetch([], async (calls) => {
    await assert.rejects(() => wechatProviderFromEnv().exchange("  "), (e) => e.code === "WECHAT_CODE_REQUIRED");
    assert.equal(calls.length, 0);
  });
  clearEnv();
});
