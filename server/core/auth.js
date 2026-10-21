// 鉴权：scrypt 口令哈希 + 自签 HMAC Token（生产环境替换为 JWT 库 / OAuth2）
import crypto from "node:crypto";
import { get } from "./db.js";

const SECRET = process.env.AUTH_SECRET || "jiajiao-dev-secret-please-change-in-prod";
const TTL_SECONDS = 7 * 24 * 3600;

function b64u(input) {
  return Buffer.from(input).toString("base64url");
}

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(plain), salt, 32).toString("hex");
  return "scrypt$" + salt + "$" + hash;
}

export function verifyPassword(plain, stored) {
  if (!stored) return false;
  const [algo, salt, hash] = String(stored).split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const calc = crypto.scryptSync(String(plain), salt, 32);
  const target = Buffer.from(hash, "hex");
  if (calc.length !== target.length) return false;
  return crypto.timingSafeEqual(calc, target);
}

export function signToken(uid, role) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const body = b64u(JSON.stringify({ uid, role, exp }));
  const sig = crypto.createHmac("sha256", SECRET).update(head + "." + body).digest("base64url");
  return head + "." + body + "." + sig;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expect = crypto.createHmac("sha256", SECRET).update(head + "." + body).digest("base64url");
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

export function loadUser(id) {
  return get("SELECT * FROM users WHERE id = ?", id);
}

/** 生成验证码（演示环境直接返回，生产环境走短信网关） */
export function genSmsCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    phone: u.phone,
    nickname: u.nickname,
    avatar: u.avatar,
    role: u.role,
    status: u.status,
    realName: u.real_name,
    regionId: u.region_id,
    createdAt: u.created_at,
  };
}