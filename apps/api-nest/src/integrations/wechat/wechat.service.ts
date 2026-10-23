import { createHash } from "node:crypto";

/**
 * 微信登录通道（端口化，和短信/支付/证件识别一样：配了密钥走真实通道，没配就走 mock）。
 *
 * 为什么端口化：门禁与本地容器常常没有微信 appid/secret，也不会去调腾讯接口；
 * 但「微信一键登录」这条链路必须能被端到端验证，所以策略是—
 *   - `WECHAT_APPID` + `WECHAT_SECRET` 都配了 → 调微信 `jscode2session` 换 openid（小程序）
 *     或 `sns/oauth2/access_token`（公众号/H5，用 `WECHAT_OAUTH=1` 切换）；
 *   - 没配 → mock：把 code 做 sha1 当 openid（同一 code 稳定映射到同一账号，便于复现与断言），
 *     并在启动日志里明确提示「微信登录=mock，上线必须配置」。
 *
 * 注意：mock 只影响「怎么把 code 换成 openid」，账号创建/登录逻辑与真实通道完全一致。
 */
export interface WechatSession {
  openid: string;
  /** 渠道：miniprogram（jscode2session）| oauth（公众号网页授权）| mock */
  channel: "miniprogram" | "oauth" | "mock";
}

export interface WechatProvider {
  name: "mock" | "wechat";
  exchange(code: string): Promise<WechatSession>;
}

const WEIXIN_API = "https://api.weixin.qq.com";

export function wechatProviderFromEnv(): WechatProvider {
  const appid = String(process.env.WECHAT_APPID || "").trim();
  const secret = String(process.env.WECHAT_SECRET || "").trim();
  const useOauth = process.env.WECHAT_OAUTH === "1";
  if (!appid && !secret) {
    return {
      name: "mock",
      async exchange(code: string) {
        const body = String(code || "").trim();
        if (!body) throw Object.assign(new Error("缺少微信登录 code"), { code: "WECHAT_CODE_REQUIRED" });
        // 同一个 code 永远映射到同一个 openid：门禁可以断言「二次登录还是同一个人」
        const openid = "mock_wx_" + createHash("sha1").update(body).digest("hex").slice(0, 24);
        return { openid, channel: "mock" as const };
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
      return { openid: String(openid), channel: useOauth ? ("oauth" as const) : ("miniprogram" as const) };
    },
  };
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
