import { MockSmsSender } from "./sms.mock";
import type { SmsSender } from "./sms.port";
import { TencentSmsSender, tencentSmsConfigFromEnv } from "./sms.tencent";

let cached: { key: string; sender: SmsSender } | null = null;

/** 按 SMS_PROVIDER 选择实现：mock（默认）| tencent */
export function createSmsSender(env: NodeJS.ProcessEnv = process.env): SmsSender {
  const provider = String(env.SMS_PROVIDER || "mock").trim().toLowerCase();
  if (provider === "mock" || provider === "") return new MockSmsSender();
  if (provider === "tencent") return new TencentSmsSender(tencentSmsConfigFromEnv(env));
  throw new Error("SMS_PROVIDER 只能是 mock / tencent（当前 " + provider + "）");
}

/** 进程内单例（按 provider 串缓存；配置变化后需重启进程） */
export function getSmsSender(): SmsSender {
  const key = String(process.env.SMS_PROVIDER || "mock").trim().toLowerCase();
  if (!cached || cached.key !== key) cached = { key, sender: createSmsSender(process.env) };
  return cached.sender;
}

/** 仅测试用：清掉单例，便于同一进程内切换 provider */
export function resetSmsSenderForTest(): void {
  cached = null;
}

/** 展示用：当前生效的通道名（未知配置时返回配置原值，便于日志定位） */
export function smsProviderName(): string {
  try {
    return getSmsSender().name;
  } catch {
    return "invalid:" + String(process.env.SMS_PROVIDER || "mock");
  }
}
