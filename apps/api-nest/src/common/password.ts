import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** 与既有实现一致的 scrypt 口令格式：scrypt$salt$hash */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(plain), salt, 32).toString("hex");
  return "scrypt$" + salt + "$" + hash;
}

export function verifyPassword(plain: string, stored: string): boolean {
  if (!stored) return false;
  const [algo, salt, hash] = String(stored).split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const calc = scryptSync(String(plain), salt, 32);
  const target = Buffer.from(hash, "hex");
  if (calc.length !== target.length) return false;
  return timingSafeEqual(calc, target);
}