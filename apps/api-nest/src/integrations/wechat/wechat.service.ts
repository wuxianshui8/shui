import { createHash } from "node:crypto";

/**
 * 微信登录通道（端口化，和短信/支付/证件识别一样：配了密钥走真实通道，没配就走 mock）。
 *
 * 为什么端口化：门禁与本地容器常常没有微信 appid/secret，也不会去调腾讯接口；
 * 但「微信一键登录」这条链路必须能被端到端验证，所以策略是—
 *   - `WECHAT_APPID` + `WECHAT_SECRET` 都配了 → 调微信 `jscode2session` 换 openid（小程序）
 *     或 `sns/oauth2/access_token`（公众号/H5，用 `WECHAT_OAUTH=1` 切换），
 *     公众号渠道再调 `sns/userinfo` 取昵称与头像（`WECHAT_USERINFO=0` 可关）；
 *   - 没配 → mock：把 code 做 sha1 当 openid、并按同一哈希给出稳定昵称（同一 code 稳定映射到
 *     同一账号，便于复现与门禁断言），启动日志明确提示「微信登录=mock，上线必须配置」。
 *
 * 注意：mock 只影响「怎么把 code 换成 openid / 资料」，账号创建/登录逻辑与真实通道完全一致。
 */
export interface WechatSession {
  openid: string;
  /** 渠道：miniprogram（jscode2session）| oauth（公众号网页授权）| mock */
  channel: "miniprogram" | "oauth" | "mock";
  /** 跨端账号打通（公众号/小程序 unionid），小程序未绑定开放平台时为空 */
  unionid?: string;
  /** 公众号渠道拿到的资料（昵称/头像）；小程序渠道微信不提供，由前端 `getUserProfile` 补 */
  profile?: { nickname?: string; avatarUrl?: string };
}

export interface WechatProvider {
  name: "mock" | "wechat";
  exchange(code: string): Promise<WechatSession>;
}

const WEIXIN_API = "https://api.weixin.qq.com";
const OAUTH_AUTHORIZE = "https://open.weixin.qq.com/connect/oauth2/authorize";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** mock 账号昵称：同一 code 永远得到同一个 4 位尾号，门禁可断言「二次登录昵称不变」 */
export function mockNicknameOf(code: string): string {
  const n = (parseInt(sha1(String(code || "")).slice(0, 8), 16) % 9000) + 1000;
  return "微信用户" + n;
}

export function wechatProviderFromEnv(): WechatProvider {
  const appid = String(process.env.WECHAT_APPID || "").trim();
  const secret = String(process.env.WECHAT_SECRET || "").trim();
  const useOauth = process.env.WECHAT_OAUTH === "1";
  const fetchUserInfo = process.env.WECHAT_USERINFO !== "0";
  if (!appid && !secret) {
    return {
      name: "mock",
      async exchange(code: string) {
        const body = String(code || "").trim();
        if (!body) throw Object.assign(new Error("缺少微信登录 code"), { code: "WECHAT_CODE_REQUIRED" });
        // 同一个 code 永远映射到同一个 openid：门禁可以断言「二次登录还是同一个人」
        const openid = "mock_wx_" + sha1(body).slice(0, 24);
        return { openid, channel: "mock" as const, profile: { nickname: mockNicknameOf(body) } };
      },
    };
  }
  if (!appid || !secret) {
    // 只配一半 = 配置错误，直接拒绝启动（不静默降级成 mock）
    throw new Error("微信登录配置不完整：WECHAT_APPID 与 WECHAT_SECRET 必须同时配置");
  }
  return {
    name: "wechat",
    async exchange(code: string) {
      const c = String(code || "").trim();
      if (!c) throw Object.assign(new Error("缺少微信登录 code"), { code: "WECHAT_CODE_REQUIRED" });
      const url = useOauth
        ? WEIXIN_API + "/sns/oauth2/access_token?appid=" + encodeURIComponent(appid) +
          "&secret=" + encodeURIComponent(secret) + "&code=" + encodeURIComponent(c) + "&grant_type=authorization_code"
        : WEIXIN_API + "/sns/jscode2session?appid=" + encodeURIComponent(appid) +
          "&secret=" + encodeURIComponent(secret) + "&js_code=" + encodeURIComponent(c) + "&grant_type=authorization_code";
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data: any = await res.json().catch(() => ({}));
      const openid = data?.openid;
      if (!openid) {
        throw Object.assign(new Error("微信登录失败：" + (data?.errmsg || "未返回 openid")), {
          code: "WECHAT_EXCHANGE_FAILED",
          errcode: data?.errcode,
        });
      }
      const session: WechatSession = {
        openid: String(openid),
        channel: useOauth ? "oauth" : "miniprogram",
      };
      if (data?.unionid) session.unionid = String(data.unionid);
      // 公众号网页授权才有 access_token，可以再取一次昵称/头像；取不到不影响登录
      if (useOauth && fetchUserInfo && data?.access_token) {
        session.profile = await fetchOauthProfile(String(data.access_token), String(openid));
      }
      return session;
    },
  };
}

