import { maskPhone } from "../../common/geo";
import type { SmsSender } from "./sms.port";

/**
 * 未接入真实短信通道时的实现：
 * - 不联网、不花钱，验证码只写进程日志（手机号脱敏）；
 * - 「是否回显验证码」由 auth.service 的 DEV_SMS / NODE_ENV 决定，与本实现无关，
 *   所以生产环境即使没配网关也不会把验证码泄露给调用方；
 * - **测试环境专用开关** `SMS_MOCK_LOG_CODE=1`：把验证码也写进日志，供
 *   staging / 预发在没有短信网关时走完「发码 → 登录」全链路。
 *   默认关闭；生产（有真实网关或面向公网）**不要开**——日志里出现验证码等于验证码泄露。
 * - outbox 仅用于测试断言，不落库、不进接口。
 */
export class MockSmsSender implements SmsSender {
  readonly name = "mock";
  readonly outbox: { phone: string; code: string; ttlSec: number; at: number }[] = [];

  async sendCode(phone: string, code: string, ttlSec: number): Promise<void> {
    this.outbox.push({ phone, code, ttlSec, at: Date.now() });
    if (this.outbox.length > 200) this.outbox.shift();
    if (process.env.SMS_MOCK_LOG_CODE === "1") {
      // 仅测试环境：把码打到日志，便于 staging 联调（手机号仍脱敏）
      console.warn(
        `[sms:mock] 未配置真实短信通道（SMS_MOCK_LOG_CODE=1，仅限测试环境）验证码=${code} 手机号=` +
          maskPhone(phone) +
          ` 有效期=${ttlSec}s`,
      );
      return;
    }
    console.warn("[sms:mock] 未配置真实短信通道，验证码只写日志：" + maskPhone(phone));
  }
}
