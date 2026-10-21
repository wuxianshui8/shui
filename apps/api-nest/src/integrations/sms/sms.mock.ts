import { maskPhone } from "../../common/geo";
import type { SmsSender } from "./sms.port";

/**
 * 未接入真实短信通道时的实现：
 * - 不联网、不花钱，验证码只写进程日志（手机号脱敏）；
 * - 「是否回显验证码」由 auth.service 的 DEV_SMS / NODE_ENV 决定，与本实现无关，
 *   所以生产环境即使没配网关也不会把验证码泄露给调用方。
 * - outbox 仅用于测试断言，不落库、不进接口。
 */
export class MockSmsSender implements SmsSender {
  readonly name = "mock";
  readonly outbox: { phone: string; code: string; ttlSec: number; at: number }[] = [];

  async sendCode(phone: string, code: string, ttlSec: number): Promise<void> {
    this.outbox.push({ phone, code, ttlSec, at: Date.now() });
    if (this.outbox.length > 200) this.outbox.shift();
    console.warn("[sms:mock] 未配置真实短信通道，验证码只写日志：" + maskPhone(phone));
  }
}