/** `sns/userinfo`：失败一律当作「没有资料」，不能因为昵称拉不到就登录不了 */
async function fetchOauthProfile(accessToken: string, openid: string) {
  try {
    const url =
      WEIXIN_API + "/sns/userinfo?access_token=" + encodeURIComponent(accessToken) +
      "&openid=" + encodeURIComponent(openid) + "&lang=zh_CN";
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data: any = await res.json().catch(() => ({}));
    const profile: { nickname?: string; avatarUrl?: string } = {};
    if (data?.nickname) profile.nickname = String(data.nickname).slice(0, 32);
    // 微信的头像 CDN 返回 132 尺寸；只存 URL，不落二进制
    if (data?.headimgurl) profile.avatarUrl = String(data.headimgurl).replace(/\/0$/, "/132");
    return profile;
  } catch {
    return {};
  }
}

/**
 * 公众号网页授权链接（`snsapi_userinfo`：能拿昵称与头像）。
 *
 * 为什么要服务端拼：redirect_uri 必须与公众号后台配置的「网页授权域名」一致，
 * 由服务端按白名单校验，避免前端传任意地址形成开放重定向。
 */
export function wechatAuthorizeUrl(appid: string, redirectUri: string, state = "", scope = "snsapi_userinfo"): string {
  const id = String(appid || "").trim();
  if (!id) throw Object.assign(new Error("未配置 WECHAT_APPID，无法发起公众号网页授权"), { code: "WECHAT_NOT_CONFIGURED" });
  const redirect = String(redirectUri || "").trim();
  if (!redirect) throw Object.assign(new Error("缺少 redirect_uri"), { code: "WECHAT_REDIRECT_REQUIRED" });
  return (
    OAUTH_AUTHORIZE +
    "?appid=" + encodeURIComponent(id) +
    "&redirect_uri=" + encodeURIComponent(redirect) +
    "&response_type=code&scope=" + encodeURIComponent(scope) +
    "&state=" + encodeURIComponent(String(state || "")) +
    "#wechat_redirect"
  );
}

/**
 * 授权回跳地址白名单：只允许配置里的 origin（默认只允许本站），
 * 防止有人把 /auth/wechat/authorize-url 当开放重定向用。
 */
export function assertRedirectAllowed(redirectUri: string, allowlist: string): string {
  const redirect = String(redirectUri || "").trim();
  if (!/^https?:\/\//i.test(redirect)) {
    throw Object.assign(new Error("redirect_uri 必须是 http(s) 绝对地址"), { code: "WECHAT_REDIRECT_INVALID" });
  }
  const allow = String(allowlist || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allow.length) {
    throw Object.assign(new Error("未配置 WECHAT_OAUTH_REDIRECT_ALLOWLIST，拒绝生成授权链接"), {
      code: "WECHAT_REDIRECT_NOT_ALLOWED",
    });
  }
  const origin = new URL(redirect).origin.toLowerCase();
  const ok = allow.some((entry) => origin === entry || origin === "https://" + entry || origin === "http://" + entry);
  if (!ok) {
    throw Object.assign(new Error("redirect_uri 不在白名单内：" + origin), { code: "WECHAT_REDIRECT_NOT_ALLOWED" });
  }
  return redirect;
}

let cached: { key: string; provider: WechatProvider } | null = null;

/** 进程内单例（按 appid/secret/oauth 组合缓存；配置变化后需重启进程） */
export function getWechatProvider(): WechatProvider {
  const key = [process.env.WECHAT_APPID || "", process.env.WECHAT_SECRET || "", process.env.WECHAT_OAUTH || ""]
    .map((s) => String(s).trim())
    .join("|");
  if (!cached || cached.key !== key) cached = { key, provider: wechatProviderFromEnv() };
  return cached.provider;
}

/** 仅测试用：清掉单例，便于同一进程内切换通道 */
export function resetWechatProviderForTest(): void {
  cached = null;
}

/** 展示用：当前生效的通道名（配置非法时返回 invalid:…，便于启动自检日志定位） */
export function wechatProviderName(): string {
  try {
    return getWechatProvider().name;
  } catch {
    return "invalid";
  }
}

/** 展示用：是否已配置公众号网页授权（前端据此决定「微信一键登录」走跳转还是演示 code） */
export function wechatOauthReady(): boolean {
  return String(process.env.WECHAT_APPID || "").trim() !== "" && process.env.WECHAT_OAUTH === "1";
}
