import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";

function b64u(input: Buffer | string) {
  return Buffer.from(input as any).toString("base64url");
}

/**
 * 令牌声明：`{ uid, role, v, exp }`
 * - `v` 为账号的 token_version：改密 / 注销 / 重置口令时自增，使旧令牌立即失效（防「改密后旧令牌仍可用」）。
 */
export function signToken(uid: number, role: string, version = 0): string {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const exp = Math.floor(Date.now() / 1000) + config.tokenTtlSeconds;
  const body = b64u(JSON.stringify({ uid: Number(uid), role, v: Number(version) || 0, exp }));
  const sig = createHmac("sha256", config.authSecret).update(head + "." + body).digest("base64url");
  return head + "." + body + "." + sig;
}

export function verifyToken(token: string): { uid: number; role: string; v: number } | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expect = createHmac("sha256", config.authSecret).update(head + "." + body).digest("base64url");
  if (sig.length !== expect.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return { uid: Number(payload.uid), role: payload.role, v: Number(payload.v) || 0 };
  } catch {
    return null;
  }
}
