/** 短信发送端口：验证码走这里，业务侧不关心是哪家网关 */
export interface SmsSender {
  /** 实现名（用于日志与门禁展示） */
  readonly name: string;
  /** 发送登录/注册验证码；失败必须抛错（调用方据此决定是否保留本次验证码） */
  sendCode(phone: string, code: string, ttlSec: number): Promise<void>;
}

/** 校验「看起来像真实配置」：占位串一律视为未配置，避免用模板值把真实通道跑成静默失败 */
export function looksPlaceholder(v: string | undefined): boolean {
  if (!v) return true;
  const s = String(v).trim().toLowerCase();
  if (!s) return true;
  return (
    s.includes("please-change") ||
    s.includes("changeme") ||
    s === "xxx" ||
    s === "your-key" ||
    s === "todo" ||
    /^<.*>$/.test(s)
  );
}
