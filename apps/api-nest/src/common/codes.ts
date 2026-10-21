import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 与参考实现 core/ids.js 一致的随机短码（去掉易混淆字符） */
export function randomCode(len = 6): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** 演示环境初始密码（与需求书演示账号一致） */
export const DEMO_PASSWORD = "a123456";

/**
 * 一次性初始口令（后台开通代理/业务员时使用）：12 位，含大小写、数字与符号，
 * 满足「≥8 位且含字母与数字」的改密策略；账号置 must_change_password=1，首登强制修改。
 */
export function randomPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const pick = (set: string, n: number) => {
    const bytes = randomBytes(n);
    let out = "";
    for (let i = 0; i < n; i++) out += set[bytes[i] % set.length];
    return out;
  };
  return (pick(upper, 3) + pick(lower, 4) + pick(digits, 3) + pick("!@#$%&*", 2))
    .split("")
    .map((c) => ({ c, k: randomBytes(1)[0] }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.c)
    .join("");
}
