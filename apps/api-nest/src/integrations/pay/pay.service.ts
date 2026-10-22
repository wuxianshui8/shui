import { MockPayProvider } from "./pay.mock";
import type { PayProvider } from "./pay.port";
import { WechatPayProvider, wechatConfigFromEnv } from "./pay.wechat";

let cached: { key: string; provider: PayProvider } | null = null;

/** 按 PAY_PROVIDER 选择实现：mock（默认）| wechat */
export function createPayProvider(env: NodeJS.ProcessEnv = process.env): PayProvider {
  const provider = String(env.PAY_PROVIDER || "mock").trim().toLowerCase();
  if (provider === "mock" || provider === "") return new MockPayProvider();
  if (provider === "wechat") return new WechatPayProvider(wechatConfigFromEnv(env));
  throw new Error("PAY_PROVIDER 只能是 mock / wechat（当前 " + provider + "）");
}

export function getPayProvider(): PayProvider {
  const key = String(process.env.PAY_PROVIDER || "mock").trim().toLowerCase();
  if (!cached || cached.key !== key) cached = { key, provider: createPayProvider(process.env) };
  return cached.provider;
}

/** 仅测试用 */
export function resetPayProviderForTest(): void {
  cached = null;
}

/** 展示用：当前生效的支付通道（配错时返回 invalid:xxx，便于启动日志定位） */
export function payProviderName(): string {
  try {
    return getPayProvider().name;
  } catch {
    return "invalid:" + String(process.env.PAY_PROVIDER || "mock");
  }
}
