import crypto from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function randomCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function orderNo() {
  const d = new Date();
  const ymd =
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  return "JJ" + ymd + randomCode(8);
}

export function invoiceNo() {
  const d = new Date();
  const ymd =
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  return "FP" + ymd + randomCode(6);
}

export function tradeNo(prefix = "WX") {
  return prefix + Date.now().toString() + randomCode(6);
}

export function nowIso() {
  return new Date().toISOString();
}

export function addDaysIso(iso, days) {
  return new Date(new Date(iso).getTime() + days * 86400000).toISOString();
}

export function uid() {
  return crypto.randomUUID();
}